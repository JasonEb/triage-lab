import { describe, expect, it } from "vitest";
import { Rng } from "./rng.js";

describe("Rng", () => {
  it("is deterministic for a seed", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });

  it("differs across seeds", () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it("stays in range", () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = r.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it("has sensible helpers", () => {
    const r = new Rng(9);
    expect(["a", "b"]).toContain(r.pick(["a", "b"]));
    expect(r.uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(r.hex(7)).toMatch(/^[0-9a-f]{7}$/);
    const samples = Array.from({ length: 2000 }, () => r.lognormal(100, 0.4)).sort((a, b) => a - b);
    const median = samples[1000]!;
    expect(median).toBeGreaterThan(85);
    expect(median).toBeLessThan(115);
    const exp = Array.from({ length: 4000 }, () => r.exponential(2));
    const mean = exp.reduce((s, x) => s + x, 0) / exp.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});
