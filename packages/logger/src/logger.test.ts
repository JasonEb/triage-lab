import { describe, expect, it } from "vitest";
import { hashId } from "./hash.js";
import { createLogger, createMemorySink } from "./logger.js";
import { LogLineSchema } from "./schema.js";
import { TriageError } from "./errors.js";

const fixedNow = () => new Date("2026-11-18T14:02:11.123Z");

function setup(overrides: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const sink = createMemorySink();
  const log = createLogger({
    service: "rx",
    env: "test",
    sink: sink.write,
    now: fixedNow,
    ...overrides,
  });
  return { sink, log };
}

describe("hashId", () => {
  it("is deterministic for the same input and salt", () => {
    expect(hashId("patient-123", "salt")).toBe(hashId("patient-123", "salt"));
  });
  it("differs across inputs and salts", () => {
    expect(hashId("patient-123", "salt")).not.toBe(hashId("patient-124", "salt"));
    expect(hashId("patient-123", "salt")).not.toBe(hashId("patient-123", "other"));
  });
  it("produces a 32-char hex digest that does not contain the input", () => {
    const h = hashId("patient-123", "salt");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain("123");
  });
});

describe("createLogger", () => {
  it("writes one schema-valid JSON line per call", () => {
    const { sink, log } = setup();
    log.info("rx.refill.requested", "Refill requested");
    expect(sink.raw).toHaveLength(1);
    expect(sink.raw[0]!.endsWith("\n")).toBe(false);
    const line = JSON.parse(sink.raw[0]!);
    expect(LogLineSchema.parse(line)).toEqual({
      ts: "2026-11-18T14:02:11.123Z",
      level: "info",
      service: "rx",
      env: "test",
      event: "rx.refill.requested",
      msg: "Refill requested",
      requestId: "none",
      correlationId: "none",
    });
  });

  it("child loggers carry request and correlation IDs", () => {
    const { sink, log } = setup();
    log.child({ requestId: "req-9", correlationId: "corr-9" }).warn("rx.refill.slow", "slow");
    expect(sink.lines[0]).toMatchObject({
      requestId: "req-9",
      correlationId: "corr-9",
      level: "warn",
    });
  });

  it("hashes a raw patientId and never emits it", () => {
    const { sink, log } = setup({ idHashSalt: "s" });
    log.info("rx.refill.requested", "Refill requested", { patientId: "pt_88213" });
    expect(sink.lines[0]!.patientIdHash).toBe(hashId("pt_88213", "s"));
    expect(sink.raw[0]).not.toContain("pt_88213");
  });

  it("redacts free text before writing", () => {
    const { sink, log } = setup();
    log.info("notifications.sms.sent", "SMS to 555-123-4567", { ctx: { to: "jane@ex.com" } });
    expect(sink.raw[0]).not.toContain("555-123-4567");
    expect(sink.raw[0]).not.toContain("jane@ex.com");
  });

  it("serializes errors in the standard shape", () => {
    const { sink, log } = setup();
    const err = new TriageError("dependency", "pharmacy 503", { code: "PHARMACY_5XX" });
    log.error("rx.refill.failed", "Refill failed", { error: err, durationMs: 812 });
    expect(sink.lines[0]).toMatchObject({
      level: "error",
      durationMs: 812,
      error: { type: "dependency", message: "pharmacy 503", code: "PHARMACY_5XX" },
    });
  });

  it("truncates very long messages instead of failing", () => {
    const { sink, log } = setup();
    log.info("rx.refill.requested", "x".repeat(2000));
    expect(sink.lines[0]!.msg.length).toBe(500);
    expect(sink.lines[0]!.msg.endsWith("…")).toBe(true);
  });

  it("drops lines below minLevel", () => {
    const { sink, log } = setup({ minLevel: "info" });
    log.debug("rx.cache.hit", "hit");
    log.info("rx.cache.miss", "miss");
    expect(sink.lines.map((l) => l.event)).toEqual(["rx.cache.miss"]);
  });

  it("throws on schema violations outside prod, so tests catch them", () => {
    const { log } = setup({ env: "test" });
    expect(() => log.info("Refill failed!", "bad event name")).toThrow(/event/);
  });

  it("never throws in prod; emits a logger.schema.violation line instead", () => {
    const { sink, log } = setup({ env: "prod" });
    expect(() => log.info("Refill failed!", "bad event name")).not.toThrow();
    expect(sink.lines[0]).toMatchObject({
      level: "warn",
      event: "logger.schema.violation",
      ctx: { issues: expect.stringContaining("event") },
    });
  });
});
