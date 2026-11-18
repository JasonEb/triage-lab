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

## Getting started

Requires Node 20+ (see `.nvmrc`) and pnpm 10.

```bash
pnpm install
pnpm lint        # ESLint + Prettier check
pnpm typecheck   # tsc, strict
pnpm test        # Vitest
pnpm triage lint-logs <file.jsonl>   # logging-standard compliance report
```

Copy `.env.example` to `.env` when the agent arrives in Phase 3.
