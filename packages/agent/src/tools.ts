import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { LOG_LEVELS, redactText, type RedactOptions } from "@triage/logger";
import type { LogRow, LogStore } from "@triage/store";
import { z } from "zod";
import { DIAGNOSIS_JSON_SCHEMA } from "./diagnosis.js";

type Tool = Anthropic.Beta.Messages.BetaTool;

const iso = z.string().describe("ISO 8601 UTC timestamp, e.g. 2026-11-18T14:00:00Z");
const window = { from: iso.optional(), to: iso.optional() };
const level = z.enum(LOG_LEVELS);

/** Input schemas, validated in the loop before any tool runs. */
export const TOOL_INPUTS = {
  search_logs: z.strictObject({
    query: z.string().optional(),
    service: z.string().optional(),
    level: level.optional(),
    event: z.string().optional(),
    ...window,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  get_trace: z
    .strictObject({ correlationId: z.string().optional(), requestId: z.string().optional() })
    .refine((v) => v.correlationId || v.requestId, "Provide correlationId or requestId"),
  error_clusters: z.strictObject({
    ...window,
    service: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  timeline: z.strictObject({
    ...window,
    service: z.string().optional(),
    level: level.optional(),
    bucketMinutes: z.number().int().min(1).max(240).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  }),
  recent_deploys: z.strictObject({ ...window, service: z.string().optional() }),
  get_runbook: z.strictObject({ topic: z.string().min(1) }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

const windowProps = {
  from: { type: "string", description: "Start of window, ISO 8601 UTC" },
  to: { type: "string", description: "End of window, ISO 8601 UTC" },
};

/** Tool definitions sent to the model. Fixed order keeps the prompt cache stable. */
export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "search_logs",
    description:
      "Full-text search over log lines, oldest first, with optional filters. Returns matching lines with their IDs and the total match count. Use `event` for an exact event name when the logs have event names.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Words to match (ANDed). Omit to list lines by filters only.",
        },
        service: { type: "string" },
        level: { type: "string", enum: [...LOG_LEVELS] },
        event: { type: "string", description: "Exact event name, e.g. rx.refill.failed" },
        ...windowProps,
        limit: { type: "integer", description: "Max lines to return (default 30, max 100)" },
      },
    },
  },
  {
    name: "get_trace",
    description:
      "All log lines for one request across services, in time order. Prefer correlationId (follows a request across async hops); requestId covers a single invocation.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { correlationId: { type: "string" }, requestId: { type: "string" } },
    },
  },
  {
    name: "error_clusters",
    description:
      "Warn and error lines grouped into clusters of the same kind (fingerprint), most frequent first, with counts, first/last seen, and a sample line ID. Compare a window before the incident with one after to see what is new.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { ...windowProps, service: { type: "string" }, limit: { type: "integer" } },
    },
  },
  {
    name: "timeline",
    description:
      "Counts per log pattern per time bucket, for all levels (not just errors). Use it to see what increased, appeared, or stopped happening. Silent failures show up as a pattern whose count drops to zero.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...windowProps,
        service: { type: "string" },
        level: { type: "string", enum: [...LOG_LEVELS] },
        bucketMinutes: { type: "integer", description: "Bucket size in minutes (default 10)" },
        limit: { type: "integer", description: "Max patterns (default 20, max 40)" },
      },
    },
  },
  {
    name: "recent_deploys",
    description: "Deploys in a time window: time, service, version, commit and description.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: { ...windowProps, service: { type: "string" } },
    },
  },
  {
    name: "get_runbook",
    description:
      "Fetch an operational runbook by topic. An unknown topic returns the list of available runbooks.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: { topic: { type: "string" } },
    },
  },
  {
    name: "submit_diagnosis",
    description:
      "Submit your final diagnosis. Call this exactly once, when you are done investigating. Cite evidence by line IDs returned by the other tools. Use category insufficient_data if the logs do not support a conclusion.",
    strict: true,
    input_schema: DIAGNOSIS_JSON_SCHEMA as unknown as Tool["input_schema"],
  },
];

export interface ToolContext {
  store: LogStore;
  runbooksDir?: string | undefined;
  redact?: RedactOptions | undefined;
}

export interface ToolOutput {
  content: string;
  /** Log line IDs this output showed the model (the only IDs it may cite). */
  lineIds: number[];
}

const MAX_TEXT = 400;
const MAX_OUTPUT_CHARS = 24_000;

function clip(text: string, max = MAX_TEXT): string {
  const lines = text.split("\n");
  const head =
    lines.length > 4
      ? [...lines.slice(0, 4), `  ... (${lines.length - 4} more lines)`].join("\n")
      : text;
  return head.length > max ? head.slice(0, max) + "…" : head;
}

/** Redact free-text fields only; timestamps, IDs and enums are structural and safe. */
function presentRow(r: LogRow, redact: RedactOptions | undefined) {
  return {
    id: r.id,
    ts: r.ts,
    service: r.service,
    level: r.level,
    ...(r.event ? { event: r.event } : {}),
    ...(r.correlationId ? { correlationId: r.correlationId } : {}),
    ...(r.requestId ? { requestId: r.requestId } : {}),
    ...(r.errorType ? { errorType: r.errorType, errorCode: r.errorCode } : {}),
    text: redactText(clip(r.text), redact),
  };
}

function runbooks(dir: string | undefined): { topic: string; title: string; path: string }[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      const title = readFileSync(path, "utf8").split("\n")[0]!.replace(/^#\s*/, "");
      return { topic: basename(f, ".md"), title, path };
    });
}

function findRunbook(dir: string | undefined, topic: string) {
  const all = runbooks(dir);
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  const scored = all
    .map((r) => ({
      r,
      score: words.filter((w) => `${r.topic} ${r.title}`.toLowerCase().includes(w)).length,
    }))
    .sort((a, b) => b.score - a.score);
  const exact = all.find((r) => r.topic === topic);
  return { match: exact ?? (scored[0]?.score ? scored[0].r : undefined), all };
}

/** Run one read-only tool. Throws on bad input; the loop turns that into an is_error result. */
export function executeTool(name: ToolName, rawInput: unknown, ctx: ToolContext): ToolOutput {
  const { store, redact } = ctx;
  const lineIds: number[] = [];
  let result: unknown;

  switch (name) {
    case "search_logs": {
      const input = TOOL_INPUTS.search_logs.parse(rawInput);
      const r = store.searchLogs(input);
      lineIds.push(...r.rows.map((x) => x.id));
      result = {
        total: r.total,
        returned: r.rows.length,
        lines: r.rows.map((x) => presentRow(x, redact)),
      };
      break;
    }
    case "get_trace": {
      const input = TOOL_INPUTS.get_trace.parse(rawInput);
      const rows = store.getTrace(input);
      lineIds.push(...rows.map((x) => x.id));
      result = rows.length
        ? { lines: rows.map((x) => presentRow(x, redact)) }
        : { lines: [], note: "No lines carry this ID." };
      break;
    }
    case "error_clusters": {
      const input = TOOL_INPUTS.error_clusters.parse(rawInput);
      const clusters = store
        .errorClusters(input)
        .map((c) => ({ ...c, pattern: redactText(c.pattern, redact) }));
      lineIds.push(...clusters.map((c) => c.sampleLineId));
      result = { clusters };
      break;
    }
    case "timeline": {
      const input = TOOL_INPUTS.timeline.parse(rawInput);
      const t = store.timeline(input);
      lineIds.push(...t.patterns.map((p) => p.sampleLineId));
      result = {
        ...t,
        patterns: t.patterns.map((p) => ({ ...p, pattern: redactText(p.pattern, redact) })),
      };
      break;
    }
    case "recent_deploys": {
      const input = TOOL_INPUTS.recent_deploys.parse(rawInput);
      result = {
        deploys: store
          .recentDeploys(input)
          .map((d) => ({ ...d, description: redactText(d.description, redact) })),
      };
      break;
    }
    case "get_runbook": {
      const { topic } = TOOL_INPUTS.get_runbook.parse(rawInput);
      const { match, all } = findRunbook(ctx.runbooksDir, topic);
      result = match
        ? { topic: match.topic, content: readFileSync(match.path, "utf8") }
        : {
            error: `No runbook matches "${topic}".`,
            available: all.map((r) => ({ topic: r.topic, title: r.title })),
          };
      break;
    }
  }

  // Too big? Drop whole lines (never cut JSON mid-way), keeping lineIds in sync
  // with what the model actually sees.
  let content = JSON.stringify(result);
  const r = result as { lines?: { id: number }[]; note?: string };
  if (content.length > MAX_OUTPUT_CHARS && Array.isArray(r.lines)) {
    while (r.lines.length > 1 && JSON.stringify(r).length > MAX_OUTPUT_CHARS) r.lines.pop();
    r.note = `Output truncated to ${r.lines.length} lines; narrow the query or lower the limit.`;
    const shown = new Set(r.lines.map((l) => l.id));
    lineIds.splice(0, lineIds.length, ...lineIds.filter((id) => shown.has(id)));
    content = JSON.stringify(r);
  }
  return { content, lineIds };
}

export const isReadTool = (name: string): name is ToolName => name in TOOL_INPUTS;
