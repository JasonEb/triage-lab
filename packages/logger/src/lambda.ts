import { randomUUID } from "node:crypto";
import type { Logger } from "./logger.js";

/** The subset of the AWS Lambda context the wrapper uses. */
export interface LambdaContext {
  awsRequestId: string;
  functionName?: string;
}

export interface LoggedContext extends LambdaContext {
  /** Logger bound to this invocation's requestId and correlationId. */
  log: Logger;
  correlationId: string;
}

export type Trigger = "apigateway" | "sqs" | "eventbridge" | "direct";

export const CORRELATION_HEADER = "x-correlation-id";
export const CORRELATION_ATTRIBUTE = "correlationId";
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function fromSqsRecord(record: unknown): string | undefined {
  if (!isObj(record) || !isObj(record.messageAttributes)) return undefined;
  const attr = record.messageAttributes[CORRELATION_ATTRIBUTE];
  return isObj(attr) ? str(attr.stringValue) : undefined;
}

/**
 * Find the correlation ID on an incoming event, whatever triggered it.
 * Multi-record SQS batches return undefined: one invocation can carry several
 * requests, so the handler should log per record with `correlationIdFromSqsRecord`.
 */
export function extractCorrelationId(event: unknown): {
  correlationId: string | undefined;
  trigger: Trigger;
} {
  if (!isObj(event)) return { correlationId: undefined, trigger: "direct" };

  if (Array.isArray(event.Records)) {
    const records = event.Records;
    return {
      correlationId: records.length === 1 ? fromSqsRecord(records[0]) : undefined,
      trigger: "sqs",
    };
  }
  if (isObj(event.headers)) {
    const entry = Object.entries(event.headers).find(
      ([k]) => k.toLowerCase() === CORRELATION_HEADER,
    );
    return { correlationId: str(entry?.[1]), trigger: "apigateway" };
  }
  if ("detail-type" in event && isObj(event.detail)) {
    return { correlationId: str(event.detail[CORRELATION_ATTRIBUTE]), trigger: "eventbridge" };
  }
  return { correlationId: str(event[CORRELATION_ATTRIBUTE]), trigger: "direct" };
}

export const correlationIdFromSqsRecord = fromSqsRecord;

/* Outgoing propagation helpers: every hop must carry the ID forward. */

export function correlationHeaders(correlationId: string): Record<string, string> {
  return { [CORRELATION_HEADER]: correlationId };
}

/** SQS message attributes, in the shape the consumer receives them. */
export function sqsMessageAttributes(
  correlationId: string,
): Record<string, { stringValue: string; dataType: "String" }> {
  return { [CORRELATION_ATTRIBUTE]: { stringValue: correlationId, dataType: "String" } };
}

export function eventBridgeDetail<T extends Obj>(
  detail: T,
  correlationId: string,
): T & { correlationId: string } {
  return { ...detail, correlationId };
}

export interface WithLoggingOptions {
  /** Millisecond clock for durations. Injectable for deterministic sims. */
  clock?: () => number;
  /** Correlation ID generator when the event carries none. */
  newId?: () => string;
}

/**
 * Wrap a Lambda-style handler so every invocation logs
 * `<service>.handler.started` / `.completed` / `.failed` with requestId,
 * correlationId, trigger and duration, and errors in the standard shape.
 * Errors are rethrown so the platform's retry semantics are unchanged.
 */
export function withLogging<E, R>(
  base: Logger,
  handler: (event: E, context: LoggedContext) => Promise<R>,
  options: WithLoggingOptions = {},
): (event: E, context: LambdaContext) => Promise<R> {
  const clock = options.clock ?? (() => performance.now());
  const newId = options.newId ?? randomUUID;

  return async (event, context) => {
    const start = clock();
    const found = extractCorrelationId(event);
    const invalid = found.correlationId !== undefined && !VALID_ID.test(found.correlationId);
    const correlationId = found.correlationId && !invalid ? found.correlationId : newId();

    const log = base.child({ requestId: context.awsRequestId, correlationId });
    const prefix = log.service.replace(/-/g, "_");

    log.info(`${prefix}.handler.started`, "Handler started", {
      ctx: invalid
        ? { trigger: found.trigger, invalidCorrelationId: true }
        : { trigger: found.trigger },
    });

    try {
      const result = await handler(event, { ...context, log, correlationId });
      log.info(`${prefix}.handler.completed`, "Handler completed", { durationMs: clock() - start });
      return result;
    } catch (error) {
      log.error(`${prefix}.handler.failed`, "Handler failed", {
        durationMs: clock() - start,
        error,
      });
      throw error;
    }
  };
}
