import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  makePatients,
  runSimCli,
  SERVICES,
  SYNTHETIC_FIRST_NAMES,
  SYNTHETIC_LAST_NAMES,
} from "@triage/sim";
import { LogStore } from "@triage/store";
import { beforeAll, describe, expect, it } from "vitest";
import { runAgent, type MessagesClient } from "./agent.js";
import { PLATFORM_SERVICES } from "./diagnosis.js";
import { executeTool, TOOL_DEFINITIONS, type ToolName } from "./tools.js";

type Message = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Block = Record<string, unknown>;

const RUNBOOKS = join(import.meta.dirname, "../../../docs/runbooks");
const REDACT = {
  names: [...SYNTHETIC_FIRST_NAMES, ...SYNTHETIC_LAST_NAMES],
  idPatterns: [/pt_\d{5}/],
};
let structured: LogStore;
let legacy: LogStore;

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), "agent-"));
  await runSimCli(["--scenario=1", `--out=${out}`], { out: () => {}, err: () => {} });
  structured = LogStore.fromScenarioDir(join(out, "scenario-1-pharmacy-5xx"), "structured");
  legacy = LogStore.fromScenarioDir(join(out, "scenario-1-pharmacy-5xx"), "legacy");
}, 60_000);

function msg(content: Block[], stop: string, usage = { input: 1000, output: 200 }): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: stop,
    stop_details:
      stop === "refusal" ? { type: "refusal", category: "cyber", explanation: null } : null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Message;
}
const toolUse = (id: string, name: string, input: unknown): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});
const thinking: Block = { type: "thinking", thinking: "", signature: "sig" };

/** A fake client that replays a script and records every request. */
function scripted(steps: ((p: Params) => Message)[]) {
  const calls: Params[] = [];
  const client: MessagesClient = {
    create: async (p) => {
      calls.push(structuredClone(p));
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
      return step(p);
    },
  };
  return { client, calls };
}

const diagnosis = (lineIds: number[], confidence = "high") => ({
  summary: "pharmacy-a is returning 503s.",
  suspectedRootCause: {
    category: "dependency",
    service: "rx",
    description: "pharmacy-a 503s since 14:00",
  },
  evidence: lineIds.map((lineId) => ({ lineId, reason: "PHARMACY_5XX" })),
  confidence,
  suggestedNextSteps: ["Contact pharmacy-a"],
  runbook: "dependency-outage",
});

/** Line ID shown in the last tool_result the model received. */
function firstSampleId(p: Params): number {
  const last = p.messages.at(-1)!.content as unknown as Block[];
  const result = last.find((b) => b.type === "tool_result")!;
  return (JSON.parse(result.content as string) as { clusters: { sampleLineId: number }[] })
    .clusters[0]!.sampleLineId;
}

describe("runAgent", () => {
  it("runs tools, records a diagnosis, and keeps only evidence the model actually saw", async () => {
    const { client, calls } = scripted([
      () =>
        msg(
          [thinking, toolUse("t1", "error_clusters", { from: "2026-11-18T14:00:00Z" })],
          "tool_use",
        ),
      (p) => msg([toolUse("t2", "submit_diagnosis", diagnosis([firstSampleId(p), 1]))], "tool_use"),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "Rx refills failing since 14:00?",
      store: structured,
    });

    expect(r.outcome).toBe("diagnosed");
    expect(r.steps).toBe(2);
    expect(r.diagnosis.evidence.map((e) => e.lineId)).toEqual([firstSampleId(calls[1]!)]);
    expect(r.warnings).toEqual([expect.stringMatching(/Dropped evidence line 1/)]);
    expect(r.diagnosis.confidence).toBe("high");
    expect(r.usage).toMatchObject({ inputTokens: 2000, outputTokens: 400, total: 2400 });

    const first = calls[0]!;
    expect(first.tools).toHaveLength(TOOL_DEFINITIONS.length);
    expect(first).toMatchObject({
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
    expect(first.messages[0]!.content).toContain("Rx refills failing since 14:00?");
    expect(first.tool_choice).toBeUndefined();
    // History is append-only and keeps the thinking block.
    expect(calls[1]!.messages.slice(0, 1)).toEqual(first.messages);
    expect(calls[1]!.messages[1]).toEqual({
      role: "assistant",
      content: [thinking, expect.objectContaining({ id: "t1" })],
    });
  });

  it("does not send fallbacks for a model that doesn't support them", async () => {
    const { client, calls } = scripted([
      () => msg([toolUse("t", "submit_diagnosis", diagnosis([]))], "tool_use"),
    ]);
    await runAgent({ client, model: "claude-haiku-5-5", question: "?", store: structured });
    expect(calls[0]!.fallbacks).toBeUndefined();
    expect(calls[0]!.betas).toBeUndefined();
  });

  it("returns tool errors to the model instead of crashing", async () => {
    const { client, calls } = scripted([
      () =>
        msg(
          [
            toolUse("a", "search_logs", { from: "2pm" }),
            toolUse("b", "drop_table", {}),
            toolUse("c", "timeline", { bucket: 5 }),
          ],
          "tool_use",
        ),
      () => msg([toolUse("d", "submit_diagnosis", diagnosis([]))], "tool_use"),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
    });
    const results = calls[1]!.messages.at(-1)!.content as unknown as Block[];
    expect(results.map((b) => [b.tool_use_id, b.is_error])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
    expect(String(results[0]!.content)).toMatch(/not a valid ISO timestamp/);
    expect(String(results[1]!.content)).toMatch(/Unknown tool/);
    expect(r.outcome).toBe("diagnosed");
  });

  it("rejects a malformed diagnosis and lets the model fix it", async () => {
    const { client } = scripted([
      () => msg([toolUse("a", "submit_diagnosis", { summary: "x" })], "tool_use"),
      () => msg([toolUse("b", "submit_diagnosis", diagnosis([]))], "tool_use"),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
    });
    expect(r.steps).toBe(2);
    expect(r.toolCalls.map((t) => t.ok)).toEqual([false, true]);
  });

  it("rejects a culprit outside our services, so answers stay comparable", async () => {
    const external = diagnosis([]);
    external.suspectedRootCause.service = "pharmacy-a (external partner)";
    const { client, calls } = scripted([
      () => msg([toolUse("a", "submit_diagnosis", external)], "tool_use"),
      () => msg([toolUse("b", "submit_diagnosis", diagnosis([]))], "tool_use"),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
    });
    expect(r.toolCalls.map((t) => t.ok)).toEqual([false, true]);
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain("Invalid diagnosis");
    expect(r.diagnosis.suspectedRootCause.service).toBe("rx");
  });

  it("lists the same services as the simulator", () => {
    expect([...PLATFORM_SERVICES]).toEqual([...SERVICES]);
  });

  it("lowers confidence when no valid evidence is cited", async () => {
    const { client } = scripted([
      () => msg([toolUse("a", "submit_diagnosis", diagnosis([123456]))], "tool_use"),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
    });
    expect(r.diagnosis).toMatchObject({ evidence: [], confidence: "low" });
  });

  it("stops at the step budget, warning the model on its last call", async () => {
    const { client, calls } = scripted([
      () => msg([toolUse("x", "recent_deploys", {})], "tool_use"),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
      maxSteps: 3,
    });
    expect(r).toMatchObject({
      outcome: "budget_exhausted",
      steps: 3,
      diagnosis: { suspectedRootCause: { category: "insufficient_data" } },
    });
    expect(JSON.stringify(calls[2]!.messages.at(-1))).toContain("Budget almost exhausted");
    expect(JSON.stringify(calls[1]!.messages.at(-1))).not.toContain("Budget almost exhausted");
  });

  it("stops at the token budget", async () => {
    const { client, calls } = scripted([
      () => msg([toolUse("x", "recent_deploys", {})], "tool_use", { input: 60_000, output: 1000 }),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
      maxTokens: 100_000,
    });
    expect(r.outcome).toBe("budget_exhausted");
    expect(calls).toHaveLength(2);
  });

  it("nudges a model that ends its turn without submitting", async () => {
    const { client, calls } = scripted([
      () => msg([{ type: "text", text: "I think it's the pharmacy." }], "end_turn"),
      () => msg([toolUse("a", "submit_diagnosis", diagnosis([]))], "tool_use"),
    ]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
    });
    expect(r.outcome).toBe("diagnosed");
    expect(calls[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: expect.stringContaining("submit_diagnosis"),
    });
  });

  it("reports a refusal as no diagnosis", async () => {
    const { client } = scripted([() => msg([], "refusal")]);
    const r = await runAgent({
      client,
      model: "claude-sonnet-5-5",
      question: "?",
      store: structured,
    });
    expect(r).toMatchObject({
      outcome: "refused",
      diagnosis: { suspectedRootCause: { category: "insufficient_data" } },
    });
  });
});

describe("tools", () => {
  const broad: [ToolName, unknown][] = [
    ["search_logs", { limit: 100 }],
    ["search_logs", { query: "patient", limit: 100 }],
    ["search_logs", { service: "notifications", limit: 100 }],
    ["search_logs", { service: "intake", limit: 100 }],
    ["search_logs", { service: "billing", level: "warn", limit: 100 }],
    ["error_clusters", { limit: 50 }],
    ["timeline", { limit: 40 }],
    ["recent_deploys", {}],
  ];
  const patients = makePatients(600);
  const leaks = (text: string) => [
    ...(text.match(/pt_\d{5}/g) ?? []),
    ...(text.match(/[\w.]+@example\.test/g) ?? []),
    ...(text.match(/555-01\d\d/g) ?? []),
    ...patients.filter((p) => text.includes(p.name)).map((p) => p.name),
  ];

  it("never shows the model patient IDs, names, emails or phone numbers (legacy logs)", () => {
    for (const [name, input] of broad) {
      const out = executeTool(name, input, { store: legacy, redact: REDACT });
      expect(leaks(out.content), `${name} ${JSON.stringify(input)}`).toEqual([]);
    }
  });

  it("(control) the legacy logs do contain that data before redaction", () => {
    const out = executeTool(
      "search_logs",
      { service: "intake", limit: 100 },
      { store: legacy, redact: { medications: false } },
    );
    expect(leaks(out.content).length).toBeGreaterThan(0);
  });

  it("keeps timestamps intact while redacting text", () => {
    const out = JSON.parse(
      executeTool("search_logs", { limit: 1 }, { store: legacy, redact: REDACT }).content,
    );
    expect(out.lines[0].ts).toMatch(/^2026-11-18T13:00/);
  });

  it("explains when a trace ID matches nothing", () => {
    const out = executeTool("get_trace", { correlationId: "nope" }, { store: legacy });
    expect(JSON.parse(out.content)).toMatchObject({ lines: [], note: expect.any(String) });
  });

  it("truncates by dropping whole lines and only reports shown line IDs", () => {
    const out = executeTool(
      "search_logs",
      { limit: 100, query: "PharmacyClient" },
      { store: legacy },
    );
    const parsed = JSON.parse(out.content);
    expect(out.content.length).toBeLessThanOrEqual(24_500);
    expect(out.lineIds).toEqual(parsed.lines.map((l: { id: number }) => l.id));
  });

  it("finds runbooks by topic and lists them otherwise", () => {
    const hit = JSON.parse(
      executeTool(
        "get_runbook",
        { topic: "notification delivery" },
        { store: structured, runbooksDir: RUNBOOKS },
      ).content,
    );
    expect(hit.topic).toBe("notification-delivery");
    const miss = JSON.parse(
      executeTool("get_runbook", { topic: "zzz" }, { store: structured, runbooksDir: RUNBOOKS })
        .content,
    );
    expect(miss.available.length).toBe(6);
  });
});
