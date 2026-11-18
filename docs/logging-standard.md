# Logging standard

Every service writes logs through `@triage/logger`. A log line is one JSON object, validated by a Zod schema before it is written. The standard has two readers in mind: an on-call engineer and an AI troubleshooting agent. Both need the same things: the ability to filter, group and join on fields instead of grepping prose.

```json
{
  "ts": "2026-11-18T14:02:11.123Z",
  "level": "error",
  "service": "rx",
  "env": "prod",
  "event": "rx.refill.failed",
  "msg": "Refill failed",
  "requestId": "6c1f0f2e-0d0b-4a43-9b0e-6f1c6b0f8a11",
  "correlationId": "c0a8017e-5b4c-4d7e-8e3a-2f1d9a7b6c55",
  "durationMs": 812,
  "patientIdHash": "4e1b9f7a0c3d2e58b6a1f09c7d3e2b14",
  "error": {
    "type": "dependency",
    "message": "HTTP 503 from pharmacy partner",
    "code": "PHARMACY_5XX"
  },
  "ctx": { "partner": "pharmacy-a", "attempt": 2 }
}
```

## Fields

| Field           | Required | Rule                                                                 | Why it helps an AI (and a human)                                                                                                              |
| --------------- | -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts`            | yes      | ISO 8601 UTC, millisecond precision                                  | Time-window queries ("since 2pm") and ordering across services need one unambiguous clock format.                                             |
| `level`         | yes      | `debug` \| `info` \| `warn` \| `error`                               | A four-value enum is a cheap first filter. Free-form levels (`FATAL`, `Err`, `critical`) split the same signal across many buckets.           |
| `service`       | yes      | short kebab-case name                                                | "Which service is the culprit?" becomes a group-by.                                                                                           |
| `env`           | yes      | `local` \| `sim` \| `test` \| `dev` \| `staging` \| `prod`           | Stops staging noise from being mistaken for a production incident.                                                                            |
| `event`         | yes      | `domain.entity.action`, see below                                    | The single most useful field. A stable name lets the agent count, cluster and compare without parsing prose.                                  |
| `msg`           | yes      | ≤ 500 chars, redacted                                                | For humans. Agents should rely on `event` and `error`, not `msg`.                                                                             |
| `requestId`     | yes      | the invocation's ID (`awsRequestId`)                                 | Groups the lines of one invocation.                                                                                                           |
| `correlationId` | yes      | propagated across every hop                                          | Joins one user action across services and async boundaries. This is what lets the agent call `get_trace` and see the whole story.             |
| `durationMs`    | no       | non-negative integer                                                 | Latency is a number, not text inside a message, so "p95 jumped" is a query.                                                                   |
| `patientIdHash` | no       | hex HMAC digest, never a raw ID                                      | Lets you follow one patient's requests without the log containing who they are.                                                               |
| `error`         | no       | `{ type, message, stack?, code? }`                                   | `type` comes from the taxonomy; `code` is a stable `UPPER_SNAKE` identifier. Typed errors turn "what kind of failure is this?" into a lookup. |
| `ctx`           | no       | ≤ 20 flat keys; string, number, boolean or null; strings ≤ 200 chars | Room for specifics (`partner`, `attempt`, `table`) without letting lines grow without bound.                                                  |

Unknown top-level fields are rejected. If a field is worth having, it is worth adding to the schema.

## Event names

Format: `domain.entity.action`, with an optional fourth segment. Lowercase, `snake_case` segments. Regex: `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,3}$`.

- Good: `rx.refill.requested`, `rx.refill.failed`, `intake.form.submitted`, `billing.charge.retry_scheduled`
- Bad: `Refill failed` (prose), `rx.failed` (too vague), `rx.refill.failed.for.patient.123` (carries data), `RX.Refill.Failed` (case)

Rules:

- **Stable.** Renaming an event breaks dashboards, alerts and the agent's learned expectations. Treat names like an API.
- **No data in names.** IDs, counts and partner names go in `ctx`. The set of event names must stay small and enumerable.
- **Past tense for things that happened** (`failed`, `submitted`), present for things in progress (`retrying`).
- `withLogging` emits `<service>.handler.started`, `.completed` and `.failed` for every invocation. Hyphens in the service name become underscores (`lab-results` → `lab_results.handler.started`).

## Error taxonomy

Every logged error has exactly one `type`:

| Type         | Meaning                                | Typical examples                                            |
| ------------ | -------------------------------------- | ----------------------------------------------------------- |
| `validation` | The input was wrong.                   | Zod failure, missing field, bad request body                |
| `dependency` | Something we call failed.              | Partner 5xx or 429, connection refused, DynamoDB throttling |
| `timeout`    | Something took too long.               | `ETIMEDOUT`, aborted request, DB pool wait exceeded         |
| `auth`       | Credentials were rejected.             | 401/403, expired integration token                          |
| `data`       | Our own data or payload was malformed. | Unparseable JSON, a field renamed by a bad deploy           |
| `unknown`    | Not classified yet.                    | Anything else; a rising share means the taxonomy needs work |

Throw `new TriageError(type, message, { code })` when you know the type. Otherwise `classifyError` maps common shapes (Zod errors, Node error codes, HTTP status codes, AWS throttling exceptions) to a type. Stack traces are capped at 2,000 characters.

## Cardinality

Indexed fields (`service`, `env`, `level`, `event`, `error.type`, `error.code`) only hold values from small, known sets. That keeps queries cheap and keeps clustering meaningful: 50 distinct event names cluster well, while 50,000 distinct messages don't. High-cardinality values (IDs, counts, partner names) go in `ctx` or the ID fields.

## Correlation across hops

The correlation ID has to survive every boundary, including asynchronous ones. That is where most logging standards break.

| Hop                | Carried in                        | Helper                          |
| ------------------ | --------------------------------- | ------------------------------- |
| HTTP / API Gateway | `x-correlation-id` header         | `correlationHeaders(id)`        |
| SQS                | message attribute `correlationId` | `sqsMessageAttributes(id)`      |
| EventBridge        | `detail.correlationId`            | `eventBridgeDetail(detail, id)` |

`withLogging` reads the ID from whichever trigger invoked the handler and generates one if none is present. An incoming ID that isn't a plain token (letters, digits, `._:-`, ≤ 128 chars) is replaced and the start line is flagged with `ctx.invalidCorrelationId`. That stops a caller from smuggling free text, or PHI, into an indexed field. An SQS batch with several records has no single correlation ID: the handler logs each record with `log.child({ requestId, correlationId: correlationIdFromSqsRecord(record) })`.

## PHI and redaction

All data in this project is synthetic. The rules are written as if it weren't.

1. **Structure first.** Patient identifiers go in `patientIdHash` (HMAC-SHA256, 128 bits, keyed by `TRIAGE_ID_HASH_SALT`). Pass the raw ID as `patientId` and the logger hashes it, so the raw value never reaches the sink. The hash is keyed so it can't be reversed by enumerating the small space of patient IDs.
2. **Redaction as a safety net.** Before validation, the logger redacts `msg`, `error.message`, `error.stack` and string `ctx` values. Emails, phone numbers, SSNs, dates (including dates of birth), card numbers, labeled IDs (`MRN`, `patientId`, `member id`), bearer tokens, labeled or titled names (`patient Jane Doe`, `Dr. Okafor`), a configurable list of names, and medication names (a configurable list, on by default) are masked as `[EMAIL]`, `[PHONE]` and so on.
3. **Again before the model.** The troubleshooting agent (Phase 3) re-runs redaction on tool output before it reaches the LLM, so legacy logs that never went through the logger are covered too.

Known limits: name detection is heuristic, and a bare name in arbitrary prose (`"Jane called back"`) will not be caught unless it is on the configured list. That is why rule 1 matters more than rule 2. Redaction tests check both directions: PHI is masked, and ordinary debugging text (status codes, durations, versions, UUIDs) is left alone.

## Failure behavior

A line that fails the schema **throws** in `local`, `sim` and `test`, so mistakes fail tests and CI. In `dev`, `staging` and `prod` it **never throws**. The logger writes a `logger.schema.violation` warning naming the failed fields instead. Logging must never take down a request. Over-long `msg` values are truncated rather than rejected.

## Checking compliance

```bash
pnpm triage lint-logs logs/rx.jsonl
pnpm triage lint-logs logs/rx.jsonl --json
pnpm triage lint-logs logs/rx.jsonl --min-percent=95   # exit 1 below the bar (CI gate)
```

A line is compliant when it is JSON, matches the schema, and none of its free text would be changed by redaction. The report gives overall and per-service percentages and the most common issues, which makes it a migration tracker for moving services onto the standard.

## Using it

```ts
import { createLogger, withLogging, TriageError, sqsMessageAttributes } from "@triage/logger";

const base = createLogger({ service: "rx", env: "prod" });

export const handler = withLogging(base, async (event, { log, correlationId }) => {
  log.info("rx.refill.requested", "Refill requested", { patientId: event.patientId });
  const res = await pharmacy.submit(event);
  if (res.status >= 500) {
    throw new TriageError("dependency", `Pharmacy returned ${res.status}`, {
      code: "PHARMACY_5XX",
    });
  }
  await queue.send({ body: "...", attributes: sqsMessageAttributes(correlationId) });
});
```
