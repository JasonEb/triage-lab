# Triage Lab

A prototype showing that **standardized, structured logs make an AI troubleshooter measurably better** than raw, ad-hoc logs. Uses synthetic data only; no real PHI.

See [`PLAN.md`](PLAN.md) for scope and phases, and [`CLAUDE.md`](CLAUDE.md) for guardrails.

## Status

| Phase | What                                   | State    |
| ----- | -------------------------------------- | -------- |
| 0     | Scaffold (pnpm, TS strict, Vitest, CI) | Done     |
| 1     | Logging standard (`@triage/logger`)    | Next     |
| 2     | Simulated platform + fault injection   | Planned  |
| 3     | Log store + troubleshooting agent      | Planned  |
| 4     | Evals: structured vs. legacy logs      | Planned  |
| 5     | Dependency-vulnerability PR agent      | Optional |
| 6     | Polish and write-up                    | Planned  |

## The logging standard in brief

Full spec: [`docs/logging-standard.md`](docs/logging-standard.md).

1. One JSON object per line, validated by a Zod schema (`@triage/logger`).
2. Required: `ts`, `level`, `service`, `env`, `event`, `msg`, `requestId`, `correlationId`.
3. `event` is a stable machine name (`rx.refill.failed`), never prose and never data.
4. Errors are typed: `validation`, `dependency`, `timeout`, `auth`, `data` or `unknown`, plus a stable `code`.
5. `correlationId` survives every hop: HTTP header, SQS attribute, EventBridge detail.
6. Patients appear only as `patientIdHash` (keyed HMAC). Raw IDs are hashed by the logger.
7. Free text is redacted (emails, phones, dates, names, medications, tokens...) before it's written.
8. Indexed fields have bounded cardinality; specifics go in a small, flat `ctx`.
9. `withLogging(handler)` logs start/end/duration/errors for Lambda-style handlers.
10. `triage lint-logs` measures compliance per service and can gate CI.

## The simulated platform

Full description: [`docs/simulated-platform.md`](docs/simulated-platform.md).

Five Lambda-style services (`intake`, `rx`, `scheduling`, `billing`, `notifications`) exchange simulated API Gateway, SQS and EventBridge events in virtual time. Six seeded fault scenarios each have a ground-truth root cause:

| #   | Scenario                                         | Category   | Culprit       |
| --- | ------------------------------------------------ | ---------- | ------------- |
| 1   | Pharmacy partner returns 5xx                     | dependency | rx            |
| 2   | DB pool exhaustion after a traffic spike         | timeout    | scheduling    |
| 3   | Bad deploy renames payload fields                | data       | rx            |
| 4   | Expired lab-results token                        | auth       | rx            |
| 5   | DynamoDB hot partition throttling                | dependency | rx            |
| 6   | SMS provider silently drops messages (no errors) | dependency | notifications |

Each run is recorded once and rendered twice: **structured** (through `@triage/logger`, 100% compliant) and **legacy** (inconsistent per-service formats, no correlation IDs, 0% compliant). Both styles describe the identical incident, so log format is the only variable in the eval.

## The troubleshooting agent

Full description: [`docs/troubleshooting-agent.md`](docs/troubleshooting-agent.md).

`pnpm triage ask "<question>" --scenario=<n>` loads one incident's logs into SQLite (FTS5, fingerprinted error clusters) and runs a read-only Claude tool loop with six tools: `search_logs`, `get_trace`, `error_clusters`, `timeline`, `recent_deploys` and `get_runbook`. It answers with a structured diagnosis that cites log line IDs.

- **Read-only:** every tool is a SELECT.
- **PHI-safe:** every tool result is redacted before it reaches the model, and a test checks that no synthetic patient data gets through.
- **Bounded:** step and token budgets; running out gives `insufficient_data`, not a guess.
- **Honest citations:** evidence the model never saw is dropped, and an answer without evidence is marked low confidence.

## Getting started

Requires Node 20+ (see `.nvmrc`) and pnpm 10.

```bash
pnpm install
pnpm lint        # ESLint + Prettier check
pnpm typecheck   # tsc, strict
pnpm test        # Vitest
pnpm triage lint-logs <file.jsonl>   # logging-standard compliance report
pnpm sim --list                      # fault scenarios
pnpm sim --scenario=3                # writes logs/scenario-3-.../{structured,legacy}/
cp .env.example .env                 # set TRIAGE_ANTHROPIC_API_KEY
pnpm triage ask "Refills stopped going through around 14:00" --scenario=3 --verbose
```
