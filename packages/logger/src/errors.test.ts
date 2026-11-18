import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyError, ERROR_TYPES, TriageError, toLogError } from "./errors.js";

describe("error taxonomy", () => {
  it("has exactly the documented types", () => {
    expect([...ERROR_TYPES]).toEqual([
      "validation",
      "dependency",
      "timeout",
      "auth",
      "data",
      "unknown",
    ]);
  });

  it("uses the type from a TriageError", () => {
    const err = new TriageError("auth", "lab token expired", { code: "LAB_TOKEN_EXPIRED" });
    expect(classifyError(err)).toBe("auth");
    expect(toLogError(err)).toMatchObject({
      type: "auth",
      message: "lab token expired",
      code: "LAB_TOKEN_EXPIRED",
    });
  });

  it("classifies ZodError as validation", () => {
    const result = z.object({ a: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) expect(classifyError(result.error)).toBe("validation");
  });

  it.each([
    [Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }), "timeout"],
    [Object.assign(new Error("x"), { name: "TimeoutError" }), "timeout"],
    [Object.assign(new Error("x"), { name: "AbortError" }), "timeout"],
    [Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), "dependency"],
    [
      Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" }),
      "dependency",
    ],
    [Object.assign(new Error("x"), { statusCode: 503 }), "dependency"],
    [Object.assign(new Error("x"), { statusCode: 401 }), "auth"],
    [Object.assign(new Error("x"), { statusCode: 403 }), "auth"],
    [new SyntaxError("Unexpected token"), "data"],
    [new Error("something odd"), "unknown"],
    ["a thrown string", "unknown"],
  ] as const)("classifies %o as %s", (err, expected) => {
    expect(classifyError(err)).toBe(expected);
  });

  it("serializes non-Error throwables", () => {
    expect(toLogError("boom")).toEqual({ type: "unknown", message: "boom" });
  });

  it("caps stack length", () => {
    const err = new Error("x");
    err.stack = "y".repeat(10_000);
    expect(toLogError(err).stack?.length).toBeLessThanOrEqual(2000);
  });
});
