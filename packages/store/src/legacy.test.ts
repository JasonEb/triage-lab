import { describe, expect, it } from "vitest";
import { normalizePattern, parseLegacy } from "./legacy.js";

const T = Date.parse("2026-11-18T14:02:11.000Z");

describe("parseLegacy", () => {
  it("parses bracketed second-precision lines and keeps stack traces with their entry", () => {
    const text = [
      "[2026-11-18 14:02:11] INFO  intake - Intake form submitted for Sam Tanaka (pt_00067) (channel=ios)",
      "[2026-11-18 14:02:12] ERROR intake - boom",
      "TriageError: boom",
      "    at handler (/var/task/index.js:1:1)",
    ].join("\n");
    const entries = parseLegacy(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ ts: T, level: "info", precisionMs: 1000, lineNo: 1 });
    expect(entries[1]!.level).toBe("error");
    expect(entries[1]!.text.split("\n")).toHaveLength(3);
  });

  it("parses Lambda console lines with request IDs, and REPORT lines inherit the previous time", () => {
    const rid = "6b57c454-08ee-4ea5-99e4-c8b76e57dd9b";
    const text = [
      `2026-11-18T14:02:11.254Z\t${rid}\tWARN\tPharmacy partner call failed, retrying pharmacy-a 503 1`,
      `REPORT RequestId: ${rid}\tDuration: 31.21 ms\tBilled Duration: 32 ms`,
    ].join("\n");
    const [a, b] = parseLegacy(text);
    expect(a).toMatchObject({ ts: T + 254, level: "warn", requestId: rid, precisionMs: 1 });
    expect(b).toMatchObject({ ts: T + 254, level: "info", requestId: rid });
  });

  it("parses epoch-millisecond lines", () => {
    const [e] = parseLegacy(
      `${T + 5} scheduling error could not book appointment patient pt_00001 - Timed out`,
    );
    expect(e).toMatchObject({ ts: T + 5, level: "error", precisionMs: 1 });
  });

  it("parses ad-hoc JSON lines with RFC 1123 timestamps and severity codes", () => {
    const [e] = parseLegacy(
      JSON.stringify({
        ts: "Wed, 18 Nov 2026 14:02:11 GMT",
        sev: "WRN",
        message: "Card declined",
        patient: "pt_00001",
      }),
    );
    expect(e).toMatchObject({ ts: T, level: "warn", precisionMs: 1000 });
  });

  it("parses minute-precision notify> lines and their markers", () => {
    const [a, b, c] = parseLegacy(
      [
        "notify> 2026-11-18 14:02 provider accepted sms to +1-555-0165 sms-provider-a",
        "notify> 2026-11-18 14:02 ! provider reported delivery failure",
        "notify> 2026-11-18 14:02 !! handler failed (x)",
      ].join("\n"),
    );
    expect(a).toMatchObject({ ts: T - 11_000, level: "info", precisionMs: 60_000 });
    expect(b!.level).toBe("warn");
    expect(c!.level).toBe("error");
  });

  it("keeps unparseable leading lines instead of dropping them", () => {
    const [e] = parseLegacy("some garbage\n[2026-11-18 14:02:11] INFO  intake - ok");
    expect(e).toMatchObject({ ts: null, level: null, text: "some garbage" });
  });
});

describe("normalizePattern", () => {
  it("collapses variable parts so repeated messages cluster", () => {
    const a = normalizePattern(
      "Refill failed for pt_00360: HTTP 503 after 812ms id 6b57c454-08ee-4ea5-99e4-c8b76e57dd9b",
    );
    const b = normalizePattern(
      "Refill failed for pt_00012: HTTP 503 after 95ms id 0b57c454-08ee-4ea5-99e4-c8b76e57dd9c",
    );
    expect(a).toBe(b);
    expect(a).not.toMatch(/pt_|\d/);
  });

  it("keeps meaningful words and names of dependencies", () => {
    expect(normalizePattern("call to pharmacy-a failed")).toContain("pharmacy-a");
  });
});
