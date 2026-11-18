import { toLogError } from "./errors.js";
import { DEV_ID_HASH_SALT, hashId } from "./hash.js";
import { redactLogLine, type RedactOptions } from "./redact.js";
import {
  LogLineSchema,
  MAX_CTX_STRING_CHARS,
  MAX_MSG_CHARS,
  type Ctx,
  type Environment,
  type LogLevel,
  type LogLine,
} from "./schema.js";

export type Sink = (line: string) => void;

export interface LoggerOptions {
  service: string;
  env: Environment;
  /** Where serialized lines go. Default: stdout, one JSON object per line. */
  sink?: Sink;
  /** Clock, injectable for deterministic tests and simulations. */
  now?: () => Date;
  minLevel?: LogLevel;
  redact?: RedactOptions;
  /** Salt for patient ID hashing. Default: TRIAGE_ID_HASH_SALT or a dev salt. */
  idHashSalt?: string;
  /**
   * Throw on schema violations. Default: true in local/sim/test so mistakes
   * fail tests; false elsewhere, where a bad log line must never take down a
   * request (a `logger.schema.violation` warning is written instead).
   */
  strict?: boolean;
}

export interface LogFields {
  durationMs?: number;
  /** Raw patient identifier. Hashed before it is written; never logged as-is. */
  patientId?: string;
  /** Any thrown value; serialized via the error taxonomy. */
  error?: unknown;
  ctx?: Ctx;
}

export interface RequestIds {
  requestId: string;
  correlationId: string;
}

export interface Logger {
  readonly service: string;
  readonly ids: RequestIds;
  debug(event: string, msg: string, fields?: LogFields): void;
  info(event: string, msg: string, fields?: LogFields): void;
  warn(event: string, msg: string, fields?: LogFields): void;
  error(event: string, msg: string, fields?: LogFields): void;
  child(ids: RequestIds): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const STRICT_ENVS: ReadonlySet<Environment> = new Set(["local", "sim", "test"]);

const defaultSink: Sink = (line) => {
  process.stdout.write(line + "\n");
};

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function createLogger(
  options: LoggerOptions,
  ids: RequestIds = { requestId: "none", correlationId: "none" },
): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const minRank = LEVEL_RANK[options.minLevel ?? "debug"];
  const strict = options.strict ?? STRICT_ENVS.has(options.env);
  const salt = options.idHashSalt ?? process.env.TRIAGE_ID_HASH_SALT ?? DEV_ID_HASH_SALT;

  function emit(level: LogLevel, event: string, msg: string, fields: LogFields = {}): void {
    if (LEVEL_RANK[level] < minRank) return;

    let line: LogLine = {
      ts: now().toISOString(),
      level,
      service: options.service,
      env: options.env,
      event,
      msg: truncate(msg, MAX_MSG_CHARS),
      requestId: ids.requestId,
      correlationId: ids.correlationId,
    };
    if (fields.durationMs !== undefined)
      line.durationMs = Math.max(0, Math.round(fields.durationMs));
    if (fields.patientId !== undefined) line.patientIdHash = hashId(fields.patientId, salt);
    if (fields.error !== undefined) line.error = toLogError(fields.error);
    if (fields.ctx !== undefined) line.ctx = fields.ctx;

    line = redactLogLine(line, options.redact);

    const result = LogLineSchema.safeParse(line);
    if (result.success) {
      sink(JSON.stringify(result.data));
      return;
    }

    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    if (strict) throw new Error(`Log line violates schema: ${issues}`);

    sink(
      JSON.stringify({
        ts: line.ts,
        level: "warn",
        service: options.service,
        env: options.env,
        event: "logger.schema.violation",
        msg: "Dropped a log line that did not match the schema",
        requestId: ids.requestId,
        correlationId: ids.correlationId,
        ctx: { issues: truncate(issues, MAX_CTX_STRING_CHARS), level },
      } satisfies LogLine),
    );
  }

  return {
    service: options.service,
    ids,
    debug: (e, m, f) => emit("debug", e, m, f),
    info: (e, m, f) => emit("info", e, m, f),
    warn: (e, m, f) => emit("warn", e, m, f),
    error: (e, m, f) => emit("error", e, m, f),
    child: (childIds) => createLogger(options, childIds),
  };
}

/** In-memory sink for tests and simulations. */
export function createMemorySink(): { write: Sink; raw: string[]; lines: LogLine[] } {
  const raw: string[] = [];
  const lines: LogLine[] = [];
  return {
    raw,
    lines,
    write: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line) as LogLine);
    },
  };
}
