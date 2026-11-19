import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { BudgetExceededError, callCost, CostMeter, priceFor } from "./cost.js";

type Message = Anthropic.Beta.Messages.BetaMessage;

const usage = (input: number, output: number, read = 0, write = 0) =>
  ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  }) as Message["usage"];

const haiku = priceFor("claude-haiku-5-5");

describe("callCost", () => {
  it("prices input, output, cache reads and cache writes separately", () => {
    // The Phase 3 check: 12 input, 2,450 output, 25,569 cache reads, 12,089 cache writes.
    const c = callCost(haiku, usage(12, 2450, 25_569, 12_089));
    expect(c).toBeCloseTo((12 * 0.1 + 2450 * 0.5 + 25_569 * 0.01 + 12_089 * 0.125) / 1_000_000, 12);
    expect(c).toBeCloseTo(0.003, 3);
  });

  it("applies the long-prompt rate above 100K prompt tokens", () => {
    expect(callCost(haiku, usage(100_001, 0))).toBeCloseTo((100_001 * 0.5) / 1e6, 10);
    expect(callCost(haiku, usage(100_000, 0))).toBeCloseTo((100_000 * 0.1) / 1e6, 10);
  });

  it("refuses unknown models, so a cap is never silently unenforced", () => {
    expect(() => priceFor("claude-unknown")).toThrow(/No price/);
  });
});

describe("CostMeter", () => {
  const reply = (u: Message["usage"]) =>
    ({
      create: async () => ({ usage: u }) as Message,
    }) as const;

  it("tracks spend per run and in total", async () => {
    const meter = new CostMeter(haiku, 1);
    const a = meter.meter(reply(usage(50_000, 0)));
    const b = meter.meter(reply(usage(0, 1_000_000)));
    await a.client.create({} as never);
    await b.client.create({} as never);
    expect(a.spent()).toBeCloseTo(0.005);
    expect(b.spent()).toBeCloseTo(0.5);
    expect(meter.spentUsd).toBeCloseTo(0.505);
    expect(meter.calls).toBe(2);
  });

  it("aborts once spend passes the cap, and refuses further calls", async () => {
    const meter = new CostMeter(haiku, 0.25);
    const run = meter.meter(reply(usage(0, 200_000))); // $0.10 per call
    await run.client.create({} as never);
    await run.client.create({} as never);
    await expect(run.client.create({} as never)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(meter.spentUsd).toBeCloseTo(0.3);

    let called = false;
    const other = meter.meter({
      create: async () => {
        called = true;
        return { usage: usage(0, 0) } as Message;
      },
    });
    await expect(other.client.create({} as never)).rejects.toThrow(/reached the cap/);
    expect(called).toBe(false);
  });

  it("rejects a non-positive cap", () => {
    expect(() => new CostMeter(haiku, 0)).toThrow();
  });
});
