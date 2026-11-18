# Simulated platform

`@triage/sim` generates realistic incident logs with known root causes. It is the test bed for the troubleshooting agent (Phase 3) and the structured vs. legacy eval (Phase 4). All data is synthetic.

```bash
pnpm sim --list
pnpm sim --scenario=3                      # both styles
pnpm sim --scenario=3 --style=legacy       # one style
pnpm sim --scenario=all --seed=42 --out=/tmp/logs
```

Output, under `logs/scenario-<n>-<slug>/`:

| File                         | Contents                                                    | Agent sees it?          |
| ---------------------------- | ----------------------------------------------------------- | ----------------------- |
| `structured/<service>.jsonl` | Logs written through `@triage/logger`                       | yes (structured runs)   |
| `legacy/<service>.log`       | The same events, ad-hoc formats                             | yes (legacy runs)       |
| `deploys.jsonl`              | Deploy events (time, service, version, commit, description) | yes                     |
| `ground-truth.json`          | Question, root cause, category, culprit, evidence           | **no**, only the scorer |

## Design in five decisions

1. **One run, two renderings.** The simulation runs once and records abstract log events. Those records are then rendered twice: through `@triage/logger` (structured) and through per-service legacy formatters. Both styles describe the identical incident, request for request, so in the Phase 4 eval **log format is the only variable**.
2. **Discrete-event simulation in virtual time.** A two-hour incident simulates in well under a second. Handlers are real `(event, context) => Promise` Lambda-style functions wrapped in `withLogging`; `sim.sleep(ms)` advances a virtual clock. Every random choice comes from one seeded RNG, so a seed gives byte-identical output.
3. **Async hops are real hops.** Requests arrive as API Gateway events, flow through SQS and EventBridge, and come back as provider webhooks. Each boundary carries the correlation ID the way production code would (header, message attribute, `detail` field). SQS redelivers failed messages and dead-letters after three receives; EventBridge async invocations retry twice. Retries change the shape of an incident, so they are modeled.
4. **Capacity faults emerge from load.** The Postgres pool is a FIFO queue over N connections with a connect timeout, and the DynamoDB partition is a token bucket. Scenarios 2 and 5 don't set an error rate; they add load, and timeouts and throttling follow. Capacities are scaled down (pool of 2, 0.5 writes/s per partition) to match the scaled-down traffic.
5. **The baseline is not clean.** Healthy traffic includes about 1.5% rejected intake forms, 1% refill requests with no active prescription, occasional pharmacy 503s that succeed on retry, card declines, rare payment timeouts and failed deliveries. Three benign deploys happen in every scenario, one of them after the fault starts. The agent has to tell new failures from background noise, and can't just blame the most recent deploy.

## Services and flows

```
patient ─POST /intake─▶ intake ──EB IntakeSubmitted──▶ scheduling ──EB AppointmentBooked──┬─▶ billing
                                                        (Postgres pool)                    └─▶ notifications ─▶ provider
patient ─POST /refills─▶ rx (api) ──SQS refill-requests──▶ rx (worker) ──EB RefillSubmitted──┬─▶ billing
                                    labs ─┘ DynamoDB ─┘ pharmacy ─┘                          └─▶ notifications ─▶ provider
EB Scheduled Event (auto-refill job) ─▶ rx ──SQS──▶ rx (worker)
provider ─POST /webhooks/delivery─▶ notifications            (delivery receipt, carries the correlation ID)
```

Traffic: Poisson arrivals, 2 intake forms and 3 refill requests per minute at baseline, over 13:00–15:00 UTC on 2026-11-18. Every fault starts at 14:00. About 70% of clients send a correlation ID; the rest get one generated at the edge.

## Scenarios

| #   | Slug                     | Question asked                                                          | Category   | Culprit       | Trigger                                                                       |
| --- | ------------------------ | ----------------------------------------------------------------------- | ---------- | ------------- | ----------------------------------------------------------------------------- |
| 1   | `pharmacy-5xx`           | Rx refills are failing since around 14:00 UTC.                          | dependency | rx            | external: pharmacy-a returns 503 for 90% of calls                             |
| 2   | `db-pool-exhaustion`     | Appointment booking is broken since about 14:00 UTC.                    | timeout    | scheduling    | traffic: 75x intake spike for 8 minutes exhausts a 2-connection pool          |
| 3   | `bad-deploy-payload`     | Refills stopped going through to pharmacies around 14:00 UTC.           | data       | rx            | deploy: rx v2.4.0 renames payload keys to snake_case; the worker rejects them |
| 4   | `lab-token-expired`      | Some refills, but not all, have been failing since about 14:00 UTC.     | auth       | rx            | config: lab-results credential expires; only refills needing labs fail        |
| 5   | `dynamodb-hot-partition` | Refill processing got slow and some refills fail since about 14:00 UTC. | dependency | rx            | traffic: an auto-refill batch hammers one partition key                       |
| 6   | `sms-silent-drop`        | Patients stopped getting text messages this afternoon.                  | dependency | notifications | external: SMS provider accepts but never delivers. **No errors are logged.**  |

Scenario 6 is the hard one on purpose. The only signal is something that stops happening: `notifications.sms.delivered` drops to zero while `notifications.sms.accepted` continues and email deliveries are normal.

## Legacy formats

Each team "wrote its own logs":

| Service       | Shape                                                                     | What's lost                                          |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| intake        | `[2026-11-18 14:02:11] INFO  intake - msg for Name (pt_00042) (k=v)`      | correlation, request ID, ms precision, event names   |
| rx            | Lambda default: `ts\trequestId\tLEVEL\tmsg values...` plus `REPORT` lines | correlation, context keys (values only), event names |
| scheduling    | `1795006805676 scheduling info msg patient pt_00042 {'k': 'v'}`           | correlation, request ID, stack traces                |
| billing       | its own JSON: `{"ts":"Wed, 18 Nov 2026 14:02:11 GMT","sev":"ERR",...}`    | correlation, request ID, sub-second time, stacks     |
| notifications | `notify> 2026-11-18 14:02 msg to +1-555-0142 values...`                   | correlation, seconds, levels except errors           |

Legacy lines also contain synthetic patient names, phone numbers and emails, which is what real ad-hoc logs leak. That is why Phase 3 redacts tool output before it reaches the model. No legacy line passes the logging standard (`triage lint-logs` reports 0%), and every structured line does (100%).

## Tests

`packages/sim/src/*.test.ts` checks byte-identical output per seed, 100% schema compliance for structured output, no raw patient IDs or contact details in structured output, no correlation IDs in legacy output, an end-to-end correlation trace across API → SQS → EventBridge → webhook, and for each scenario that its signal appears after 14:00 and not before.
