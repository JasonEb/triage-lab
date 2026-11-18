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

## Getting started

Requires Node 20+ (see `.nvmrc`) and pnpm 10.

```bash
pnpm install
pnpm lint        # ESLint + Prettier check
pnpm typecheck   # tsc, strict
pnpm test        # Vitest
```

Copy `.env.example` to `.env` when the agent arrives in Phase 3.
