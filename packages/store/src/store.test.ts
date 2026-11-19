import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSimCli } from "@triage/sim";
import { beforeAll, describe, expect, it } from "vitest";
import { LogStore, toFtsQuery } from "./store.js";

const quiet = { out: () => {}, err: () => {} };
const dirs: Record<number, string> = {};
const at = (hhmm: string) => `2026-11-18T${hhmm}:00.000Z`;

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), "store-"));
  for (const id of [1, 3, 6]) await runSimCli([`--scenario=${id}`, `--out=${out}`], quiet);
  dirs[1] = join(out, "scenario-1-pharmacy-5xx");
  dirs[3] = join(out, "scenario-3-bad-deploy-payload");
  dirs[6] = join(out, "scenario-6-sms-silent-drop");
  // Make sure ground truth can never leak into the store.
  writeFileSync(join(dirs[1], "ground-truth.json"), JSON.stringify({ secret: "zebra-canary" }));
}, 60_000);

describe("toFtsQuery", () => {
  it("quotes every term so input cannot inject FTS syntax", () => {
    expect(toFtsQuery('rx.refill.failed OR "x" NEAR(')).toBe('"rx.refill.failed" "OR" "x" "NEAR"');
    expect(toFtsQuery("   ")).toBeNull();
  });
});

describe("structured store", () => {
  let s: LogStore;
  beforeAll(() => {
    s = LogStore.fromScenarioDir(dirs[1]!, "structured");
  });

  it("ingests every service and the deploys, but not ground truth", () => {
    const ov = s.overview();
    expect(ov.services.map((x) => x.service)).toEqual([
      "billing",
      "intake",
      "notifications",
      "rx",
      "scheduling",
    ]);
    expect(ov).toMatchObject({
      from: expect.stringMatching(/^2026-11-18T13:0/),
      hasEvents: true,
      hasCorrelationIds: true,
    });
    expect(s.recentDeploys({}).length).toBe(3);
    expect(s.searchLogs({ query: "zebra-canary" }).total).toBe(0);
  });

  it("searches full text with service, level and time filters", () => {
    const r = s.searchLogs({
      query: "PHARMACY_5XX",
      service: "rx",
      level: "error",
      from: at("14:00"),
      limit: 5,
    });
    expect(r.total).toBeGreaterThan(100);
    expect(r.rows).toHaveLength(5);
    for (const row of r.rows)
      expect(row).toMatchObject({ service: "rx", level: "error", errorType: "dependency" });
    expect(s.searchLogs({ query: "PHARMACY_5XX", to: at("13:59") }).total).toBe(0);
  });

  it("filters by event name", () => {
    const r = s.searchLogs({ event: "rx.pharmacy.retrying", limit: 1 });
    expect(r.rows[0]!.text).toContain("pharmacy-a");
  });

  it("returns a cross-service trace for one correlation ID", () => {
    const queued = s.searchLogs({ event: "rx.refill.queued", to: at("13:30"), limit: 1 }).rows[0]!;
    const trace = s.getTrace({ correlationId: queued.correlationId! });
    expect(new Set(trace.map((r) => r.service))).toEqual(
      new Set(["rx", "billing", "notifications"]),
    );
  });

  it("clusters errors by fingerprint", () => {
    const clusters = s.errorClusters({ from: at("14:00"), to: at("15:00") });
    expect(clusters[0]).toMatchObject({
      service: "rx",
      event: "rx.pharmacy.retrying",
      level: "warn",
    });
    const failed = clusters.find((c) => c.event === "rx.refill.failed")!;
    expect(failed).toMatchObject({ errorType: "dependency", errorCode: "PHARMACY_5XX" });
    expect(failed.count).toBeGreaterThan(100);
    expect(s.errorClusters({ to: at("13:59") }).some((c) => c.errorCode === "PHARMACY_5XX")).toBe(
      false,
    );
  });

  it("rejects invalid timestamps with a clear message", () => {
    expect(() => s.searchLogs({ from: "2pm" })).toThrow(/from is not a valid ISO timestamp/);
  });
});

describe("timeline shows absence (scenario 6)", () => {
  it("SMS deliveries go to zero after 14:00 while acceptances continue", () => {
    const s = LogStore.fromScenarioDir(dirs[6]!, "structured");
    const t = s.timeline({ service: "notifications", bucketMinutes: 30 });
    expect(t.bucketStarts).toHaveLength(4);
    const delivered = t.patterns.find((p) => p.pattern === "notifications.sms.delivered")!;
    const accepted = t.patterns.find((p) => p.pattern === "notifications.sms.accepted")!;
    expect(delivered.counts[0]).toBeGreaterThan(20);
    expect(delivered.counts.slice(2)).toEqual([0, 0]);
    expect(accepted.counts[3]).toBeGreaterThan(20);
  });
});

describe("legacy store", () => {
  let s: LogStore;
  beforeAll(() => {
    s = LogStore.fromScenarioDir(dirs[1]!, "legacy");
  });

  it("recovers timestamps and levels but has no events or correlation IDs", () => {
    const ov = s.overview();
    expect(ov).toMatchObject({ hasEvents: false, hasCorrelationIds: false });
    expect(s.searchLogs({}).total).toBe(ov.lines);
    expect(s.searchLogs({ level: "error" }).total).toBeGreaterThan(100);
  });

  it("collapses repeated messages into a manageable number of patterns", () => {
    const clusters = s.errorClusters({ from: at("14:00"), limit: 50 });
    expect(clusters.length).toBeLessThan(50);
    expect(
      clusters.some((c) => c.level === "error" && /pharmacy-a/.test(c.pattern) && c.count > 50),
    ).toBe(true);
  });

  it("can follow a Lambda request ID, but not a correlation ID", () => {
    const row = s.searchLogs({ service: "rx", query: "Refill submitted", limit: 1 }).rows[0]!;
    expect(row.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.getTrace({ requestId: row.requestId! }).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps stack traces attached to their entry", () => {
    const row = s.searchLogs({ query: "PharmacyClient.submit", limit: 1 }).rows[0]!;
    expect(row.text.split("\n").length).toBeGreaterThan(2);
  });
});

describe("deploys (scenario 3)", () => {
  it("filters deploys by time window and service", () => {
    const s = LogStore.fromScenarioDir(dirs[3]!, "legacy");
    expect(s.recentDeploys({ from: at("13:55"), to: at("14:05") })).toEqual([
      expect.objectContaining({ service: "rx", version: "v2.4.0" }),
    ]);
    expect(s.recentDeploys({ service: "billing" })).toHaveLength(1);
  });
});
