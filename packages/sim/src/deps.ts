import { TriageError, type ErrorType } from "@triage/logger";

/**
 * Postgres connection pool as a FIFO queue over N connections. `acquire`
 * returns how long the caller waited. A caller that would wait longer than the
 * timeout gives up without taking a connection, like pg's connectionTimeoutMillis.
 */
export class PgPool {
  private freeAt: number[];

  constructor(
    readonly size: number,
    readonly timeoutMs: number,
  ) {
    this.freeAt = Array.from({ length: size }, () => -Infinity);
  }

  acquire(now: number, holdMs: number): { waitMs: number; timedOut: boolean } {
    let idx = 0;
    for (let i = 1; i < this.freeAt.length; i++) if (this.freeAt[i]! < this.freeAt[idx]!) idx = i;
    const start = Math.max(now, this.freeAt[idx]!);
    const waitMs = start - now;
    if (waitMs > this.timeoutMs) return { waitMs: this.timeoutMs, timedOut: true };
    this.freeAt[idx] = start + holdMs;
    return { waitMs, timedOut: false };
  }

  /** Callers currently holding or queued for a connection at `now` (approx). */
  busy(now: number): number {
    return this.freeAt.filter((t) => t > now).length;
  }
}

/** Per-partition throughput limit (DynamoDB-style), as a token bucket. */
export class TokenBucket {
  private tokens: number;
  private last = -Infinity;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(now: number): boolean {
    if (now > this.last) {
      if (this.last !== -Infinity) {
        this.tokens = Math.min(
          this.burst,
          this.tokens + ((now - this.last) / 1000) * this.ratePerSec,
        );
      }
      this.last = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Errors with fixed, Lambda-looking stack traces. Real stacks would contain
 * this machine's file paths and break byte-for-byte reproducibility.
 */
export function simError(
  type: ErrorType,
  message: string,
  options: { code?: string; frames?: string[]; name?: string } = {},
): TriageError {
  const err = new TriageError(
    type,
    message,
    options.code === undefined ? {} : { code: options.code },
  );
  if (options.name) err.name = options.name;
  const frames = (options.frames ?? ["handler (index.js:1:1)"]).map((f) =>
    f.includes("(") ? f.replace("(", "(/var/task/") : `/var/task/${f}`,
  );
  err.stack = [
    `${err.name}: ${message}`,
    ...frames.map((f) => `    at ${f}`),
    "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
  ].join("\n");
  return err;
}
