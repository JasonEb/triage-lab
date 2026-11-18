import { createLogger, toLogError } from "@triage/logger";
import type { Patient } from "./catalog.js";
import type { LogRecord } from "./recorder.js";
import { SERVICES, type ServiceName } from "./world.js";

export type Rendered = Record<ServiceName, string>;

const emptyRendered = (): Record<ServiceName, string[]> =>
  Object.fromEntries(SERVICES.map((s) => [s, [] as string[]])) as Record<ServiceName, string[]>;
const join = (by: Record<ServiceName, string[]>): Rendered =>
  Object.fromEntries(
    SERVICES.map((s) => [s, by[s].length ? by[s].join("\n") + "\n" : ""]),
  ) as Rendered;

/** Structured: every record goes through @triage/logger (hashing, redaction, schema). */
export function renderStructured(records: LogRecord[]): Rendered {
  const out = emptyRendered();
  let current = 0;
  const loggers = Object.fromEntries(
    SERVICES.map((service) => [
      service,
      createLogger({
        service,
        env: "sim",
        now: () => new Date(current),
        sink: (l) => out[service].push(l),
      }),
    ]),
  ) as Record<ServiceName, ReturnType<typeof createLogger>>;

  for (const r of records) {
    current = r.t;
    const log = loggers[r.service as ServiceName].child({
      requestId: r.requestId,
      correlationId: r.correlationId,
    });
    log[r.level](r.event, r.msg, r.fields);
  }
  return join(out);
}

/* ----------------------------- legacy ------------------------------ */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const d = (t: number) => new Date(t);
const ymd = (t: number) =>
  `${d(t).getUTCFullYear()}-${pad(d(t).getUTCMonth() + 1)}-${pad(d(t).getUTCDate())}`;
const hms = (t: number) =>
  `${pad(d(t).getUTCHours())}:${pad(d(t).getUTCMinutes())}:${pad(d(t).getUTCSeconds())}`;

interface Ctx {
  r: LogRecord;
  patient: Patient | undefined;
  ctx: Record<string, unknown>;
  err: { message: string; stack?: string } | undefined;
}

/** How each team happened to write its logs. No two agree. */
const LEGACY: Record<ServiceName, (c: Ctx) => string | null> = {
  // Plain text, second precision, no request or correlation IDs, patient names inline.
  intake: ({ r, patient, ctx, err }) => {
    if (r.event.includes(".handler."))
      return r.level === "error"
        ? `[${ymd(r.t)} ${hms(r.t)}] ERROR intake - unhandled error: ${err?.message}`
        : null;
    const who = patient ? ` for ${patient.name} (${patient.id})` : "";
    const extra = Object.keys(ctx).length
      ? ` (${Object.entries(ctx)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`
      : "";
    const lvl = r.level.toUpperCase().padEnd(5);
    return `[${ymd(r.t)} ${hms(r.t)}] ${lvl} intake - ${r.msg}${who}${extra}${err?.stack ? "\n" + err.stack : ""}`;
  },
  // Lambda's default console format: ts, requestId, level, message. REPORT lines for durations.
  rx: ({ r, patient, ctx, err }) => {
    const iso = d(r.t).toISOString();
    if (r.event.endsWith(".handler.started")) return null;
    if (r.event.endsWith(".handler.completed") || r.event.endsWith(".handler.failed")) {
      const ms = r.fields.durationMs ?? 0;
      const report = `REPORT RequestId: ${r.requestId}\tDuration: ${ms.toFixed(2)} ms\tBilled Duration: ${Math.ceil(ms)} ms\tMemory Size: 512 MB\tMax Memory Used: ${118 + (r.seq % 40)} MB`;
      if (r.level !== "error") return report;
      const invoke = JSON.stringify({
        errorType: "TriageError",
        errorMessage: err?.message,
        stack: err?.stack?.split("\n"),
      });
      return `${iso}\t${r.requestId}\tERROR\tInvoke Error \t${invoke}\n${report}`;
    }
    const values = Object.values(ctx).join(" ");
    const who = patient ? ` patient=${patient.id}` : "";
    return `${iso}\t${r.requestId}\t${r.level.toUpperCase()}\t${r.msg}${values ? " " + values : ""}${who}${err ? `\n${err.stack ?? err.message}` : ""}`;
  },
  // Epoch milliseconds, lowercase levels, Python-dict-style details. No IDs.
  scheduling: ({ r, patient, ctx, err }) => {
    if (r.event.includes(".handler.")) return null;
    const details = Object.keys(ctx).length
      ? " {" +
        Object.entries(ctx)
          .map(([k, v]) => `'${k}': ${typeof v === "string" ? `'${v}'` : v}`)
          .join(", ") +
        "}"
      : "";
    const took =
      r.fields.durationMs !== undefined ? ` in ${Math.round(r.fields.durationMs)}ms` : "";
    const who = patient ? ` patient ${patient.id}` : "";
    return `${Math.floor(r.t)} scheduling ${r.level} ${r.msg.toLowerCase()}${who}${took}${details}${err ? ` - ${err.message}` : ""}`;
  },
  // Its own JSON shape, with RFC 1123 timestamps. Swallows stacks.
  billing: ({ r, patient, ctx, err }) => {
    if (r.event.includes(".handler.") && r.level !== "error") return null;
    const sev = { debug: "DBG", info: "INF", warn: "WRN", error: "ERR" }[r.level];
    return JSON.stringify({
      ts: d(r.t).toUTCString(),
      sev,
      message: r.msg,
      ...(patient ? { patient: patient.id } : {}),
      ...(Object.keys(ctx).length ? { data: ctx } : {}),
      ...(err ? { err: err.message } : {}),
    });
  },
  // Minute precision, contact details inline, only errors get a marker.
  notifications: ({ r, patient, ctx, err }) => {
    if (r.event.includes(".handler.") && r.level !== "error") return null;
    const to = patient ? ` to ${r.event.includes(".email.") ? patient.email : patient.phone}` : "";
    const values = Object.values(ctx).join(" ");
    const mark = r.level === "error" ? "!! " : r.level === "warn" ? "! " : "";
    return `notify> ${ymd(r.t)} ${pad(d(r.t).getUTCHours())}:${pad(d(r.t).getUTCMinutes())} ${mark}${r.msg.toLowerCase()}${to}${values ? " " + values : ""}${err ? ` (${err.message})` : ""}`;
  },
};

/**
 * Legacy: the same records written the way ad-hoc logging usually looks. Event
 * names, correlation IDs, error types and codes are lost; formats and timestamp
 * precision differ per service; synthetic patient details appear in plain text.
 */
export function renderLegacy(records: LogRecord[], patients: Patient[]): Rendered {
  const out = emptyRendered();
  const byId = new Map(patients.map((p) => [p.id, p]));
  for (const r of records) {
    if (r.level === "debug") continue;
    const err = r.fields.error === undefined ? undefined : toLogError(r.fields.error);
    const line = LEGACY[r.service as ServiceName]({
      r,
      patient: r.fields.patientId ? byId.get(r.fields.patientId) : undefined,
      ctx: (r.fields.ctx ?? {}) as Record<string, unknown>,
      err,
    });
    if (line !== null) out[r.service as ServiceName].push(line);
  }
  return join(out);
}
