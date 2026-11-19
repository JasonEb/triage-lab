import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createClient,
  DEFAULT_MODEL,
  DEFAULTS,
  type Effort,
  type MessagesClient,
} from "@triage/agent";
import { SCENARIOS } from "@triage/sim";
import type { Style } from "@triage/store";
import { CostMeter, priceFor, type Price } from "./cost.js";
import { fakeClient } from "./fake.js";
import { renderReport, type EvalMeta, type EvalResults } from "./report.js";
import { runEvals, type RunRecord } from "./runner.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface EvalsDeps {
  client?: MessagesClient;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export const DEFAULT_MAX_COST_USD = 1;

export const USAGE = `Usage:
  pnpm evals [--repeats=<n>] [--scenarios=<1,2,..|all>] [--styles=structured,legacy]
             [--max-cost=<usd>] [--estimate=<usd>] [--concurrency=<n>]
             [--max-steps=<n>] [--max-tokens=<n>] [--out=<dir>] [--logs=<dir>]
  pnpm evals --fake          # whole pipeline with a scripted client: no key, no cost
  pnpm evals --report-only   # re-render the report from <out>/eval-results.json

Runs the agent on every scenario x log style, scores it against ground truth,
and writes <out>/eval-report.md and <out>/eval-results.json (default out: docs/).

Cost: every API call is priced and the run stops once spend reaches the cap.
The cap is --max-cost, else 2 x --estimate, else TRIAGE_EVAL_MAX_COST, else $${DEFAULT_MAX_COST_USD}.

Env: TRIAGE_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY, TRIAGE_MODEL (default ${DEFAULT_MODEL}), TRIAGE_EFFORT`;

const flag = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export async function runEvalsCli(args: string[], io: IO, deps: EvalsDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  if (args.includes("--help")) {
    io.out(USAGE);
    return 0;
  }
  const fake = args.includes("--fake");
  const outDir = flag(args, "out") ?? join(cwd, fake ? "logs/evals-fake" : "docs");
  const resultsFile = join(outDir, "eval-results.json");
  const reportFile = join(outDir, "eval-report.md");

  const writeReport = (results: EvalResults) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resultsFile, JSON.stringify(results, null, 2) + "\n");
    const previous = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : undefined;
    writeFileSync(reportFile, renderReport(results, previous));
  };

  if (args.includes("--report-only")) {
    if (!existsSync(resultsFile)) {
      io.err(`No results at ${resultsFile}. Run pnpm evals first.`);
      return 2;
    }
    writeReport(JSON.parse(readFileSync(resultsFile, "utf8")) as EvalResults);
    io.out(`Wrote ${reportFile}`);
    return 0;
  }

  const scenariosArg = flag(args, "scenarios") ?? "all";
  const scenarios =
    scenariosArg === "all" ? SCENARIOS.map((s) => s.id) : scenariosArg.split(",").map(Number);
  const styles = (flag(args, "styles") ?? "structured,legacy").split(",") as Style[];
  const repeats = Number(flag(args, "repeats") ?? 3);
  const concurrency = Number(flag(args, "concurrency") ?? 3);
  const maxSteps = Number(flag(args, "max-steps") ?? env.TRIAGE_MAX_STEPS ?? DEFAULTS.maxSteps);
  const maxTokens = Number(flag(args, "max-tokens") ?? env.TRIAGE_MAX_TOKENS ?? DEFAULTS.maxTokens);
  const model = env.TRIAGE_MODEL || DEFAULT_MODEL;
  const effort = (env.TRIAGE_EFFORT || DEFAULTS.effort) as Effort;
  const estimateArg = flag(args, "estimate");
  const estimateUsd = estimateArg === undefined ? undefined : Number(estimateArg);
  const capUsd = Number(
    flag(args, "max-cost") ??
      (estimateUsd !== undefined ? 2 * estimateUsd : undefined) ??
      env.TRIAGE_EVAL_MAX_COST ??
      DEFAULT_MAX_COST_USD,
  );

  let price: Price | undefined;
  let priceError: string | undefined;
  try {
    price = priceFor(model);
  } catch (e) {
    priceError = (e as Error).message;
  }

  const problems = [
    scenarios.some((id) => !SCENARIOS.some((s) => s.id === id)) &&
      `unknown scenario in ${scenariosArg}`,
    styles.some((s) => s !== "structured" && s !== "legacy") && `bad --styles`,
    (!Number.isInteger(repeats) || repeats < 1) && "bad --repeats",
    (!Number.isInteger(concurrency) || concurrency < 1) && "bad --concurrency",
    (!Number.isInteger(maxSteps) || maxSteps < 1) && "bad --max-steps",
    (!Number.isInteger(maxTokens) || maxTokens < 1000) && "bad --max-tokens",
    estimateUsd !== undefined && !(estimateUsd > 0) && "bad --estimate",
    !(capUsd > 0) && "bad --max-cost",
    !["low", "medium", "high", "xhigh", "max"].includes(effort) && `unknown effort: ${effort}`,
    priceError,
  ].filter(Boolean);
  if (problems.length) {
    io.err(`${problems.join("; ")}\n\n${USAGE}`);
    return 2;
  }

  let client = deps.client;
  if (!client && fake) client = fakeClient();
  if (!client) {
    const made = createClient(env);
    if ("error" in made) {
      io.err(made.error);
      return 2;
    }
    client = made.client.beta.messages;
  }

  const planned = scenarios.length * styles.length * repeats;
  io.err(
    `Evals: ${scenarios.length} scenarios x ${styles.length} styles x ${repeats} repeats = ${planned} runs` +
      ` on ${fake ? "the fake client" : model} (effort ${effort})` +
      `${estimateUsd !== undefined ? `, estimate $${estimateUsd.toFixed(4)}` : ""}, cost cap $${capUsd.toFixed(4)}`,
  );

  const meter = new CostMeter(price!, capUsd);
  const started = Date.now();
  const runs: RunRecord[] = [];
  const meta = (): EvalMeta => ({
    generatedAt: new Date().toISOString(),
    model,
    effort,
    maxSteps,
    maxTokens,
    repeats,
    scenarios,
    styles,
    concurrency,
    ...(estimateUsd !== undefined ? { estimateUsd } : {}),
    capUsd,
    spentUsd: meter.spentUsd,
    apiCalls: meter.calls,
    planned,
    wallSeconds: (Date.now() - started) / 1000,
    ...(fake ? { fake } : {}),
  });

  const result = await runEvals({
    client,
    meter,
    model,
    effort,
    maxSteps,
    maxTokens,
    scenarios,
    styles,
    repeats,
    concurrency,
    logsDir: flag(args, "logs") ?? join(cwd, "logs"),
    runbooksDir: join(cwd, "docs", "runbooks"),
    onRun: (r, done, total) => {
      runs.push(r);
      const s = r.score;
      io.err(
        `  [${done}/${total}] #${r.scenario} ${r.style.padEnd(10)} rep ${r.repeat}: ` +
          `${r.outcome === "diagnosed" ? `${r.category}/${r.service || "?"}` : r.outcome} ` +
          `cat=${s.category} svc=${s.service} ev=${s.evidence} · ${r.steps} steps · ` +
          `${r.usage.total.toLocaleString("en-US")} tok · $${r.costUsd.toFixed(4)} · total $${meter.spentUsd.toFixed(4)}`,
      );
      // Save as we go, so an interrupted run keeps what it paid for.
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resultsFile, JSON.stringify({ meta: meta(), runs }, null, 2) + "\n");
    },
  });

  const results: EvalResults = {
    meta: { ...meta(), ...(result.aborted ? { aborted: result.aborted } : {}) },
    runs: result.runs,
  };
  writeReport(results);
  io.out(
    `${result.runs.length}/${planned} runs · ${meter.calls} API calls · $${meter.spentUsd.toFixed(4)} · ${results.meta.wallSeconds.toFixed(0)}s\nWrote ${reportFile} and ${resultsFile}`,
  );
  if (result.aborted) {
    io.err(`Stopped early: ${result.aborted}`);
    return 1;
  }
  return 0;
}
