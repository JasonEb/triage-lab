import type Anthropic from "@anthropic-ai/sdk";
import type { RedactOptions } from "@triage/logger";
import type { LogStore } from "@triage/store";
import { DiagnosisSchema, insufficientData, type Diagnosis } from "./diagnosis.js";
import { initialMessage, SYSTEM_PROMPT } from "./prompt.js";
import { executeTool, isReadTool, TOOL_DEFINITIONS } from "./tools.js";

type Message = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam;

/** The one SDK call the agent makes. `new Anthropic().beta.messages` satisfies it; tests pass a fake. */
export interface MessagesClient {
  create(params: CreateParams): Promise<Message>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AgentOptions {
  client: MessagesClient;
  model: string;
  question: string;
  store: LogStore;
  runbooksDir?: string | undefined;
  redact?: RedactOptions | undefined;
  /** Model calls allowed (each may run several tools). */
  maxSteps?: number;
  /** Total tokens (input incl. cache reads/writes, plus output) across the run. */
  maxTokens?: number;
  effort?: Effort;
  /** Server-side refusal fallback, on by default where the model supports it. */
  fallbacks?: boolean;
  onEvent?: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "model_call"; step: number; tokensSoFar: number }
  | {
      type: "tool_call";
      step: number;
      name: string;
      input: unknown;
      ok: boolean;
      ms: number;
      lineIds: number;
    }
  | { type: "warning"; message: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  total: number;
}

export interface AgentResult {
  outcome: "diagnosed" | "budget_exhausted" | "refused" | "no_diagnosis";
  diagnosis: Diagnosis;
  steps: number;
  toolCalls: { name: string; input: unknown; ok: boolean }[];
  usage: Usage;
  warnings: string[];
  wallMs: number;
  model: string;
}

export const DEFAULTS = { maxSteps: 15, maxTokens: 500_000, effort: "medium" as Effort };

/**
 * A manual tool-use loop: call the model, run the read-only tools it asks for,
 * feed results back, until it calls submit_diagnosis or a budget runs out.
 * Kept manual (rather than the SDK tool runner) so the step and token budgets,
 * redaction, and the evidence check are explicit and testable without the API.
 */
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const started = Date.now();
  const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
  const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
  const useFallbacks = (opts.fallbacks ?? true) && FALLBACK_MODELS.has(opts.model);
  const emit = opts.onEvent ?? (() => {});
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    emit({ type: "warning", message });
  };

  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    total: 0,
  };
  const seen = new Set<number>();
  const toolCalls: AgentResult["toolCalls"] = [];
  const messages: MessageParam[] = [
    { role: "user", content: initialMessage(opts.store, opts.question) },
  ];

  const finish = (
    outcome: AgentResult["outcome"],
    diagnosis: Diagnosis,
    steps: number,
  ): AgentResult => ({
    outcome,
    diagnosis:
      outcome === "diagnosed" ? checkEvidence(diagnosis, seen, opts.store, warn) : diagnosis,
    steps,
    toolCalls,
    usage,
    warnings,
    wallMs: Date.now() - started,
    model: opts.model,
  });

  for (let step = 1; step <= maxSteps; step++) {
    // Last call: tell the model to wrap up (forced tool_choice isn't available on current models).
    const last = step === maxSteps || usage.total > maxTokens * 0.8;
    if (last)
      appendToLastUser(
        messages,
        "Budget almost exhausted. Call submit_diagnosis now with what you have; use insufficient_data if needed.",
      );

    emit({ type: "model_call", step, tokensSoFar: usage.total });
    const response = await opts.client.create({
      model: opts.model,
      max_tokens: 16_000,
      system: [{ type: "text", text: SYSTEM_PROMPT }],
      tools: TOOL_DEFINITIONS,
      messages,
      output_config: { effort: opts.effort ?? DEFAULTS.effort },
      cache_control: { type: "ephemeral" },
      ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    });
    addUsage(usage, response.usage);

    if (response.stop_reason === "refusal") {
      return finish(
        "refused",
        insufficientData(
          `the model declined (${response.stop_details?.category ?? "no category"})`,
        ),
        step,
      );
    }

    // Append the whole content (thinking blocks included) so the history stays append-only.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) {
      if (response.stop_reason === "max_tokens") warn(`Step ${step}: response hit max_tokens.`);
      messages.push({
        role: "user",
        content: "Please continue the investigation, and call submit_diagnosis when you are done.",
      });
      continue;
    }

    const results: ToolResult[] = [];
    let diagnosis: Diagnosis | undefined;
    for (const use of toolUses) {
      const t0 = Date.now();
      if (use.name === "submit_diagnosis") {
        const parsed = DiagnosisSchema.safeParse(use.input);
        if (parsed.success) diagnosis = parsed.data;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: parsed.success
            ? "Diagnosis recorded."
            : `Invalid diagnosis: ${parsed.error.message}`,
          ...(parsed.success ? {} : { is_error: true }),
        });
        toolCalls.push({ name: use.name, input: use.input, ok: parsed.success });
        continue;
      }
      if (!isReadTool(use.name)) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Unknown tool: ${use.name}`,
          is_error: true,
        });
        toolCalls.push({ name: use.name, input: use.input, ok: false });
        continue;
      }
      try {
        const out = executeTool(use.name, use.input, {
          store: opts.store,
          runbooksDir: opts.runbooksDir,
          redact: opts.redact,
        });
        out.lineIds.forEach((id) => seen.add(id));
        results.push({ type: "tool_result", tool_use_id: use.id, content: out.content });
        toolCalls.push({ name: use.name, input: use.input, ok: true });
        emit({
          type: "tool_call",
          step,
          name: use.name,
          input: use.input,
          ok: true,
          ms: Date.now() - t0,
          lineIds: out.lineIds.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: `Error: ${msg.slice(0, 500)}`,
          is_error: true,
        });
        toolCalls.push({ name: use.name, input: use.input, ok: false });
        emit({
          type: "tool_call",
          step,
          name: use.name,
          input: use.input,
          ok: false,
          ms: Date.now() - t0,
          lineIds: 0,
        });
      }
    }

    if (diagnosis) return finish("diagnosed", diagnosis, step);

    // Every tool_use gets its tool_result, all in one user message.
    messages.push({ role: "user", content: results });

    if (usage.total >= maxTokens) {
      return finish(
        "budget_exhausted",
        insufficientData(`token budget of ${maxTokens} exhausted after ${step} steps`),
        step,
      );
    }
  }
  return finish(
    "budget_exhausted",
    insufficientData(`step budget of ${maxSteps} exhausted without a diagnosis`),
    maxSteps,
  );
}

function addUsage(u: Usage, r: Message["usage"]): void {
  u.inputTokens += r.input_tokens;
  u.outputTokens += r.output_tokens;
  u.cacheReadTokens += r.cache_read_input_tokens ?? 0;
  u.cacheWriteTokens += r.cache_creation_input_tokens ?? 0;
  u.total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

function appendToLastUser(messages: MessageParam[], text: string): void {
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    messages.push({ role: "user", content: text });
    return;
  }
  const content: ContentParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  content.push({ type: "text", text });
  last.content = content;
}

/**
 * Never trust a citation the model could not have seen: drop evidence IDs
 * that no tool returned. With no valid evidence left, confidence drops to low.
 */
function checkEvidence(
  d: Diagnosis,
  seen: Set<number>,
  store: LogStore,
  warn: (m: string) => void,
): Diagnosis {
  const known = new Set(store.getLines(d.evidence.map((e) => e.lineId)).map((r) => r.id));
  const evidence = d.evidence.filter((e) => {
    const ok = seen.has(e.lineId) && known.has(e.lineId);
    if (!ok) warn(`Dropped evidence line ${e.lineId}: not returned by any tool in this run.`);
    return ok;
  });
  const unsupported =
    evidence.length === 0 && d.suspectedRootCause.category !== "insufficient_data";
  if (unsupported && d.confidence !== "low")
    warn("No valid evidence cited; confidence lowered to low.");
  return { ...d, evidence, confidence: unsupported ? "low" : d.confidence };
}
