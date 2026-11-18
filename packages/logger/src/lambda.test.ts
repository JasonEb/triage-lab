import { describe, expect, it } from "vitest";
import { createLogger, createMemorySink } from "./logger.js";
import {
  correlationHeaders,
  eventBridgeDetail,
  extractCorrelationId,
  sqsMessageAttributes,
  withLogging,
  type LambdaContext,
} from "./lambda.js";
import { TriageError } from "./errors.js";

function setup(service = "rx") {
  const sink = createMemorySink();
  let t = 1_000;
  const base = createLogger({
    service,
    env: "test",
    sink: sink.write,
    now: () => new Date("2026-11-18T14:00:00.000Z"),
  });
  let n = 0;
  const opts = { clock: () => (t += 25), newId: () => `gen-${++n}` };
  return { sink, base, opts };
}

const ctx = (awsRequestId = "aws-req-1"): LambdaContext => ({ awsRequestId });

const apiEvent = (headers: Record<string, string>) => ({
  httpMethod: "POST",
  path: "/refills",
  headers,
  body: "{}",
});
const sqsEvent = (attrs: Record<string, { stringValue: string; dataType: string }>[]) => ({
  Records: attrs.map((messageAttributes, i) => ({
    messageId: `m-${i}`,
    eventSource: "aws:sqs",
    body: "{}",
    messageAttributes,
  })),
});
const ebEvent = (detail: Record<string, unknown>) => ({
  "detail-type": "RefillRequested",
  source: "honeydew.rx",
  detail,
});

describe("extractCorrelationId", () => {
  it("reads the API Gateway header case-insensitively", () => {
    expect(extractCorrelationId(apiEvent({ "X-Correlation-Id": "c-1" }))).toEqual({
      correlationId: "c-1",
      trigger: "apigateway",
    });
  });
  it("reads a single SQS record's message attribute", () => {
    const event = sqsEvent([{ correlationId: { stringValue: "c-2", dataType: "String" } }]);
    expect(extractCorrelationId(event)).toEqual({ correlationId: "c-2", trigger: "sqs" });
  });
  it("reads EventBridge detail.correlationId", () => {
    expect(extractCorrelationId(ebEvent({ correlationId: "c-3" }))).toEqual({
      correlationId: "c-3",
      trigger: "eventbridge",
    });
  });
  it("reads a direct invocation payload", () => {
    expect(extractCorrelationId({ correlationId: "c-4" })).toEqual({
      correlationId: "c-4",
      trigger: "direct",
    });
  });
  it("returns undefined when the event carries none", () => {
    expect(extractCorrelationId(apiEvent({})).correlationId).toBeUndefined();
    expect(extractCorrelationId(null).correlationId).toBeUndefined();
  });
  it("does not pick one ID for a multi-record SQS batch", () => {
    const event = sqsEvent([
      { correlationId: { stringValue: "a", dataType: "String" } },
      { correlationId: { stringValue: "b", dataType: "String" } },
    ]);
    expect(extractCorrelationId(event)).toEqual({ correlationId: undefined, trigger: "sqs" });
  });
});

describe("withLogging", () => {
  it("logs started and completed with requestId, correlationId, trigger and duration", async () => {
    const { sink, base, opts } = setup();
    const handler = withLogging(base, async () => ({ statusCode: 200 }), opts);
    const res = await handler(apiEvent({ "x-correlation-id": "corr-abc" }), ctx());

    expect(res).toEqual({ statusCode: 200 });
    expect(sink.lines.map((l) => l.event)).toEqual(["rx.handler.started", "rx.handler.completed"]);
    for (const l of sink.lines) {
      expect(l).toMatchObject({ requestId: "aws-req-1", correlationId: "corr-abc" });
    }
    expect(sink.lines[0]!.ctx).toEqual({ trigger: "apigateway" });
    expect(sink.lines[1]!.durationMs).toBe(25);
  });

  it("generates a correlation ID when the event has none", async () => {
    const { sink, base, opts } = setup();
    await withLogging(base, async () => undefined, opts)(apiEvent({}), ctx());
    expect(sink.lines[0]!.correlationId).toBe("gen-1");
  });

  it("replaces a malformed incoming correlation ID and flags it", async () => {
    const { sink, base, opts } = setup();
    const bad = "jane@example.com said hi";
    await withLogging(
      base,
      async () => undefined,
      opts,
    )(apiEvent({ "x-correlation-id": bad }), ctx());
    expect(sink.lines[0]).toMatchObject({
      correlationId: "gen-1",
      ctx: { trigger: "apigateway", invalidCorrelationId: true },
    });
    expect(sink.raw.join("")).not.toContain("jane@example.com");
  });

  it("gives the handler a logger bound to the same IDs", async () => {
    const { sink, base, opts } = setup();
    const handler = withLogging(
      base,
      async (_event, context) => {
        context.log.info("rx.refill.validated", "ok");
        return context.correlationId;
      },
      opts,
    );
    const out = await handler(ebEvent({ correlationId: "corr-eb" }), ctx("aws-2"));
    expect(out).toBe("corr-eb");
    expect(sink.lines[1]).toMatchObject({
      event: "rx.refill.validated",
      requestId: "aws-2",
      correlationId: "corr-eb",
    });
  });

  it("logs failures in the standard error shape and rethrows", async () => {
    const { sink, base, opts } = setup();
    const boom = new TriageError("dependency", "pharmacy 503", { code: "PHARMACY_5XX" });
    const handler = withLogging(
      base,
      async () => {
        throw boom;
      },
      opts,
    );

    await expect(handler(apiEvent({}), ctx())).rejects.toBe(boom);
    expect(sink.lines.at(-1)).toMatchObject({
      level: "error",
      event: "rx.handler.failed",
      durationMs: 25,
      error: { type: "dependency", code: "PHARMACY_5XX" },
    });
  });

  it("makes a valid event prefix from a kebab-case service name", async () => {
    const { sink, base, opts } = setup("lab-results");
    await withLogging(base, async () => undefined, opts)({}, ctx());
    expect(sink.lines[0]!.event).toBe("lab_results.handler.started");
  });
});

describe("propagation across async hops", () => {
  it("keeps one correlation ID from API Gateway through SQS to EventBridge", async () => {
    const { sink, base, opts } = setup();
    const intake = base;
    const rx = createLogger({ service: "rx", env: "test", sink: sink.write });
    const notify = createLogger({ service: "notifications", env: "test", sink: sink.write });

    let queued: unknown;
    let published: unknown;

    const notifications = withLogging(notify, async () => undefined, opts);
    const rxWorker = withLogging(
      rx,
      async (_e, c) => {
        published = ebEvent(eventBridgeDetail({ kind: "refill" }, c.correlationId));
      },
      opts,
    );
    const api = withLogging(
      intake,
      async (_e, c) => {
        queued = sqsEvent([sqsMessageAttributes(c.correlationId)]);
        return { statusCode: 202 };
      },
      opts,
    );

    await api(apiEvent(correlationHeaders("corr-e2e")), ctx("a1"));
    await rxWorker(queued, ctx("a2"));
    await notifications(published, ctx("a3"));

    const ids = new Set(sink.lines.map((l) => l.correlationId));
    expect(ids).toEqual(new Set(["corr-e2e"]));
    expect(new Set(sink.lines.map((l) => l.requestId))).toEqual(new Set(["a1", "a2", "a3"]));
    expect(
      sink.lines.filter((l) => l.event.endsWith("started")).map((l) => l.ctx?.trigger),
    ).toEqual(["apigateway", "sqs", "eventbridge"]);
  });
});
