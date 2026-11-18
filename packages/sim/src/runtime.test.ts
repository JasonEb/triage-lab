import { describe, expect, it } from "vitest";
import { SimRuntime } from "./runtime.js";

const T0 = Date.parse("2026-11-18T13:00:00.000Z");
const make = (minutes = 60) => new SimRuntime({ start: T0, end: T0 + minutes * 60_000, seed: 1 });

describe("SimRuntime", () => {
  it("runs tasks in time order and exposes virtual time", async () => {
    const sim = make();
    const seen: string[] = [];
    sim.schedule(T0 + 2000, () => void seen.push(`b@${sim.now - T0}`));
    sim.schedule(T0 + 1000, () => void seen.push(`a@${sim.now - T0}`));
    await sim.run();
    expect(seen).toEqual(["a@1000", "b@2000"]);
  });

  it("advances time inside a handler with sleep", async () => {
    const sim = make();
    let after = 0;
    sim.schedule(T0 + 10, () => {
      sim.sleep(250);
      after = sim.now - T0;
    });
    await sim.run();
    expect(after).toBe(260);
  });

  it("drops tasks scheduled after the end of the window", async () => {
    const sim = make(1);
    let ran = false;
    sim.schedule(T0 + 61_000, () => void (ran = true));
    await sim.run();
    expect(ran).toBe(false);
  });

  it("delivers API requests as API Gateway-shaped events", async () => {
    const sim = make();
    const events: unknown[] = [];
    sim.apiRequest("intake", async (e) => void events.push(e), {
      method: "POST",
      path: "/intake",
      headers: { "x-correlation-id": "c1" },
      body: { a: 1 },
      at: T0 + 5,
    });
    await sim.run();
    expect(events[0]).toMatchObject({
      httpMethod: "POST",
      path: "/intake",
      headers: { "x-correlation-id": "c1" },
      body: '{"a":1}',
    });
  });

  it("delivers SQS messages with the correlation attribute and redelivers failures, then dead-letters", async () => {
    const sim = make();
    sim.registerQueue("refills", "rx", async (event) => {
      const rec = (
        event as { Records: { messageAttributes: { correlationId: { stringValue: string } } }[] }
      ).Records[0]!;
      expect(rec.messageAttributes.correlationId.stringValue).toBe("corr-q");
      throw new Error("always fails");
    });
    sim.schedule(T0, () => sim.sendMessage("refills", { x: 1 }, "corr-q"));
    await sim.run();
    expect(sim.stats.invocations).toBe(3);
    expect(sim.stats.deadLettered).toBe(1);
  });

  it("delivers EventBridge events to every subscriber and retries async failures twice", async () => {
    const sim = make();
    let okCalls = 0;
    let badCalls = 0;
    sim.subscribe("RefillSubmitted", "billing", async () => void okCalls++);
    sim.subscribe("RefillSubmitted", "notifications", async () => {
      badCalls++;
      throw new Error("nope");
    });
    sim.schedule(T0, () => sim.putEvent("honeydew.rx", "RefillSubmitted", { correlationId: "c" }));
    await sim.run();
    expect(okCalls).toBe(1);
    expect(badCalls).toBe(3);
    expect(sim.stats.asyncDropped).toBe(1);
  });

  it("is deterministic for a seed", async () => {
    const ids = async () => {
      const sim = make();
      const out: string[] = [];
      sim.apiRequest("x", async (_e, ctx) => void out.push(ctx.awsRequestId), {
        method: "GET",
        path: "/",
        at: T0,
      });
      await sim.run();
      return out;
    };
    expect(await ids()).toEqual(await ids());
  });
});
