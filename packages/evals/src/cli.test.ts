import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvalsCli } from "./cli.js";
import { ANALYSIS_END, ANALYSIS_START, stats, type EvalResults } from "./report.js";

const cwd = join(import.meta.dirname, "../../..");
const logs = mkdtempSync(join(tmpdir(), "evals-cli-logs-"));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const base = (out: string) => [
  "--fake",
  "--scenarios=1,2",
  "--repeats=2",
  `--out=${out}`,
  `--logs=${logs}`,
];
const env = { TRIAGE_MODEL: "claude-haiku-5-5", TRIAGE_EFFORT: "low" };

describe("stats", () => {
  it("reports mean, sample standard deviation and range", () => {
    expect(stats([1, 0, 1, 1])).toMatchObject({ mean: 0.75, min: 0, max: 1, n: 4 });
    expect(stats([1, 0, 1, 1]).sd).toBeCloseTo(0.5);
    expect(stats([5]).sd).toBe(0);
  });
});

describe("pnpm evals", () => {
  it("runs the whole pipeline on the fake client and writes report + results", async () => {
    const out = mkdtempSync(join(tmpdir(), "evals-cli-"));
    const t = io();
    expect(await runEvalsCli([...base(out), "--estimate=0.01"], t.io, { env, cwd })).toBe(0);

    const results = JSON.parse(readFileSync(join(out, "eval-results.json"), "utf8")) as EvalResults;
    expect(results.runs).toHaveLength(8);
    expect(results.meta).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "low",
      fake: true,
      estimateUsd: 0.01,
      capUsd: 0.02,
      planned: 8,
      apiCalls: 16,
    });
    const report = readFileSync(join(out, "eval-report.md"), "utf8");
    expect(report).toContain("Fake client run");
    expect(report).toMatch(/\| structured \| 4 \| 50% ± 0% \|/);
    expect(report).toContain(
      "| 1 | Pharmacy partner API returns 5xx | structured | 2/2 | 2/2 | 2/2 |",
    );
    expect(t.err[0]).toMatch(/2 scenarios x 2 styles x 2 repeats = 8 runs/);
  }, 60_000);

  it("keeps the hand-written analysis when the report is regenerated", async () => {
    const out = mkdtempSync(join(tmpdir(), "evals-cli-"));
    await runEvalsCli(base(out), io().io, { env, cwd });
    const file = join(out, "eval-report.md");
    const edited = readFileSync(file, "utf8").replace(
      /<!-- analysis:start -->[\s\S]*<!-- analysis:end -->/,
      `${ANALYSIS_START}\nStructured logs won.\n${ANALYSIS_END}`,
    );
    writeFileSync(file, edited);

    expect(await runEvalsCli([`--out=${out}`, "--report-only"], io().io, { env, cwd })).toBe(0);
    expect(readFileSync(file, "utf8")).toContain(`${ANALYSIS_START}\nStructured logs won.\n`);
  }, 60_000);

  it("stops at the cost cap and says so in the report", async () => {
    const out = mkdtempSync(join(tmpdir(), "evals-cli-"));
    const t = io();
    const code = await runEvalsCli([...base(out), "--max-cost=0.001", "--concurrency=1"], t.io, {
      env,
      cwd,
    });
    expect(code).toBe(1);
    expect(t.err.at(-1)).toMatch(/Stopped early: .*reached the cap/);
    const results = JSON.parse(readFileSync(join(out, "eval-results.json"), "utf8")) as EvalResults;
    expect(results.meta.aborted).toMatch(/reached the cap/);
    expect(results.runs.length).toBeLessThan(8);
    expect(readFileSync(join(out, "eval-report.md"), "utf8")).toContain("Stopped early");
  }, 60_000);

  it("refuses a model with no known price, so the cap can't be bypassed", async () => {
    const t = io();
    expect(
      await runEvalsCli(base(mkdtempSync(join(tmpdir(), "e-"))), t.io, {
        env: { TRIAGE_MODEL: "claude-unknown" },
        cwd,
      }),
    ).toBe(2);
    expect(t.err[0]).toMatch(/No price for model claude-unknown/);
  });

  it("needs an API key for a live run, and ignores the host's ANTHROPIC_AUTH_TOKEN", async () => {
    const t = io();
    const args = base(mkdtempSync(join(tmpdir(), "e-"))).filter((a) => a !== "--fake");
    expect(await runEvalsCli(args, t.io, { env: { ...env, ANTHROPIC_AUTH_TOKEN: "x" }, cwd })).toBe(
      2,
    );
    expect(t.err[0]).toMatch(/No API key/);
  });

  it("rejects bad arguments", async () => {
    const t = io();
    expect(await runEvalsCli(["--scenarios=9", "--repeats=0"], t.io, { env, cwd })).toBe(2);
    expect(t.err[0]).toMatch(/unknown scenario.*bad --repeats/);
  });
});
