import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "@triage/agent";

type Message = Anthropic.Beta.Messages.BetaMessage;
type Block = Record<string, unknown>;

/**
 * A scripted stand-in for the Claude API, for exercising the eval pipeline
 * end to end with no key and no cost. It always answers the same way:
 * step 1 asks for error clusters, step 2 blames a dependency in rx and cites
 * the top cluster's sample line. So it is right about scenario 1 and wrong
 * in predictable ways elsewhere, which is what the pipeline tests need.
 */
export function fakeClient(usage = { input: 2000, output: 300 }): MessagesClient {
  return {
    create: async (params) => {
      const last = params.messages.at(-1)!;
      const results = Array.isArray(last.content)
        ? (last.content as unknown as Block[]).filter((b) => b.type === "tool_result")
        : [];
      const content: Block[] =
        results.length === 0
          ? [{ type: "tool_use", id: "fake_1", name: "error_clusters", input: {} }]
          : [
              {
                type: "tool_use",
                id: "fake_2",
                name: "submit_diagnosis",
                input: {
                  summary: "Scripted answer from the fake client.",
                  suspectedRootCause: {
                    category: "dependency",
                    service: "rx",
                    description: "Scripted: a dependency of rx is failing.",
                  },
                  evidence: sampleLineIds(results[0]!).map((lineId) => ({
                    lineId,
                    reason: "top error cluster",
                  })),
                  confidence: "medium",
                  suggestedNextSteps: [],
                  runbook: "",
                },
              },
            ];
      return {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: params.model,
        content,
        stop_reason: "tool_use",
        stop_details: null,
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      } as unknown as Message;
    },
  };
}

function sampleLineIds(result: Block): number[] {
  try {
    const parsed = JSON.parse(String(result.content)) as {
      clusters?: { sampleLineId: number }[];
    };
    return (parsed.clusters ?? []).slice(0, 1).map((c) => c.sampleLineId);
  } catch {
    return [];
  }
}
