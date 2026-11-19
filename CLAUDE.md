# CLAUDE.md: Triage Lab

Portfolio prototype for a Honeydew (virtual dermatology platform) Senior Software Engineer, Backend/Platform application. `PLAN.md` is the source of truth for scope, phases, and "done when" criteria. Read it before starting any phase.

## What this project demonstrates
1. A logging standard built for AI-supported troubleshooting (the listing's day-60 goal).
2. A read-only troubleshooting agent that diagnoses incidents from logs and cites evidence.
3. An eval showing structured logs improve the agent's accuracy versus legacy logs.
4. Optional: a dependency-vulnerability PR agent that runs in dry-run mode (day 61-180 goal).

## Hard rules
- **Synthetic data only.** Never use or generate real PHI/PII. Patient identifiers in logs are hashed. Redact before any text reaches an LLM.
- **Agent is read-only.** Troubleshooting tools never mutate anything. The PR agent only runs against local fixtures or `--dry-run`, never merges, and only runs allowlisted commands.
- **Never commit secrets.** `ANTHROPIC_API_KEY` lives in a git-ignored `.env`. Keep `.env.example` up to date.
- **One phase at a time.** Stop at the phase's "Done when" criteria, then summarize what you built, what you verified, and what's next. Do not start the next phase.
- **Small commits.** Commit logical steps with clear messages.
- **Tests are required.** Write tests first where practical (Vitest). Don't mark a phase done with failing or missing tests.

## Stack
- TypeScript (strict) on Node 20, pnpm workspaces.
- Vitest for tests; ESLint + Prettier; GitHub Actions for CI (lint + test).
- Lambda-style handlers `(event, context) => ...` to mirror the target stack (API Gateway, SQS, EventBridge events), simulated locally. No AWS account or real AWS calls.
- SQLite (FTS5) for the local log store. OpenSearch/Docker is an optional stretch only.
- Claude API via the official Anthropic SDK; model name comes from env config, not hard-coded.

## Layout
```
packages/logger/   logging standard: schema, redaction, withLogging wrapper
packages/sim/      fake services + fault-injection scenarios (structured + legacy output)
packages/store/    ingest + query layer over SQLite
packages/agent/    tool-using troubleshooting agent
packages/evals/    scenarios, scoring, report generation
apps/cli/          `triage` command
docs/              logging-standard.md, eval-report.md, runbooks/
fixtures/          vulnerable sample app for the optional PR agent
```

## Conventions
- Validate log lines with Zod. Event names are stable and machine-readable (`rx.refill.failed`). Error types come from the documented taxonomy.
- Keep log field cardinality bounded; no free-form data in indexed fields.
- Agent answers must cite log line IDs and may say "insufficient data".
- Simulations and evals are deterministic (seeded). Repeat LLM eval runs and report mean and spread.
- Prefer small, explainable designs over clever ones. The author must be able to defend each decision in an interview.
- Update the README at the end of each phase.

## Commands (keep these working; update here if they change)
- `pnpm install`
- `pnpm test`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm triage lint-logs <file.jsonl> [--json] [--min-percent=<n>]`
- `pnpm sim --scenario=<n|all> [--style=structured|legacy] [--seed=<n>] [--out=<dir>]` (writes to `logs/`, git-ignored; `--list` shows scenarios)
- `pnpm triage ask "<question>" --scenario=<n> [--style=structured|legacy] [--verbose] [--json]` (needs `ANTHROPIC_API_KEY` in `.env`; run `pnpm sim` first)
- `pnpm evals`
