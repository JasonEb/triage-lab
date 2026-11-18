import { lintLogLines } from "@triage/logger";
import { beforeAll, describe, expect, it } from "vitest";
import type { LogRecord } from "./recorder.js";
import type { Rendered } from "./render.js";
import { runScenario, type SimResult } from "./run.js";
import { FAULT_AT, SCENARIOS } from "./scenarios.js";
import { SERVICES } from "./world.js";

const results = new Map<number, { r: SimResult; structured: Rendered; legacy: Rendered }>();

beforeAll(async () => {
  for (const s of SCENARIOS) {
    const r = await runScenario(s.id);
    results.set(s.id, { r, structured: r.render("structured"), legacy: r.render("legacy") });
  }
}, 60_000);

const get = (id: number) => results.get(id)!;
const all = (rendered: Rendered) => Object.values(rendered).join("");
const count = (records: LogRecord[], pred: (r: LogRecord) => boolean) => ({
  before: records.filter((r) => r.t < FAULT_AT && pred(r)).length,
  after: records.filter((r) => r.t >= FAULT_AT && pred(r)).length,
});
const ev = (name: string) => (r: LogRecord) => r.event === name;

describe("determinism", () => {
  it("produces byte-identical output for the same seed", async () => {
    const again = await runScenario(3);
    expect(again.render("structured")).toEqual(get(3).structured);
    expect(again.render("legacy")).toEqual(get(3).legacy);
    expect(again.deploys).toEqual(get(3).r.deploys);
  });

  it("produces different traffic for a different seed", async () => {
    const other = await runScenario(3, 99);
    expect(other.render("structured").rx).not.toEqual(get(3).structured.rx);
  });
});

describe.each(SCENARIOS.map((s) => [s.id, s.slug] as const))("scenario %i (%s): output", (id) => {
  it("every service logs in both styles", () => {
    for (const service of SERVICES) {
      expect(get(id).structured[service].length).toBeGreaterThan(0);
      expect(get(id).legacy[service].length).toBeGreaterThan(0);
    }
  });

  it("structured output is 100% compliant with the logging standard", () => {
    const report = lintLogLines(all(get(id).structured).split("\n"));
    expect(report.topIssues).toEqual([]);
    expect(report.percent).toBe(100);
  });

  it("legacy output is (almost) entirely non-compliant", () => {
    expect(lintLogLines(all(get(id).legacy).split("\n")).percent).toBe(0);
  });

  it("structured output contains no raw patient IDs or contact details; legacy does", () => {
    const s = all(get(id).structured);
    expect(s).not.toMatch(/pt_\d{5}/);
    expect(s).not.toMatch(/@example\.test|\+1-555-01\d\d/);
    const l = all(get(id).legacy);
    expect(l).toMatch(/pt_\d{5}/);
    expect(l).toMatch(/@example\.test|\+1-555-01\d\d/);
  });

  it("legacy output never carries correlation IDs", () => {
    const legacy = all(get(id).legacy);
    const ids = new Set(get(id).r.records.map((r) => r.correlationId));
    for (const cid of ids) expect(legacy.includes(cid)).toBe(false);
  });

  it("both styles contain evidence matching the ground truth", () => {
    const patterns = get(id).r.scenario.groundTruth.evidencePatterns.map((p) => new RegExp(p, "i"));
    for (const text of [all(get(id).structured), all(get(id).legacy)]) {
      expect(patterns.some((p) => p.test(text))).toBe(true);
    }
  });
});

describe("correlation IDs survive async hops (structured)", () => {
  it("one intake request is traceable through scheduling, billing and notifications to the delivery receipt", () => {
    const records = get(6).r.records.filter((r) => r.t < FAULT_AT);
    const booked = records.find(ev("scheduling.appointment.booked"))!;
    const trace = records.filter((r) => r.correlationId === booked.correlationId);
    expect(new Set(trace.map((r) => r.service))).toEqual(
      new Set(["intake", "scheduling", "billing", "notifications"]),
    );
    expect(trace.map((r) => r.event)).toEqual(
      expect.arrayContaining([
        "intake.form.submitted",
        "scheduling.appointment.booked",
        "billing.charge.succeeded",
      ]),
    );
    expect(trace.some((r) => /^notifications\.(sms|email)\.delivered$/.test(r.event))).toBe(true);
  });

  it("one refill is traceable from the API through SQS to the worker and on to billing", () => {
    const records = get(1).r.records.filter((r) => r.t < FAULT_AT);
    const queued = records.find(ev("rx.refill.queued"))!;
    const trace = records.filter((r) => r.correlationId === queued.correlationId);
    expect(trace.map((r) => r.event)).toEqual(
      expect.arrayContaining([
        "rx.refill.queued",
        "rx.refill.submitted",
        "billing.charge.succeeded",
      ]),
    );
    expect(new Set(trace.map((r) => r.requestId)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("ground truth: each fault produces its signal after 14:00 and not before", () => {
  it("1: pharmacy-a 503s fail refills", () => {
    const failed = count(
      get(1).r.records,
      (r) => r.event === "rx.refill.failed" && r.fields.ctx?.pharmacy === "pharmacy-a",
    );
    expect(failed.before).toBe(0);
    expect(failed.after).toBeGreaterThan(100);
    const otherPharmacy = count(
      get(1).r.records,
      (r) => r.event === "rx.refill.failed" && r.fields.ctx?.pharmacy === "pharmacy-b",
    );
    expect(otherPharmacy.after).toBeLessThan(5);
  });

  it("2: intake spike, pool waits, then booking timeouts", () => {
    const records = get(2).r.records;
    const intake = count(records, ev("intake.form.submitted"));
    expect(intake.after).toBeGreaterThan(intake.before * 5);
    expect(count(records, ev("scheduling.db.pool_wait")).before).toBe(0);
    const failed = count(records, ev("scheduling.appointment.failed"));
    expect(failed.before).toBe(0);
    expect(failed.after).toBeGreaterThan(300);
  });

  it("3: rx v2.4.0 deploy at 14:00, then every new refill fails to parse", () => {
    const deploy = get(3).r.deploys.find((d) => d.version === "v2.4.0")!;
    expect(deploy).toMatchObject({ service: "rx", ts: new Date(FAULT_AT).toISOString() });
    const parse = count(get(3).r.records, ev("rx.refill.parse_failed"));
    expect(parse.before).toBe(0);
    expect(parse.after).toBeGreaterThan(300);
    expect(count(get(3).r.records, ev("rx.refill.submitted")).after).toBeLessThan(5);
  });

  it("4: lab checks fail with 401 while refills without labs succeed", () => {
    const records = get(4).r.records;
    const failed = count(records, ev("rx.labs.check_failed"));
    expect(failed.before).toBe(0);
    expect(failed.after).toBeGreaterThan(50);
    expect(count(records, ev("rx.labs.verified")).after).toBe(0);
    expect(count(records, ev("rx.refill.submitted")).after).toBeGreaterThan(80);
  });

  it("5: auto-refill batch, then throttling on the pharmacy-a partition", () => {
    const records = get(5).r.records;
    expect(count(records, ev("rx.autorefill.batch_started"))).toEqual({ before: 0, after: 1 });
    const throttled = count(records, ev("rx.order.write_throttled"));
    expect(throttled.before).toBe(0);
    expect(throttled.after).toBeGreaterThan(200);
    expect(
      records
        .filter(ev("rx.order.write_throttled"))
        .every((r) => r.fields.ctx?.partitionKey === "pharmacy#pharmacy-a"),
    ).toBe(true);
    expect(count(records, ev("rx.order.write_failed")).after).toBeGreaterThan(50);
  });

  it("6: SMS still accepted but never delivered; email fine; no new errors", () => {
    const records = get(6).r.records;
    expect(count(records, ev("notifications.sms.accepted")).after).toBeGreaterThan(100);
    expect(count(records, ev("notifications.sms.delivered"))).toMatchObject({ after: 0 });
    expect(count(records, ev("notifications.sms.delivered")).before).toBeGreaterThan(100);
    expect(count(records, ev("notifications.email.delivered")).after).toBeGreaterThan(40);
    expect(count(records, (r) => r.service === "notifications" && r.level === "error").after).toBe(
      0,
    );
  });
});
