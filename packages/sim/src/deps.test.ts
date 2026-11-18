import { describe, expect, it } from "vitest";
import { PgPool, TokenBucket, simError } from "./deps.js";
import { classifyError, TriageError } from "@triage/logger";

describe("PgPool", () => {
  it("acquires immediately while connections are free", () => {
    const pool = new PgPool(2, 5000);
    expect(pool.acquire(0, 1000)).toEqual({ waitMs: 0, timedOut: false });
    expect(pool.acquire(0, 1000)).toEqual({ waitMs: 0, timedOut: false });
  });

  it("queues when exhausted and waits for the earliest release", () => {
    const pool = new PgPool(2, 5000);
    pool.acquire(0, 1000);
    pool.acquire(0, 3000);
    expect(pool.acquire(100, 500)).toEqual({ waitMs: 900, timedOut: false });
    // next free: conn A at 1500, conn B at 3000
    expect(pool.acquire(200, 500)).toEqual({ waitMs: 1300, timedOut: false });
  });

  it("times out when the wait exceeds the limit and does not take a connection", () => {
    const pool = new PgPool(1, 5000);
    pool.acquire(0, 10_000);
    expect(pool.acquire(0, 100)).toEqual({ waitMs: 5000, timedOut: true });
    expect(pool.acquire(10_000, 100)).toEqual({ waitMs: 0, timedOut: false });
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then refills at the rate", () => {
    const b = new TokenBucket(1, 2); // 1/s, burst 2
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(1000)).toBe(true);
    expect(b.take(1000)).toBe(false);
  });

  it("tolerates out-of-order timestamps without minting tokens", () => {
    const b = new TokenBucket(1, 1);
    expect(b.take(5000)).toBe(true);
    expect(b.take(1000)).toBe(false);
  });
});

describe("simError", () => {
  it("builds a classified error with a deterministic, Lambda-looking stack", () => {
    const e = simError("dependency", "Pharmacy returned 503", {
      code: "PHARMACY_5XX",
      frames: ["submitRefill (rx/pharmacy.js:42:11)"],
    });
    expect(e).toBeInstanceOf(TriageError);
    expect(classifyError(e)).toBe("dependency");
    expect(e.stack).toBe(
      "TriageError: Pharmacy returned 503\n    at submitRefill (/var/task/rx/pharmacy.js:42:11)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    );
  });
});
