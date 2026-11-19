import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runAgent,
  type AgentResult,
  type Effort,
  type MessagesClient,
  type Usage,
} from "@triage/agent";
import { defaultSeed, getScenario, runSimCli, SYNTHETIC_REDACTION } from "@triage/sim";
import { LogStore, type Style } from "@triage/store";
import { BudgetExceededError, type CostMeter } from "./cost.js";
import { scoreDiagnosis, type Score } from "./score.js";

export interface RunRecord {
  scenario: number;
  slug: string;
  style: Style;
  repeat: number;
  outcome: AgentResult["outcome"];
  category: string;
  service: string;
  confidence: string;
  evidenceIds: number[];
  score: Score;
  steps: number;
  toolCalls: number;
  usage: Usage;
  costUsd: number;
  wallMs: number;
  warnings: number;
  summary: string;
}

export interface EvalOptions {
  client: MessagesClient;
  meter: CostMeter;
  model: string;
  effort: Effort;
  maxSteps: number;
  maxTokens: number;
  scenarios: number[];
  styles: Style[];
  repeats: number;
  /** Where simulated logs live (generated if missing). */
  logsDir: string;
  runbooksDir: string;
  concurrency: number;
  onRun?: (r: RunRecord, done: number, total: number) => void;
}

export interface EvalOutcome {
  runs: RunRecord[];
  planned: number;
  /** Why the eval stopped early, if it did. Completed runs are kept. */
  aborted?: string;
}

/** Generate a scenario's logs unless they are already there with the default seed. */
export async function ensureLogs(logsDir: string, scenarioId: number): Promise<string> {
  const s = getScenario(scenarioId);
  const dir = join(logsDir, `scenario-${s.id}-${s.slug}`);
  const gtFile = join(dir, "ground-truth.json");
  const fresh =
    existsSync(gtFile) &&
    (JSON.parse(readFileSync(gtFile, "utf8")) as { seed: number }).seed === defaultSeed(s.id);
  if (!fresh) {
    const code = await runSimCli([`--scenario=${s.id}`, `--out=${logsDir}`], {
      out: () => {},
      err: () => {},
    });
    if (code !== 0) throw new Error(`pnpm sim failed for scenario ${s.id}`);
  }
  return dir;
}

/**
 * Run every scenario x style `repeats` times. Jobs are ordered repeat-first,
 * so if the cost cap stops the eval early, every case has the same number of
 * completed runs (give or take one round). Any error stops the whole eval:
 * an API error is likely to repeat, and retrying blindly costs money.
 */
export async function runEvals(o: EvalOptions): Promise<EvalOutcome> {
  const stores = new Map<string, LogStore>();
  for (const id of o.scenarios) {
    const dir = await ensureLogs(o.logsDir, id);
    for (const style of o.styles)
      stores.set(`${id}/${style}`, LogStore.fromScenarioDir(dir, style));
  }

  const jobs: { scenario: number; style: Style; repeat: number }[] = [];
  for (let repeat = 1; repeat <= o.repeats; repeat++)
    for (const scenario of o.scenarios)
      for (const style of o.styles) jobs.push({ scenario, style, repeat });

  const runs: RunRecord[] = [];
  let aborted: string | undefined;
  let next = 0;

  const worker = async () => {
    while (aborted === undefined && next < jobs.length) {
      const job = jobs[next++]!;
      const s = getScenario(job.scenario);
      const store = stores.get(`${job.scenario}/${job.style}`)!;
      const metered = o.meter.meter(o.client);
      try {
        const r = await runAgent({
          client: metered.client,
          model: o.model,
          question: s.question,
          store,
          runbooksDir: o.runbooksDir,
          redact: SYNTHETIC_REDACTION,
          maxSteps: o.maxSteps,
          maxTokens: o.maxTokens,
          effort: o.effort,
        });
        const d = r.diagnosis;
        const record: RunRecord = {
          scenario: s.id,
          slug: s.slug,
          style: job.style,
          repeat: job.repeat,
          outcome: r.outcome,
          category: d.suspectedRootCause.category,
          service: d.suspectedRootCause.service,
          confidence: d.confidence,
          evidenceIds: d.evidence.map((e) => e.lineId),
          score: scoreDiagnosis(d, s.groundTruth, store),
          steps: r.steps,
          toolCalls: r.toolCalls.length,
          usage: r.usage,
          costUsd: metered.spent(),
          wallMs: r.wallMs,
          warnings: r.warnings.length,
          summary: d.summary,
        };
        runs.push(record);
        o.onRun?.(record, runs.length, jobs.length);
      } catch (err) {
        aborted ??=
          err instanceof BudgetExceededError
            ? err.message
            : `scenario ${job.scenario} (${job.style}) failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  for (const store of stores.values()) store.close();

  runs.sort(
    (a, b) => a.repeat - b.repeat || a.scenario - b.scenario || a.style.localeCompare(b.style),
  );
  return { runs, planned: jobs.length, ...(aborted !== undefined ? { aborted } : {}) };
}
