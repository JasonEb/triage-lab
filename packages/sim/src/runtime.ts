import type { LambdaContext } from "@triage/logger";
import { sqsMessageAttributes } from "@triage/logger";
import { Rng } from "./rng.js";

export type LambdaHandler = (event: unknown, context: LambdaContext) => Promise<unknown>;

interface Task {
  t: number;
  seq: number;
  run: () => void | Promise<void>;
}

export interface RuntimeOptions {
  start: number;
  end: number;
  seed: number;
}

/** SQS: redeliver after the visibility timeout, dead-letter after this many receives. */
const SQS_VISIBILITY_TIMEOUT_MS = 30_000;
const SQS_MAX_RECEIVES = 3;
/** Lambda async invocation (EventBridge) retries twice, after ~1 and ~2 minutes. */
const ASYNC_RETRY_DELAYS_MS = [60_000, 120_000];

/**
 * A tiny discrete-event simulator. Tasks run in virtual-time order; each
 * Lambda invocation runs to completion, and `sleep` advances the clock inside
 * it. Nothing waits on real time, so a two-hour incident simulates in seconds.
 */
export class SimRuntime {
  now: number;
  readonly start: number;
  readonly end: number;
  readonly rng: Rng;
  readonly stats = { invocations: 0, failures: 0, deadLettered: 0, asyncDropped: 0 };

  private queue: Task[] = [];
  private seq = 0;
  private queues = new Map<string, { functionName: string; handler: LambdaHandler }>();
  private subscribers = new Map<string, { functionName: string; handler: LambdaHandler }[]>();

  constructor(options: RuntimeOptions) {
    this.start = options.start;
    this.end = options.end;
    this.now = options.start;
    this.rng = new Rng(options.seed);
  }

  schedule(t: number, run: Task["run"]): void {
    if (t > this.end) return;
    const task = { t, seq: this.seq++, run };
    // Binary insertion keeps the queue sorted by (t, seq).
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const m = this.queue[mid]!;
      if (m.t < t || (m.t === t && m.seq < task.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, task);
  }

  /** Advance virtual time inside the running handler (I/O, CPU, waiting). */
  sleep(ms: number): void {
    this.now += Math.max(0, ms);
  }

  async run(): Promise<void> {
    for (let task = this.queue.shift(); task; task = this.queue.shift()) {
      this.now = task.t;
      await task.run();
    }
  }

  /** Invoke a handler like the Lambda runtime would. Resolves to success/failure. */
  async invoke(functionName: string, handler: LambdaHandler, event: unknown): Promise<boolean> {
    this.stats.invocations++;
    try {
      await handler(event, { awsRequestId: this.rng.uuid(), functionName });
      return true;
    } catch {
      this.stats.failures++;
      return false;
    }
  }

  /* ---- Triggers ---- */

  apiRequest(
    functionName: string,
    handler: LambdaHandler,
    req: {
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: unknown;
      at?: number;
    },
  ): void {
    const event = {
      httpMethod: req.method,
      path: req.path,
      headers: req.headers ?? {},
      body: req.body === undefined ? null : JSON.stringify(req.body),
    };
    this.schedule(req.at ?? this.now, async () => {
      await this.invoke(functionName, handler, event);
    });
  }

  registerQueue(queueName: string, functionName: string, handler: LambdaHandler): void {
    this.queues.set(queueName, { functionName, handler });
  }

  sendMessage(queueName: string, body: unknown, correlationId: string, delayMs = 0): void {
    const consumer = this.queues.get(queueName);
    if (!consumer) throw new Error(`No consumer for queue ${queueName}`);
    const messageId = this.rng.uuid();
    const deliver = (receiveCount: number) => async () => {
      const event = {
        Records: [
          {
            messageId,
            eventSource: "aws:sqs",
            eventSourceARN: `arn:aws:sqs:us-east-1:000000000000:${queueName}`,
            body: JSON.stringify(body),
            attributes: { ApproximateReceiveCount: String(receiveCount) },
            messageAttributes: sqsMessageAttributes(correlationId),
          },
        ],
      };
      const ok = await this.invoke(consumer.functionName, consumer.handler, event);
      if (ok) return;
      if (receiveCount >= SQS_MAX_RECEIVES) this.stats.deadLettered++;
      else this.schedule(this.now + SQS_VISIBILITY_TIMEOUT_MS, deliver(receiveCount + 1));
    };
    this.schedule(this.now + delayMs + this.rng.lognormal(40, 0.5), deliver(1));
  }

  subscribe(detailType: string, functionName: string, handler: LambdaHandler): void {
    const list = this.subscribers.get(detailType) ?? [];
    list.push({ functionName, handler });
    this.subscribers.set(detailType, list);
  }

  putEvent(source: string, detailType: string, detail: Record<string, unknown>, delayMs = 0): void {
    const event = {
      version: "0",
      id: this.rng.uuid(),
      "detail-type": detailType,
      source,
      time: new Date(this.now + delayMs).toISOString(),
      detail,
    };
    for (const { functionName, handler } of this.subscribers.get(detailType) ?? []) {
      const attempt = (n: number) => async () => {
        const ok = await this.invoke(functionName, handler, event);
        if (ok) return;
        const retryDelay = ASYNC_RETRY_DELAYS_MS[n];
        if (retryDelay === undefined) this.stats.asyncDropped++;
        else this.schedule(this.now + retryDelay, attempt(n + 1));
      };
      this.schedule(this.now + delayMs + this.rng.lognormal(250, 0.4), attempt(0));
    }
  }
}
