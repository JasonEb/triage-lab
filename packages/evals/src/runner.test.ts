import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CostMeter, priceFor } from "./cost.js";
import { fakeClient } from "./fake.js";
import { runEvals, type EvalOptions } from "./runner.js";

const logsDir = mkdtempSync(join(tmpdir(), "evals-"));
const RUNBOOKS = join(import.meta.dirname, "../../../docs/runbooks");

const options = (over: Partial<EvalOptions> = {}): EvalOptions => ({
  client: fakeClient(),
  meter: new CostMeter(priceFor("claude-haiku-5-5"), 1),
  model: "claude-haiku-5-5",
  effort: "low",
  maxSteps: 5,
  maxTokens: 100_000,
  scenarios: [1, 2],
  styles: ["structured", "legacy"],
  repeats: 2,
  logsDir,
  runbooksDir: RUNBOOKS,
  concurrency: 2,
  ...over,
});

describe("runEvals (fake client)", () => {
  it("runs every scenario x style x repeat and scores against ground truth", async () => {
    const seen: number[] = [];
    const meter = new CostMeter(priceFor("claude-haiku-5-5"), 1);
    const r = await runEvals(options({ meter, onRun: (_, done) => seen.push(done) }));

    expect(r.aborted).toBeUndefined();
    expect(r.planned).toBe(8);
    expect(r.runs).toHaveLength(8);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.runs.map((x) => [x.repeat, x.scenario, x.style])).toEqual([
      [1, 1, "legacy"],
      [1, 1, "structured"],
      [1, 2, "legacy"],
      [1, 2, "structured"],
      [2, 1, "legacy"],
      [2, 1, "structured"],
      [2, 2, "legacy"],
      [2, 2, "structured"],
    ]);

    // The fake always blames a dependency in rx: right for 1, wrong for 2 (timeout in scheduling).
    const s1 = r.runs.find((x) => x.scenario === 1 && x.style === "structured")!;
    expect(s1).toMatchObject({
      outcome: "diagnosed",
      steps: 2,
      score: { category: 1, service: 1, evidence: 1 },
    });
    const s2 = r.runs.find((x) => x.scenario === 2 && x.style === "structured")!;
    expect(s2.score).toMatchObject({ category: 0, service: 0 });

    // 2 calls x (2,000 input x $0.10 + 300 output x $0.50) / 1M per run.
    expect(s1.costUsd).toBeCloseTo(0.0007, 6);
    expect(meter.spentUsd).toBeCloseTo(8 * 0.0007, 6);
    expect(meter.calls).toBe(16);
  }, 60_000);

  it("stops at the cost cap and keeps the runs that finished", async () => {
    const meter = new CostMeter(priceFor("claude-haiku-5-5"), 0.002);
    const r = await runEvals(options({ meter, concurrency: 1 }));
    expect(r.aborted).toMatch(/reached the cap/);
    expect(r.runs.length).toBeGreaterThan(0);
    expect(r.runs.length).toBeLessThan(r.planned);
    // With one run in flight, overshoot is at most one call.
    expect(meter.spentUsd).toBeLessThanOrEqual(0.002 + 0.00035 + 1e-9);
  }, 60_000);

  it("stops on an API error instead of retrying every case", async () => {
    let calls = 0;
    const r = await runEvals(
      options({
        concurrency: 1,
        client: {
          create: async () => {
            calls++;
            throw new Error("400 bad parameter");
          },
        },
      }),
    );
    expect(r.runs).toEqual([]);
    expect(r.aborted).toMatch(/scenario 1 \(structured\) failed: 400 bad parameter/);
    expect(calls).toBe(1);
  }, 60_000);
});
