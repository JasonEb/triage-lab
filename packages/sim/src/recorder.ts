import type { LogFields, LogLevel, Logger, RequestIds } from "@triage/logger";

/** One abstract log event, before it is rendered in either style. */
export interface LogRecord {
  seq: number;
  t: number;
  service: string;
  level: LogLevel;
  event: string;
  msg: string;
  requestId: string;
  correlationId: string;
  fields: LogFields;
}

/**
 * Captures what services log, without formatting it. The simulation runs once
 * into a Recorder; the structured and legacy renderers then turn the same
 * records into two styles of output, so log format is the only difference.
 */
export class Recorder {
  readonly records: LogRecord[] = [];
  private seq = 0;

  constructor(private readonly now: () => number) {}

  logger(service: string, ids: RequestIds = { requestId: "none", correlationId: "none" }): Logger {
    const emit =
      (level: LogLevel) =>
      (event: string, msg: string, fields: LogFields = {}) => {
        this.records.push({
          seq: this.seq++,
          t: this.now(),
          service,
          level,
          event,
          msg,
          ...ids,
          fields,
        });
      };
    return {
      service,
      ids,
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (childIds) => this.logger(service, childIds),
    };
  }

  /** Records in time order (ties keep emission order). */
  sorted(): LogRecord[] {
    return [...this.records].sort((a, b) => a.t - b.t || a.seq - b.seq);
  }
}
