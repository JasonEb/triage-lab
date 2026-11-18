import { describe, expect, it } from "vitest";
import { EVENT_NAME_PATTERN, LogLineSchema, type LogLine } from "./schema.js";

const valid: LogLine = {
  ts: "2026-11-18T14:02:11.123Z",
  level: "error",
  service: "rx",
  env: "sim",
  event: "rx.refill.failed",
  msg: "Pharmacy partner returned 503",
  requestId: "req-1",
  correlationId: "corr-1",
  durationMs: 812,
  patientIdHash: "a".repeat(16),
  error: { type: "dependency", message: "HTTP 503", code: "PHARMACY_5XX" },
  ctx: { partner: "pharmacy-a", attempt: 2, retryable: true },
};

describe("LogLineSchema", () => {
  it("accepts a fully populated line", () => {
    expect(LogLineSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a minimal line (optional fields omitted)", () => {
    const minimal: Record<string, unknown> = { ...valid };
    for (const key of ["durationMs", "patientIdHash", "error", "ctx"]) delete minimal[key];
    expect(LogLineSchema.safeParse(minimal).success).toBe(true);
  });

  it.each(["ts", "level", "service", "env", "event", "msg", "requestId", "correlationId"])(
    "rejects a line missing required field %s",
    (field) => {
      const line: Record<string, unknown> = { ...valid };
      delete line[field];
      expect(LogLineSchema.safeParse(line).success).toBe(false);
    },
  );

  it("rejects unknown top-level fields (keeps the shape bounded)", () => {
    expect(LogLineSchema.safeParse({ ...valid, patientEmail: "x@y.z" }).success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(LogLineSchema.safeParse({ ...valid, ts: "18/11/2026 14:02" }).success).toBe(false);
  });

  it("rejects levels and services outside the allowed sets", () => {
    expect(LogLineSchema.safeParse({ ...valid, level: "fatal" }).success).toBe(false);
    expect(LogLineSchema.safeParse({ ...valid, service: "RX Service" }).success).toBe(false);
  });

  it("rejects an error type outside the taxonomy", () => {
    const line = { ...valid, error: { type: "oops", message: "x" } };
    expect(LogLineSchema.safeParse(line).success).toBe(false);
  });

  it("rejects a raw-looking patient id in patientIdHash", () => {
    expect(LogLineSchema.safeParse({ ...valid, patientIdHash: "patient-12345" }).success).toBe(
      false,
    );
  });

  it("rejects nested objects and oversized values in ctx", () => {
    expect(LogLineSchema.safeParse({ ...valid, ctx: { nested: { a: 1 } } }).success).toBe(false);
    expect(LogLineSchema.safeParse({ ...valid, ctx: { note: "x".repeat(201) } }).success).toBe(
      false,
    );
  });

  it("rejects ctx with too many keys", () => {
    const ctx = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(LogLineSchema.safeParse({ ...valid, ctx }).success).toBe(false);
  });

  it("rejects negative durations", () => {
    expect(LogLineSchema.safeParse({ ...valid, durationMs: -1 }).success).toBe(false);
  });
});

describe("event names", () => {
  it.each([
    "rx.refill.failed",
    "intake.form.submitted",
    "rx.handler.completed",
    "billing.charge.retry_scheduled",
  ])("accepts %s", (name) => {
    expect(EVENT_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each([
    "Refill failed",
    "rx.failed",
    "rx.refill.failed.for.patient.123",
    "RX.Refill.Failed",
    "rx..failed",
    "rx.refill.failed-now",
  ])("rejects %s", (name) => {
    expect(EVENT_NAME_PATTERN.test(name)).toBe(false);
    expect(LogLineSchema.safeParse({ ...valid, event: name }).success).toBe(false);
  });
});
