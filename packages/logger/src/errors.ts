import { ZodError } from "zod";

/**
 * The error taxonomy. Every logged error carries exactly one of these types,
 * so "how many timeouts vs. dependency failures?" is a group-by, not a regex.
 */
export const ERROR_TYPES = [
  "validation",
  "dependency",
  "timeout",
  "auth",
  "data",
  "unknown",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const MAX_STACK_CHARS = 2000;
export const MAX_ERROR_MESSAGE_CHARS = 1000;

/** Throw this when you know what kind of failure it is. */
export class TriageError extends Error {
  readonly type: ErrorType;
  readonly code: string | undefined;

  constructor(type: ErrorType, message: string, options: { code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TriageError";
    this.type = type;
    this.code = options.code;
  }
}

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNABORTED"]);
const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);
const DEPENDENCY_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]);
const DEPENDENCY_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "ServiceUnavailable",
]);

function prop(err: unknown, key: string): unknown {
  return typeof err === "object" && err !== null
    ? (err as Record<string, unknown>)[key]
    : undefined;
}

/** Best-effort mapping from an arbitrary thrown value to the taxonomy. */
export function classifyError(err: unknown): ErrorType {
  if (err instanceof TriageError) return err.type;
  if (err instanceof ZodError) return "validation";

  const name = prop(err, "name");
  const code = prop(err, "code");
  const status = prop(err, "statusCode") ?? prop(err, "status");

  if (typeof code === "string" && TIMEOUT_CODES.has(code)) return "timeout";
  if (typeof name === "string" && TIMEOUT_NAMES.has(name)) return "timeout";
  if (typeof code === "string" && DEPENDENCY_CODES.has(code)) return "dependency";
  if (typeof name === "string" && DEPENDENCY_NAMES.has(name)) return "dependency";
  if (status === 401 || status === 403) return "auth";
  if (typeof status === "number" && (status >= 500 || status === 429)) return "dependency";
  if (err instanceof SyntaxError) return "data";
  return "unknown";
}

export interface LogError {
  type: ErrorType;
  message: string;
  stack?: string;
  code?: string;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Convert any thrown value into the standard `error` field shape. */
export function toLogError(err: unknown): LogError {
  const out: LogError = {
    type: classifyError(err),
    message: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE_CHARS),
  };
  if (err instanceof Error && err.stack) out.stack = err.stack.slice(0, MAX_STACK_CHARS);
  const code = prop(err, "code");
  if (typeof code === "string" && CODE_PATTERN.test(code)) out.code = code;
  return out;
}
