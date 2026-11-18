# Honeydew Prototype: "Triage Lab" (AI-supported troubleshooting on standardized logs)

## Why this project

The Honeydew Platform Engineer listing sets a day-60 goal: *"Standardize and optimize our logging for AI-supported troubleshooting across the platform."*
The prototype demonstrates that goal end to end, and proves one claim with data:

> Standardized, structured logs make an AI troubleshooter measurably better than raw, ad-hoc logs.

That gives the application a concrete artifact, a measurable result, and a story that maps directly to the role.

## Context to keep in mind

- Honeydew (Honeydew Health) is a virtual dermatology platform (acne, eczema, psoriasis; Rx workflows). Not the honeydew.ai semantic-layer company.
- Role (confirmed from listing text): Senior Software Engineer - Backend (Platform), remote, full time. Two stated goals: **day 60** standardize logging for AI-supported troubleshooting; **day 61-180** processes and infrastructure for AI agents to autonomously open PRs resolving dependency vulnerabilities. Nice-to-haves: healthcare/regulated domain, building custom agents, TypeScript/AWS/serverless/PostgreSQL.
- Confirmed stack: TypeScript + Python + SQL; Node.js on AWS Lambda; GraphQL (AppSync/Apollo) and REST (API Gateway); EventBridge/SQS/SNS; Cognito; PostgreSQL (RDS), DynamoDB, OpenSearch, S3; AWS multi-account (Control Tower, CloudFormation, IAM, SSM, CloudWatch, CloudTrail), Terraform, Serverless Framework, Docker, LocalStack; CI on Bitbucket Pipelines + GitHub Actions; OpenAI + Anthropic APIs; Vitest/Jest/Playwright.
- Healthcare: **synthetic data only, no real PHI, ever.** Redaction before any log reaches an LLM is a first-class feature (and a good interview talking point).
- Language: TypeScript on Node 20. (Matches their stack; good TypeScript practice.)

## Scope guardrails

- Time-box: roughly 5 to 8 focused sessions. Each phase ends in a working, committed state.
- No AWS account needed. Everything runs locally (Docker optional).
- Read-only agent. It diagnoses and suggests; it never changes anything.
- Keep it small. A clear README and eval results beat feature count.

## Architecture (target end state)

```
 fake services (intake, rx, scheduling, billing, notifications)
        | structured JSON logs via @triage/logger
        v
   logs/*.jsonl  --ingest-->  SQLite (FTS5)  <--tools--  Troubleshooting agent (Claude API)
                                                      |
                                    CLI: `triage ask "why are Rx refills failing?"`
                                                      |
                                    Eval harness: scenarios + ground truth + scoring
```

Monorepo (pnpm workspaces):

```
triage-lab/
  packages/logger/      # the logging standard (schema, redaction, Lambda-style wrapper)
  packages/sim/         # fake services + fault injection scenarios
  packages/store/       # ingest + query layer over SQLite
  packages/agent/       # tool-using troubleshooting agent
  packages/evals/       # scenarios, scoring, report
  apps/cli/             # `triage` command
  docs/                 # logging-standard.md, eval-report.md
```

---

## Phase 0: Scaffold (30-60 min)

**Goal:** empty but green repo.

- pnpm workspace, TypeScript strict, Vitest, ESLint/Prettier, GitHub Actions running lint + test.
- `CLAUDE.md` at the root with the rules above (synthetic data only, read-only agent, small steps, tests required).

**Done when:** `pnpm test` passes on a trivial test and CI is green.

## Phase 1: The logging standard (the heart of the listing)

**Goal:** one logger every service uses, with a schema you can defend.

Build `@triage/logger`:
- Zod schema for every log line. Required fields: `ts`, `level`, `service`, `env`, `event` (stable machine name like `rx.refill.failed`), `msg`, `requestId`, `correlationId` (propagated across services), `durationMs?`, `error?{type,message,stack,code}`, `ctx?` (small, typed key-value bag).
- Identifiers hashed: `patientIdHash`, never raw IDs.
- **Redaction layer:** strips/masks emails, phone numbers, names in free text, DOB, medication names in free-text fields (configurable). Unit-test it hard.
- Lambda-style wrapper `withLogging(handler)`: generates/propagates correlation IDs, logs start/end/duration, catches and logs errors in the standard shape.
- Event naming convention + error taxonomy (`validation`, `dependency`, `timeout`, `auth`, `data`, `unknown`) documented in `docs/logging-standard.md`.
- A **log linter** (`triage lint-logs file.jsonl`) that reports % of lines compliant with the schema, by service.

**Done when:** tests cover schema, redaction, and the wrapper; the doc explains each field and *why* it helps an AI (stable event names, correlation IDs, typed errors, bounded cardinality).

## Phase 2: Simulated platform + fault injection

**Goal:** realistic incident data with known root causes.

Build `@triage/sim`:
- 5 tiny fake services: `intake`, `rx`, `scheduling`, `billing`, `notifications`, producing normal traffic with believable volume and latency. Model them like their stack: Lambda-style handlers (`(event, context) => ...`) triggered by simulated API Gateway, SQS, and EventBridge events, so the correlation ID has to survive async hops (this is where real logging standards usually break).
- Scenario library, each with a **ground-truth root cause** recorded in a manifest:
  1. Pharmacy partner API returns 5xx (dependency)
  2. DB connection pool exhaustion after a traffic spike (timeout)
  3. Bad deploy: schema/field rename breaks `rx` payload parsing (data/deploy)
  4. Expired auth token for the lab-results integration (auth)
  5. DynamoDB throttling on a hot partition (dependency/capacity)
  6. Notification provider silently dropping messages (no errors, only missing downstream events: the hard one)
- Each scenario emits two versions of the same incident: **structured** (via `@triage/logger`) and **legacy** (messy `console.log` strings, inconsistent formats, no correlation ID). This pairing powers Phase 4.
- Deterministic seeds so runs are reproducible.

**Done when:** `pnpm sim --scenario=3 --style=structured|legacy` writes JSONL/text logs plus a deploy-events file.

## Phase 3: Store + agent

**Goal:** an agent that investigates like an on-call engineer.

`@triage/store`: ingest JSONL into SQLite with FTS5; indexes on `ts`, `service`, `event`, `correlationId`. Include an error **fingerprint** (hash of event + error type + normalized message) so repeated errors collapse into clusters.

`@triage/agent` with Claude API tool use (model configurable via env, default to a current Sonnet). Tools, all read-only:
- `search_logs({query, service?, level?, from?, to?})`
- `get_trace({correlationId})`: all lines across services for one request
- `error_clusters({from, to})`: top fingerprints with counts and first/last seen
- `recent_deploys({from, to})`
- `get_runbook({topic})`: a few markdown runbooks in `docs/runbooks/`

Agent behavior:
- Loop with a max-step and max-token budget; cite evidence by log line ID.
- Redaction runs again on tool output before it reaches the model.
- Structured final answer: `{ summary, suspectedRootCause, evidence[], confidence, suggestedNextSteps[], runbook? }`.
- Never claim certainty without evidence; "insufficient data" is an allowed answer.

**Done when:** `triage ask "rx refills are failing since 2pm"` on a simulated scenario returns a cited diagnosis.

## Phase 4: Evals (the payoff)

**Goal:** a number you can put in the README.

`@triage/evals`:
- For each scenario x {structured, legacy}: run the agent, compare to ground truth.
- Scoring: root-cause category correct (0/1), culprit service correct (0/1), evidence cites a relevant log line (0/1), steps used, tokens used, wall time. Optionally LLM-as-judge for the free-text cause, with the rubric stored in the repo.
- Run each case several times (nondeterminism) and report mean + spread.
- Output `docs/eval-report.md` with a table and a short analysis, including honest failures (scenario 6 is likely to struggle).

**Done when:** one command regenerates the report. Expected finding: structured logs improve accuracy and cut tokens/steps. If they don't, write up why. That is still a strong result.

## Phase 5 (optional, high-signal): Dependency-vulnerability PR agent

The listing's day 61-180 goal. A small, safe version shows you've read the whole role.

- Input: a sample Node/TypeScript repo in `fixtures/` with a deliberately vulnerable dependency (use `npm audit --json` output; keep a recorded fixture so it runs offline).
- Agent steps: read audit report, pick one fixable advisory, bump the version on a branch, run the fixture's tests, and if they pass produce a PR title/body (advisory, version change, test result, risk notes). If tests fail, stop and report instead.
- Guardrails: opens PRs only against a local fixture repo or `--dry-run` (writes the PR as markdown); never merges; never touches secrets; allowlisted commands only; human review required. Log every agent action with `@triage/logger` so the same troubleshooting agent can explain what it did.
- Done when: `triage fix-deps fixtures/vulnerable-app --dry-run` produces a branch diff plus PR description, and a test covers the "tests fail, so no PR" path.

## Phase 6: Polish and story (half a day)

- README: problem, the logging standard in 10 lines, architecture diagram, eval table, how to run, what you'd do next at Honeydew scale.
- "What I'd do next on the real platform" section: CloudWatch Logs subscription filters to OpenSearch, Terraform module for log groups and retention, sampling and cost controls, PHI-safe log pipeline review with compliance, feedback loop from on-call engineers, a tiered model strategy (cheap triage, bigger model for hard cases).
- 2-minute screen recording of `triage ask` on a scenario.
- Optional stretch: thin web UI, OpenSearch via docker-compose instead of SQLite, AWS Lambda Powertools-style adapter for the logger.

---

## Handoff: how to run this with Claude on your local machine

1. Create the repo, drop this file in as `PLAN.md`, and start Claude Code in it.
2. First prompt:
   > Read PLAN.md. Create a CLAUDE.md capturing the context and guardrails, then do Phase 0 only. Stop when it's done and summarize what you built and what's next.
3. For each phase after that:
   > Do Phase N from PLAN.md. Write tests first where practical. Commit in small steps. Stop at the "Done when" criteria and tell me what you verified.
4. Review each phase's diff before starting the next. You own the design decisions, so be ready to explain them in interviews.

## Optional: Claude Project setup (planning and review companion)

Use a Claude Project alongside Claude Code. Claude Code builds in your local repo; the Project is the place for design questions, reviewing diffs, writing up evals, and interview prep.

1. Create a Project named "Honeydew: Triage Lab".
2. Upload to project knowledge: `PLAN.md`, the Honeydew listing text, and later `docs/logging-standard.md` and `docs/eval-report.md`.
3. Paste these as project instructions:

```
You are my planning and review partner for "Triage Lab", a portfolio prototype for the Honeydew Senior Software Engineer (Backend/Platform) application. PLAN.md in project knowledge is the source of truth for scope, phases, and guardrails.

Rules:
- All data is synthetic. Never suggest using real PHI.
- Stay within the current phase unless I say otherwise. Flag scope creep.
- When I paste a diff or file, review it against the "Done when" criteria for that phase and call out bugs, security issues, and missing tests.
- Prefer small, explainable designs. I need to defend every decision in an interview.
- Stack is TypeScript on Node 20 (Lambda-style handlers), Vitest, SQLite locally.
- Tell me when something in the plan is wrong or should change, and suggest the edit to PLAN.md.
```

4. After each phase, paste the summary Claude Code gives you into a Project chat and ask: "Review this against Phase N's done-when. What's weak?"
5. Keep PLAN.md in the repo and in the Project in sync. Re-upload after edits.

## Talking points for the application and interviews

- Why event names, correlation IDs, and typed errors matter to both humans and models.
- Redaction and PHI handling as a design constraint, not an afterthought.
- Eval-driven development for LLM features: what you measured and what failed.
- Cost and latency controls: clustering and fingerprinting before prompting.
- Mapping to the listing: logging standard = day-60 goal; PR agent = day 61-180 goal; synthetic-data and redaction work = healthcare/regulated nice-to-have; the agents themselves = "building custom agents" nice-to-have; the eval write-up = "write things down so the next engineer can rely on them".
- Honest gap: coming from Rails, this is your TypeScript/serverless-flavored work, so say so and show the ramp.
