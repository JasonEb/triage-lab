# Troubleshooting agent

`pnpm triage ask` answers an incident question from one simulated incident's logs, and cites the log lines it relied on. It is read-only: every tool is a SELECT over a local SQLite store.

```bash
pnpm sim --scenario=1                                   # generate logs (both styles)
cp .env.example .env                                    # then set TRIAGE_ANTHROPIC_API_KEY
pnpm triage ask "rx refills are failing since 2pm" --scenario=1 --verbose
pnpm triage ask "rx refills are failing since 2pm" --scenario=1 --style=legacy --json
```

## Pieces

```
logs/scenario-n/<style>/*  ──ingest──▶  @triage/store (SQLite + FTS5, in memory)
logs/scenario-n/deploys.jsonl ─────────▶      │ read-only queries
                                              ▼
              @triage/agent: tool loop ──redact──▶ Claude (Messages API) ──▶ submit_diagnosis
                                              │
                               evidence check ▼
                                   pnpm triage ask (prints diagnosis + cited lines)
```

### Store (`@triage/store`)

- One incident per store: a style's logs plus `deploys.jsonl`. `ground-truth.json` is never read.
- Columns: `ts`, `service`, `level`, `event`, `correlation_id`, `request_id`, `error_type`, `error_code`, `fingerprint`, `pattern`, `text`. Indexes on time, service, event, correlation and request IDs, and fingerprint, plus an FTS5 index on `text`.
- **Fingerprint** = hash of event + error type + normalized message (IDs, numbers, emails, phones and timestamps replaced). Repeated errors collapse into one cluster, so the model reads 15 clusters instead of 5,000 lines. That is the main cost control.
- **Legacy parsing** is best-effort and format-driven: five timestamp shapes (ISO, bracketed, epoch ms, ad-hoc JSON with RFC 1123 dates, minute-precision prefix lines), levels, Lambda request IDs, and stack traces kept with their entry. Legacy rows have no event, correlation ID or error type, because the logs don't carry them.
- FTS input is quoted term by term, so a query can't inject FTS syntax.

### Tools

| Tool                                                                  | What it answers                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `search_logs({query?, service?, level?, event?, from?, to?, limit?})` | Which lines match? (full text plus filters, total count) |
| `get_trace({correlationId? \| requestId?})`                           | What happened to this one request, across services?      |
| `error_clusters({from?, to?, service?})`                              | What is failing, how often, and since when?              |
| `timeline({from?, to?, service?, level?, bucketMinutes?})`            | What changed over time, including what **stopped**?      |
| `recent_deploys({from?, to?, service?})`                              | What shipped around the start?                           |
| `get_runbook({topic})`                                                | What does the runbook say? (`docs/runbooks/`)            |
| `submit_diagnosis(...)`                                               | The final answer (strict schema)                         |

`timeline` is not in PLAN.md's tool list. It is there because scenario 6 has no errors at all: the only signal is a pattern whose count drops to zero, and neither search nor error clusters can show an absence.

### Loop (`@triage/agent`)

A manual Messages API loop, not the SDK's beta tool runner, so that four things are explicit and testable without the API:

1. **Budgets.** At most `TRIAGE_MAX_STEPS` model calls (default 15) and `TRIAGE_MAX_TOKENS` total tokens (default 500k, counting cache reads and writes). On the last call the model is told to submit what it has. Running out returns `insufficient_data`, not a guess.
2. **Redaction at the boundary.** Every free-text field in every tool result goes through `redactText` before the model sees it. That covers pattern rules (emails, phones, dates, cards, tokens), the platform's ID formats (`pt_\d{5}`), and a name dictionary (here the synthetic name list; in production, the patient directory). Timestamps, IDs and enums are structural and stay intact. A test runs every tool over legacy logs and asserts that no patient ID, name, email or phone number gets through; a control test shows the data is there before redaction.
3. **Evidence check.** The loop records every line ID a tool showed the model. Citations of any other ID are dropped with a warning, and a diagnosis left with no valid evidence is lowered to `low` confidence.
4. **Final answer through a strict tool.** `submit_diagnosis` has `strict: true`, so the arguments always match the schema, and they are validated again with Zod. Current models reject forced `tool_choice`, so the prompt asks for the call, and a turn that ends without one gets a nudge.

Request settings: model from `TRIAGE_MODEL` (default `claude-sonnet-5-5`, per PLAN.md); adaptive thinking (the model default); `effort: medium` (`TRIAGE_EFFORT`); prompt caching on the stable prefix (system prompt and tools; the per-run data summary goes in the first user message); full assistant content appended back, so the history is append-only and thinking blocks are preserved; and server-side refusal fallbacks (`fallbacks: "default"`) on models that support them.

Answer shape:

```json
{
  "summary": "...",
  "suspectedRootCause": {
    "category": "dependency | timeout | auth | data | validation | unknown | insufficient_data",
    "service": "rx",
    "description": "..."
  },
  "evidence": [{ "lineId": 1234, "reason": "..." }],
  "confidence": "low | medium | high",
  "suggestedNextSteps": ["..."],
  "runbook": "dependency-outage"
}
```

## Why not Managed Agents?

Anthropic's hosted agent runtime would remove the loop code, but here the tools query a local database, the redaction point and the budgets must be under our control, and the healthcare setting matters (Managed Agents is not currently eligible for HIPAA BAA coverage). The self-hosted loop is one file of about 300 lines, covered by tests that need no API key.

## Limits

- Name redaction depends on a dictionary. A name that isn't in it, in free text, would get through. Structured logging (hashed IDs, no names) is the primary control; redaction is the safety net.
- The store is rebuilt in memory on every `ask` (about a second). Fine for one incident, not for a real log volume.
- One model call at a time; no parallel investigation threads.
