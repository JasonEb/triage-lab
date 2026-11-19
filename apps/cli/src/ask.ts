import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULTS,
  runAgent,
  type AgentEvent,
  type AgentResult,
  type Effort,
  type MessagesClient,
} from "@triage/agent";
import { redactText, type RedactOptions } from "@triage/logger";
import { SYNTHETIC_FIRST_NAMES, SYNTHETIC_LAST_NAMES } from "@triage/sim";
import { LogStore, type Style } from "@triage/store";
import type { IO } from "./cli.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

/**
 * Redaction for anything shown to the model. Identifier formats and a name
 * dictionary are platform configuration; here they describe the synthetic
 * data. In production the dictionary would come from the patient directory.
 */
export const AGENT_REDACTION: RedactOptions = {
  idPatterns: [/\bpt_\d{5}\b/],
  names: [...SYNTHETIC_FIRST_NAMES, ...SYNTHETIC_LAST_NAMES],
};

export const ASK_USAGE = `  triage ask "<question>" --scenario=<n> [--style=structured|legacy] [--logs=<dir>] [--json] [--verbose]
              [--max-steps=<n>] [--max-tokens=<n>] [--effort=low|medium|high|xhigh|max]

  Env: ANTHROPIC_API_KEY (required), TRIAGE_MODEL (default ${DEFAULT_MODEL}), TRIAGE_EFFORT, TRIAGE_MAX_STEPS, TRIAGE_MAX_TOKENS`;

export interface AskDeps {
  client?: MessagesClient;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

const flag = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function findScenarioDir(logsDir: string, scenario: string): string | undefined {
  if (!existsSync(logsDir)) return undefined;
  const dir = readdirSync(logsDir).find((d) => d.startsWith(`scenario-${scenario}-`));
  return dir ? join(logsDir, dir) : undefined;
}

export async function ask(args: string[], io: IO, deps: AskDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const question = args.find((a) => !a.startsWith("--"));
  const scenario = flag(args, "scenario");
  const style = (flag(args, "style") ?? "structured") as Style;
  const logsDir = flag(args, "logs") ?? join(cwd, "logs");
  const effort = (flag(args, "effort") ?? env.TRIAGE_EFFORT ?? DEFAULTS.effort) as Effort;
  const maxSteps = Number(flag(args, "max-steps") ?? env.TRIAGE_MAX_STEPS ?? DEFAULTS.maxSteps);
  const maxTokens = Number(flag(args, "max-tokens") ?? env.TRIAGE_MAX_TOKENS ?? DEFAULTS.maxTokens);
  const model = env.TRIAGE_MODEL || DEFAULT_MODEL;

  const problems = [
    !question && "a question is required",
    !scenario && "--scenario is required",
    style !== "structured" && style !== "legacy" && `unknown style: ${style}`,
    !["low", "medium", "high", "xhigh", "max"].includes(effort) && `unknown effort: ${effort}`,
    (!Number.isInteger(maxSteps) || maxSteps < 1) && "bad --max-steps",
    (!Number.isInteger(maxTokens) || maxTokens < 1000) && "bad --max-tokens",
  ].filter(Boolean);
  if (problems.length) {
    io.err(`${problems.join("; ")}\n\nUsage:\n${ASK_USAGE}`);
    return 2;
  }

  const dir = findScenarioDir(logsDir, scenario!);
  if (!dir) {
    io.err(
      `No logs for scenario ${scenario} in ${logsDir}. Generate them first:\n  pnpm sim --scenario=${scenario}`,
    );
    return 2;
  }

  let client = deps.client;
  if (!client) {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      io.err(
        "ANTHROPIC_API_KEY is not set. Put it in a git-ignored .env (see .env.example) or export it.",
      );
      return 2;
    }
    client = new Anthropic().beta.messages;
  }

  const store = LogStore.fromScenarioDir(dir, style);
  const verbose = args.includes("--verbose");
  const onEvent = (e: AgentEvent) => {
    if (!verbose) return;
    if (e.type === "model_call")
      io.err(`· step ${e.step} (${e.tokensSoFar.toLocaleString("en-US")} tokens so far)`);
    if (e.type === "tool_call")
      io.err(
        `  → ${e.name} ${JSON.stringify(e.input)} ${e.ok ? `(${e.lineIds} lines)` : "(error)"}`,
      );
    if (e.type === "warning") io.err(`  ! ${e.message}`);
  };

  if (!args.includes("--json")) io.err(`Investigating ${dir} (${style}) with ${model}...`);
  let result: AgentResult;
  try {
    result = await runAgent({
      client,
      model,
      question: question!,
      store,
      runbooksDir: join(cwd, "docs", "runbooks"),
      redact: AGENT_REDACTION,
      maxSteps,
      maxTokens,
      effort,
      onEvent,
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError)
      io.err("The Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.");
    else if (err instanceof Anthropic.RateLimitError)
      io.err("Rate limited by the Claude API (429). Try again shortly.");
    else if (err instanceof Anthropic.APIError)
      io.err(`Claude API error ${err.status}: ${err.message}`);
    else throw err;
    store.close();
    return 1;
  }

  io.out(
    args.includes("--json")
      ? JSON.stringify({ ...result, scenarioDir: dir, style }, null, 2)
      : format(result, store),
  );
  store.close();
  return result.outcome === "diagnosed" ? 0 : 1;
}

export function format(r: AgentResult, store: LogStore): string {
  const d = r.diagnosis;
  const rc = d.suspectedRootCause;
  const out: string[] = [];
  out.push(
    `Diagnosis (${d.confidence} confidence): ${rc.category}${rc.service ? ` in ${rc.service}` : ""}`,
  );
  out.push("", d.summary, "", `Root cause: ${rc.description}`);
  if (d.evidence.length) {
    out.push("", "Evidence:");
    const lines = new Map(store.getLines(d.evidence.map((e) => e.lineId)).map((l) => [l.id, l]));
    for (const e of d.evidence) {
      const l = lines.get(e.lineId);
      if (!l) continue;
      out.push(
        `  [L${l.id}] ${l.ts ?? "?"} ${l.service} ${l.level ?? "?"}${l.event ? ` ${l.event}` : ""}: ${e.reason}`,
      );
      out.push(`          ${redactText(l.text.split("\n")[0]!, AGENT_REDACTION).slice(0, 160)}`);
    }
  }
  if (d.suggestedNextSteps.length) {
    out.push("", "Suggested next steps:");
    d.suggestedNextSteps.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
  }
  if (d.runbook) out.push("", `Runbook: docs/runbooks/${d.runbook}.md`);
  const u = r.usage;
  out.push(
    "",
    `— ${r.outcome} · ${r.model} · ${r.steps} steps · ${r.toolCalls.length} tool calls · ` +
      `${u.total.toLocaleString("en-US")} tokens (${u.cacheReadTokens.toLocaleString("en-US")} cache reads) · ${(r.wallMs / 1000).toFixed(1)}s`,
  );
  for (const w of r.warnings) out.push(`  warning: ${w}`);
  return out.join("\n");
}
