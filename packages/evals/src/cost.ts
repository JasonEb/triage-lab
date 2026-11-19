import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "@triage/agent";

type ApiUsage = Anthropic.Beta.Messages.BetaMessage["usage"];

/** USD per million tokens. Cache writes are 5-minute writes (the agent's TTL). */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Prompts above this many tokens are billed at `longMultiplier` times every rate. */
  longAbove?: number;
  longMultiplier?: number;
}

/**
 * First-party list prices (USD / 1M tokens). Cache reads are 0.1x input and
 * 5-minute cache writes 1.25x input unless the model's price list says otherwise.
 * Kept here, not fetched, so a run's cost cap never depends on the network.
 */
export const PRICING: Record<string, Price> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longAbove: 100_000,
    longMultiplier: 5,
  },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function priceFor(model: string): Price {
  const p = PRICING[model];
  if (!p)
    throw new Error(
      `No price for model ${model}; add it to PRICING in packages/evals/src/cost.ts so the cost cap can be enforced.`,
    );
  return p;
}

/** Cost of one API response. */
export function callCost(price: Price, u: ApiUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const prompt = u.input_tokens + read + write;
  const m =
    price.longAbove !== undefined && prompt > price.longAbove ? (price.longMultiplier ?? 1) : 1;
  return (
    (m *
      (u.input_tokens * price.input +
        u.output_tokens * price.output +
        read * price.cacheRead +
        write * price.cacheWrite)) /
    1_000_000
  );
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`Eval spend $${spentUsd.toFixed(4)} reached the cap of $${capUsd.toFixed(4)}; aborting.`);
    this.name = "BudgetExceededError";
  }
}

/**
 * A hard spending cap shared by every agent run in an eval. Each run gets a
 * metered client: before every API call it refuses to start if the cap is
 * reached, and after every call it adds the call's cost and aborts the run
 * once the total passes the cap. Overshoot is at most the calls already in flight.
 */
export class CostMeter {
  spentUsd = 0;
  calls = 0;

  constructor(
    readonly price: Price,
    readonly capUsd: number,
  ) {
    if (!(capUsd > 0)) throw new Error(`Cost cap must be positive, got ${capUsd}`);
  }

  get exceeded(): boolean {
    return this.spentUsd >= this.capUsd;
  }

  /** A client for one run. `spent()` is that run's own cost. */
  meter(client: MessagesClient): { client: MessagesClient; spent: () => number } {
    let own = 0;
    return {
      spent: () => own,
      client: {
        create: async (params) => {
          if (this.exceeded) throw new BudgetExceededError(this.spentUsd, this.capUsd);
          const res = await client.create(params);
          const c = callCost(this.price, res.usage);
          own += c;
          this.spentUsd += c;
          this.calls++;
          if (this.exceeded) throw new BudgetExceededError(this.spentUsd, this.capUsd);
          return res;
        },
      },
    };
  }
}
