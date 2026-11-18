import { describe, expect, it } from "vitest";
import { redactLogLine, redactText } from "./redact.js";
import type { LogLine } from "./schema.js";

describe("redactText: removes PHI/PII", () => {
  it.each([
    ["Sent receipt to jane.doe+derm@example.com", "Sent receipt to [EMAIL]"],
    ["Callback (555) 123-4567 failed", "Callback [PHONE] failed"],
    ["Callback 555-123-4567 failed", "Callback [PHONE] failed"],
    ["Callback 555.123.4567 failed", "Callback [PHONE] failed"],
    ["Callback +1 555 123 4567 failed", "Callback [PHONE] failed"],
    ["SMS to 5551234567 queued", "SMS to [PHONE] queued"],
    ["SSN 123-45-6789 on file", "SSN [SSN] on file"],
    ["DOB 1985-03-14 mismatch", "DOB [DATE] mismatch"],
    ["dob: 03/14/1985", "dob: [DATE]"],
    ["born 3/4/85", "born [DATE]"],
    ["Birthday March 14, 1985 on form", "Birthday [DATE] on form"],
    ["Card 4111 1111 1111 1111 declined", "Card [CARD] declined"],
    ["Card 4111-1111-1111-1111 declined", "Card [CARD] declined"],
    ["MRN 00451234 not found", "MRN [ID] not found"],
    ["patientId=pt_88213 missing", "patientId=[ID] missing"],
    ["member id: M-55120 lapsed", "member id: [ID] lapsed"],
    ["Refill for patient Jane Doe failed", "Refill for patient [NAME] failed"],
    ["Patient name: Maria Garcia", "Patient name: [NAME]"],
    ["Message from Dr. Okafor", "Message from [NAME]"],
    ["Ms Rivera rescheduled", "[NAME] rescheduled"],
    ["Rx isotretinoin 40mg rejected", "Rx [MEDICATION] 40mg rejected"],
    ["Prescribed Accutane and Spironolactone", "Prescribed [MEDICATION] and [MEDICATION]"],
    ["benzoyl peroxide wash backordered", "[MEDICATION] wash backordered"],
    ["Authorization: Bearer eyJhbGciOi.abc.def rejected", "Authorization: Bearer [TOKEN] rejected"],
  ])("%s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("handles several kinds in one string", () => {
    expect(
      redactText("patient John Smith (john@ex.com, 555-123-4567) DOB 1990-01-02 on tretinoin"),
    ).toBe("patient [NAME] ([EMAIL], [PHONE]) DOB [DATE] on [MEDICATION]");
  });

  it("redacts names from a configured list wherever they appear", () => {
    expect(redactText("Escalated by Priya to support", { names: ["Priya"] })).toBe(
      "Escalated by [NAME] to support",
    );
  });

  it("can extend the medication list", () => {
    expect(redactText("Started zorvex cream", { extraMedications: ["zorvex"] })).toBe(
      "Started [MEDICATION] cream",
    );
  });

  it("can turn medication redaction off (e.g. for a non-clinical service)", () => {
    expect(redactText("Rx doxycycline shipped", { medications: false })).toBe(
      "Rx doxycycline shipped",
    );
  });

  it("is idempotent", () => {
    const once = redactText("patient Jane Doe jane@ex.com 555-123-4567");
    expect(redactText(once)).toBe(once);
  });
});

describe("redactText: keeps debugging signal", () => {
  it.each([
    "Pharmacy partner returned HTTP 503 after 812 ms",
    "attempt 2 of 3, retry in 30000 ms",
    "deployed rx v1.14.2 (build 20261118.4)",
    "correlationId 3f2b9c1e-8a4d-4f7b-9c2e-1a2b3c4d5e6f",
    "requestId req-000123",
    "order 12345 has 3 items",
    "pool size 20, waiting 57, timeout 5000ms",
    "Patient record not found",
    "patient portal session expired",
    "event rx.refill.failed emitted",
    "DynamoDB ProvisionedThroughputExceededException on table rx-orders",
    "port 5432 refused",
  ])("leaves %s unchanged", (input) => {
    expect(redactText(input)).toBe(input);
  });
});

describe("redactLogLine", () => {
  const line: LogLine = {
    ts: "2026-11-18T14:02:11.123Z",
    level: "error",
    service: "notifications",
    env: "sim",
    event: "notifications.sms.failed",
    msg: "SMS to 555-123-4567 failed",
    requestId: "req-1",
    correlationId: "corr-1",
    error: {
      type: "dependency",
      message: "provider rejected jane@ex.com",
      stack: "Error: provider rejected jane@ex.com\n    at send (sms.ts:10)",
      code: "SMS_REJECTED",
    },
    ctx: { recipient: "jane@ex.com", attempt: 2, ok: false, note: null },
  };

  it("redacts msg, error message/stack, and ctx strings", () => {
    const out = redactLogLine(line);
    expect(out.msg).toBe("SMS to [PHONE] failed");
    expect(out.error?.message).toBe("provider rejected [EMAIL]");
    expect(out.error?.stack).toContain("provider rejected [EMAIL]");
    expect(out.ctx).toEqual({ recipient: "[EMAIL]", attempt: 2, ok: false, note: null });
  });

  it("does not touch structured fields", () => {
    const out = redactLogLine(line);
    expect(out.event).toBe(line.event);
    expect(out.error?.code).toBe("SMS_REJECTED");
    expect(out.ts).toBe(line.ts);
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(line);
    redactLogLine(line);
    expect(line).toEqual(copy);
  });
});
