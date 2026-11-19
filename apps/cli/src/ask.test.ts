import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "@triage/agent";
import { runSimCli } from "@triage/sim";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "./cli.js";

type Message = Anthropic.Beta.Messages.BetaMessage;
const repo = join(import.meta.dirname, "../../..");
let logs: string;

beforeAll(async () => {
  logs = mkdtempSync(join(tmpdir(), "ask-"));
  await runSimCli(["--scenario=4", `--out=${logs}`], { out: () => {}, err: () => {} });
}, 60_000);

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

const reply = (content: unknown[]): Message =>
  ({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: "tool_use",
    stop_details: null,
    usage: {
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 0,
    },
  }) as unknown as Message;

/** Searches once, then cites the first line it got back. */
function fakeAgent(): MessagesClient {
  let call = 0;
  return {
    create: async (p) => {
      call++;
      if (call === 1) {
        return reply([
          {
            type: "tool_use",
            id: "a",
            name: "search_logs",
            input: { query: "rejected credentials", limit: 3 },
          },
        ]);
      }
      const results = p.messages.at(-1)!.content as unknown as { content: string }[];
      const lines = JSON.parse(results[0]!.content).lines as { id: number }[];
      return reply([
        {
          type: "tool_use",
          id: "b",
          name: "submit_diagnosis",
          input: {
            summary: "Lab results credential expired at 14:00.",
            suspectedRootCause: {
              category: "auth",
              service: "rx",
              description: "lab-partner-a rejects the rx credential (401)",
            },
            evidence: [{ lineId: lines[0]!.id, reason: "401 from lab API" }],
            confidence: "high",
            suggestedNextSteps: ["Rotate the lab-partner-a credential", "Redrive the DLQ"],
            runbook: "integration-credentials",
          },
        },
      ]);
    },
  };
}

describe("triage ask", () => {
  it("prints a cited diagnosis", async () => {
    const { io, out } = capture();
    const code = await run(
      [
        "ask",
        "Some refills are failing since 14:00",
        "--scenario=4",
        "--style=legacy",
        `--logs=${logs}`,
      ],
      io,
      {
        client: fakeAgent(),
        cwd: repo,
        env: {},
      },
    );
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toMatch(/Diagnosis \(high confidence\): auth in rx/);
    expect(text).toMatch(/\[L\d+\] 2026-11-18T14:\d\d:\d\d\.\d{3}Z rx error: 401 from lab API/);
    expect(text).toMatch(/Runbook: docs\/runbooks\/integration-credentials\.md/);
    expect(text).toMatch(
      /diagnosed · claude-sonnet-5-5 · 2 steps · 2 tool calls · 9,200 tokens \(8,000 cache reads\)/,
    );
    expect(text).not.toMatch(/pt_\d{5}/);
  });

  it("emits JSON with --json", async () => {
    const { io, out } = capture();
    await run(["ask", "q", "--scenario=4", `--logs=${logs}`, "--json"], io, {
      client: fakeAgent(),
      cwd: repo,
      env: {},
    });
    expect(JSON.parse(out.join(""))).toMatchObject({
      outcome: "diagnosed",
      style: "structured",
      diagnosis: { confidence: expect.any(String) },
    });
  });

  it("uses TRIAGE_MODEL", async () => {
    const { io, out } = capture();
    await run(["ask", "q", "--scenario=4", `--logs=${logs}`, "--json"], io, {
      client: fakeAgent(),
      cwd: repo,
      env: { TRIAGE_MODEL: "claude-opus-5-5" },
    });
    expect(JSON.parse(out.join("")).model).toBe("claude-opus-5-5");
  });

  it("explains a missing API key, missing logs, and bad arguments", async () => {
    const a = capture();
    expect(
      await run(["ask", "q", "--scenario=4", `--logs=${logs}`], a.io, { cwd: repo, env: {} }),
    ).toBe(2);
    expect(a.err.join("\n")).toMatch(/ANTHROPIC_API_KEY is not set/);

    const b = capture();
    expect(
      await run(["ask", "q", "--scenario=5", `--logs=${logs}`], b.io, {
        client: fakeAgent(),
        env: {},
      }),
    ).toBe(2);
    expect(b.err.join("\n")).toMatch(/pnpm sim --scenario=5/);

    const c = capture();
    expect(await run(["ask", "--scenario=4"], c.io, { client: fakeAgent(), env: {} })).toBe(2);
    expect(c.err.join("\n")).toMatch(/a question is required/);
  });
});
