import { describe, expect, it } from "vitest";
import { lintLogLines } from "./lint.js";

const ok = (service: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ts: "2026-11-18T14:02:11.123Z",
    level: "info",
    service,
    env: "sim",
    event: `${service}.thing.happened`,
    msg: "fine",
    requestId: "r",
    correlationId: "c",
    ...extra,
  });

describe("lintLogLines", () => {
  it("reports overall and per-service compliance", () => {
    const report = lintLogLines([
      ok("rx"),
      ok("rx"),
      ok("rx", { event: "Refill failed" }),
      ok("billing"),
      "",
      "[ERROR] 2026-11-18 14:02 rx refill failed for patient 123",
    ]);
    expect(report.total).toBe(5);
    expect(report.compliant).toBe(3);
    expect(report.percent).toBeCloseTo(60);
    expect(report.byService).toEqual([
      { service: "billing", total: 1, compliant: 1, percent: 100 },
      { service: "rx", total: 3, compliant: 2, percent: (2 / 3) * 100 },
      { service: "unknown", total: 1, compliant: 0, percent: 0 },
    ]);
  });

  it("aggregates the most common issues", () => {
    const report = lintLogLines([
      "not json",
      "also not json",
      ok("rx", { event: "bad" }),
      ok("rx", { requestId: undefined }),
    ]);
    expect(report.topIssues[0]).toEqual({ issue: "not valid JSON", count: 2 });
    expect(report.topIssues.map((i) => i.issue)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^event:/),
        expect.stringMatching(/^requestId:/),
      ]),
    );
  });

  it("flags schema-valid lines whose free text still contains PHI", () => {
    const report = lintLogLines([ok("notifications", { msg: "SMS to 555-123-4567 failed" })]);
    expect(report.compliant).toBe(0);
    expect(report.topIssues).toEqual([
      { issue: "msg: contains text the redactor would mask", count: 1 },
    ]);
  });

  it("attributes JSON lines with a string service even when invalid", () => {
    const report = lintLogLines([JSON.stringify({ service: "intake", message: "legacy shape" })]);
    expect(report.byService).toEqual([{ service: "intake", total: 1, compliant: 0, percent: 0 }]);
  });

  it("handles an empty input", () => {
    expect(lintLogLines([])).toMatchObject({ total: 0, compliant: 0, percent: 0, byService: [] });
  });
});
