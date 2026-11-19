import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import Database from "better-sqlite3";
import { LogLineSchema, type LogLevel } from "@triage/logger";
import { normalizePattern, parseLegacy } from "./legacy.js";

export type Style = "structured" | "legacy";

/** One log line as the agent's tools return it. Raw JSON/stack traces are not included. */
export interface LogRow {
  id: number;
  ts: string | null;
  service: string;
  level: LogLevel | null;
  event: string | null;
  correlationId: string | null;
  requestId: string | null;
  errorType: string | null;
  errorCode: string | null;
  text: string;
}

export interface Deploy {
  ts: string;
  service: string;
  version: string;
  commit: string;
  description: string;
}

interface Window {
  from?: string | undefined;
  to?: string | undefined;
}

const SCHEMA = `
CREATE TABLE logs (
  id             INTEGER PRIMARY KEY,
  ts             INTEGER,            -- epoch ms (NULL if unknown)
  precision_ms   INTEGER NOT NULL,
  service        TEXT NOT NULL,
  level          TEXT,
  event          TEXT,
  correlation_id TEXT,
  request_id     TEXT,
  error_type     TEXT,
  error_code     TEXT,
  fingerprint    TEXT NOT NULL,      -- groups repeated lines (see fingerprint())
  pattern        TEXT NOT NULL,      -- human-readable label for the fingerprint
  text           TEXT NOT NULL,      -- display/search text
  source         TEXT NOT NULL,
  line_no        INTEGER NOT NULL
);
CREATE INDEX logs_ts ON logs(ts);
CREATE INDEX logs_service_ts ON logs(service, ts);
CREATE INDEX logs_event ON logs(event);
CREATE INDEX logs_corr ON logs(correlation_id);
CREATE INDEX logs_req ON logs(request_id);
CREATE INDEX logs_fp ON logs(fingerprint);
CREATE VIRTUAL TABLE logs_fts USING fts5(text, content='logs', content_rowid='id');
CREATE TABLE deploys (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, service TEXT NOT NULL,
  version TEXT NOT NULL, commit_sha TEXT NOT NULL, description TEXT NOT NULL
);
`;

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function parseTime(s: string | undefined, name: string): number | undefined {
  if (s === undefined || s === "") return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`${name} is not a valid ISO timestamp: ${s}`);
  return t;
}

/**
 * Turn a free-text query into an FTS5 expression. Each term is quoted, so user
 * input can't inject FTS syntax; terms are ANDed. "rx.refill.failed" becomes
 * the phrase "rx refill failed" under the default tokenizer.
 */
export function toFtsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_.#:-]+/gu) ?? [];
  const cleaned = terms.map((t) => t.replace(/"/g, "")).filter((t) => t.length > 0);
  return cleaned.length ? cleaned.map((t) => `"${t}"`).join(" ") : null;
}

/**
 * Read-only query layer over one incident's logs. Ingestion happens once at
 * open time; every method after that is a SELECT.
 */
export class LogStore {
  private constructor(private readonly db: Database.Database) {}

  static create(): LogStore {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    return new LogStore(db);
  }

  /** Load `<dir>/<style>/*` and `<dir>/deploys.jsonl`. Never reads ground-truth.json. */
  static fromScenarioDir(dir: string, style: Style): LogStore {
    const store = LogStore.create();
    const styleDir = join(dir, style);
    if (!existsSync(styleDir))
      throw new Error(`No ${style} logs in ${dir}. Run: pnpm sim --scenario=<n> --style=${style}`);
    for (const file of readdirSync(styleDir).sort()) {
      const service = basename(file, extname(file));
      const text = readFileSync(join(styleDir, file), "utf8");
      if (style === "structured") store.ingestStructured(service, text, file);
      else store.ingestLegacy(service, text, file);
    }
    const deploys = join(dir, "deploys.jsonl");
    if (existsSync(deploys)) store.ingestDeploys(readFileSync(deploys, "utf8"));
    store.finish();
    return store;
  }

  private insert(row: {
    ts: number | null;
    precisionMs: number;
    service: string;
    level: string | null;
    event: string | null;
    correlationId: string | null;
    requestId: string | null;
    errorType: string | null;
    errorCode: string | null;
    fingerprint: string;
    pattern: string;
    text: string;
    source: string;
    lineNo: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO logs (ts, precision_ms, service, level, event, correlation_id, request_id, error_type, error_code,
                           fingerprint, pattern, text, source, line_no)
         VALUES (@ts, @precisionMs, @service, @level, @event, @correlationId, @requestId, @errorType, @errorCode,
                 @fingerprint, @pattern, @text, @source, @lineNo)`,
      )
      .run(row);
  }

  /** Structured JSONL. Lines that fail the schema are kept, best-effort, as plain text. */
  ingestStructured(service: string, text: string, source = `${service}.jsonl`): number {
    let n = 0;
    this.db.transaction(() => {
      text.split("\n").forEach((raw, i) => {
        if (raw.trim() === "") return;
        n++;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        const r = LogLineSchema.safeParse(parsed);
        if (!r.success) {
          const pattern = normalizePattern(raw);
          this.insert({
            ts: null,
            precisionMs: 1,
            service,
            level: null,
            event: null,
            correlationId: null,
            requestId: null,
            errorType: null,
            errorCode: null,
            fingerprint: sha(`${service}|${pattern}`),
            pattern,
            text: raw.slice(0, 2000),
            source,
            lineNo: i + 1,
          });
          return;
        }
        const l = r.data;
        const ctx = Object.entries(l.ctx ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        const errorPart = l.error
          ? ` [${l.error.type}${l.error.code ? ` ${l.error.code}` : ""}] ${l.error.message}`
          : "";
        const duration = l.durationMs !== undefined ? ` durationMs=${l.durationMs}` : "";
        this.insert({
          ts: Date.parse(l.ts),
          precisionMs: 1,
          service: l.service,
          level: l.level,
          event: l.event,
          correlationId: l.correlationId,
          requestId: l.requestId,
          errorType: l.error?.type ?? null,
          errorCode: l.error?.code ?? null,
          fingerprint: fingerprint(l.event, l.error?.type ?? "", l.error ? l.error.message : l.msg),
          pattern: l.error
            ? `${l.event} [${l.error.type}${l.error.code ? ` ${l.error.code}` : ""}]`
            : l.event,
          text: `${l.event} ${l.msg}${errorPart}${duration}${ctx ? ` ${ctx}` : ""}`,
          source,
          lineNo: i + 1,
        });
      });
    })();
    return n;
  }

  /** Legacy text logs: timestamps and levels are recovered best-effort; no events or correlation IDs. */
  ingestLegacy(service: string, text: string, source = `${service}.log`): number {
    const entries = parseLegacy(text);
    this.db.transaction(() => {
      for (const e of entries) {
        const pattern = normalizePattern(stripHeader(e.text));
        this.insert({
          ts: e.ts,
          precisionMs: e.precisionMs,
          service,
          level: e.level,
          event: null,
          correlationId: null,
          requestId: e.requestId,
          errorType: null,
          errorCode: null,
          fingerprint: sha(`${service}|${e.level ?? ""}|${pattern}`),
          pattern,
          text: e.text.slice(0, 4000),
          source,
          lineNo: e.lineNo,
        });
      }
    })();
    return entries.length;
  }

  ingestDeploys(text: string): number {
    const rows = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Deploy);
    const stmt = this.db.prepare(
      "INSERT INTO deploys (ts, service, version, commit_sha, description) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.transaction(() =>
      rows.forEach((d) =>
        stmt.run(Date.parse(d.ts), d.service, d.version, d.commit, d.description),
      ),
    )();
    return rows.length;
  }

  /** Build the full-text index. Call once after ingesting. */
  finish(): void {
    this.db.exec("INSERT INTO logs_fts(logs_fts) VALUES ('rebuild')");
  }

  /* ------------------------------ queries ------------------------------ */

  overview(): {
    from: string | null;
    to: string | null;
    lines: number;
    services: { service: string; lines: number }[];
    hasEvents: boolean;
    hasCorrelationIds: boolean;
  } {
    const r = this.db
      .prepare(
        "SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n, COUNT(event) e, COUNT(correlation_id) c FROM logs",
      )
      .get() as { a: number | null; b: number | null; n: number; e: number; c: number };
    const services = this.db
      .prepare("SELECT service, COUNT(*) lines FROM logs GROUP BY service ORDER BY service")
      .all() as { service: string; lines: number }[];
    return {
      from: iso(r.a),
      to: iso(r.b),
      lines: r.n,
      services,
      hasEvents: r.e > 0,
      hasCorrelationIds: r.c > 0,
    };
  }

  private windowSql(w: Window, where: string[], params: unknown[]) {
    const from = parseTime(w.from, "from");
    const to = parseTime(w.to, "to");
    if (from !== undefined) {
      where.push("l.ts >= ?");
      params.push(from);
    }
    if (to !== undefined) {
      where.push("l.ts <= ?");
      params.push(to);
    }
  }

  searchLogs(
    opts: Window & {
      query?: string | undefined;
      service?: string | undefined;
      level?: LogLevel | undefined;
      event?: string | undefined;
      limit?: number | undefined;
    },
  ): { total: number; rows: LogRow[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    let from = "logs l";
    const fts = opts.query ? toFtsQuery(opts.query) : null;
    if (fts) {
      from = "logs_fts f JOIN logs l ON l.id = f.rowid";
      where.push("logs_fts MATCH ?");
      params.push(fts);
    }
    if (opts.service) {
      where.push("l.service = ?");
      params.push(opts.service);
    }
    if (opts.level) {
      where.push("l.level = ?");
      params.push(opts.level);
    }
    if (opts.event) {
      where.push("l.event = ?");
      params.push(opts.event);
    }
    this.windowSql(opts, where, params);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const total = (
      this.db.prepare(`SELECT COUNT(*) n FROM ${from} ${w}`).get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT l.* FROM ${from} ${w} ORDER BY l.ts, l.id LIMIT ?`)
      .all(...params, limit) as DbRow[];
    return { total, rows: rows.map(toRow) };
  }

  getTrace(opts: { correlationId?: string | undefined; requestId?: string | undefined }): LogRow[] {
    const [col, val] = opts.correlationId
      ? ["correlation_id", opts.correlationId]
      : ["request_id", opts.requestId];
    if (!val) throw new Error("Provide correlationId or requestId");
    return (
      this.db
        .prepare(`SELECT * FROM logs WHERE ${col} = ? ORDER BY ts, id LIMIT 200`)
        .all(val) as DbRow[]
    ).map(toRow);
  }

  /** Top warn/error fingerprints in the window, with counts and first/last seen. */
  errorClusters(opts: Window & { service?: string | undefined; limit?: number | undefined }) {
    const where = ["l.level IN ('warn', 'error')"];
    const params: unknown[] = [];
    if (opts.service) {
      where.push("l.service = ?");
      params.push(opts.service);
    }
    this.windowSql(opts, where, params);
    const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
    const rows = this.db
      .prepare(
        `SELECT l.fingerprint, l.service, l.level, l.pattern, l.event, l.error_type, l.error_code,
                COUNT(*) count, MIN(l.ts) first, MAX(l.ts) last, MIN(l.id) sample_id
         FROM logs l WHERE ${where.join(" AND ")}
         GROUP BY l.fingerprint ORDER BY count DESC LIMIT ?`,
      )
      .all(...params, limit) as {
      fingerprint: string;
      service: string;
      level: string;
      pattern: string;
      event: string | null;
      error_type: string | null;
      error_code: string | null;
      count: number;
      first: number | null;
      last: number | null;
      sample_id: number;
    }[];
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      service: r.service,
      level: r.level,
      pattern: r.pattern,
      event: r.event,
      errorType: r.error_type,
      errorCode: r.error_code,
      count: r.count,
      firstSeen: iso(r.first),
      lastSeen: iso(r.last),
      sampleLineId: r.sample_id,
    }));
  }

  /**
   * Counts per pattern per time bucket, for all levels. This is how an absence
   * shows up: a pattern whose count drops to zero.
   */
  timeline(
    opts: Window & {
      service?: string | undefined;
      level?: LogLevel | undefined;
      bucketMinutes?: number | undefined;
      limit?: number | undefined;
    },
  ) {
    const ov = this.db.prepare("SELECT MIN(ts) a, MAX(ts) b FROM logs").get() as {
      a: number | null;
      b: number | null;
    };
    const from = parseTime(opts.from, "from") ?? ov.a ?? 0;
    const to = parseTime(opts.to, "to") ?? ov.b ?? 0;
    const bucketMs = Math.max(1, opts.bucketMinutes ?? 10) * 60_000;
    const buckets = Math.min(Math.ceil((to - from + 1) / bucketMs), 48);
    const where = ["l.ts >= ?", "l.ts <= ?"];
    const params: unknown[] = [from, to];
    if (opts.service) {
      where.push("l.service = ?");
      params.push(opts.service);
    }
    if (opts.level) {
      where.push("l.level = ?");
      params.push(opts.level);
    }
    const rows = this.db
      .prepare(
        `SELECT l.fingerprint fp, l.service, l.pattern, MIN(l.id) sample_id, CAST((l.ts - ?) / ? AS INTEGER) b, COUNT(*) n
         FROM logs l WHERE ${where.join(" AND ")} GROUP BY fp, b`,
      )
      .all(from, bucketMs, ...params) as {
      fp: string;
      service: string;
      pattern: string;
      sample_id: number;
      b: number;
      n: number;
    }[];

    const byFp = new Map<
      string,
      { service: string; pattern: string; sampleLineId: number; counts: number[]; total: number }
    >();
    for (const r of rows) {
      if (r.b >= buckets) continue;
      const e = byFp.get(r.fp) ?? {
        service: r.service,
        pattern: r.pattern,
        sampleLineId: r.sample_id,
        counts: Array(buckets).fill(0) as number[],
        total: 0,
      };
      e.counts[r.b]! += r.n;
      e.total += r.n;
      e.sampleLineId = Math.min(e.sampleLineId, r.sample_id);
      byFp.set(r.fp, e);
    }
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 40);
    return {
      bucketStarts: Array.from({ length: buckets }, (_, i) =>
        new Date(from + i * bucketMs).toISOString(),
      ),
      bucketMinutes: bucketMs / 60_000,
      patterns: [...byFp.values()].sort((a, b) => b.total - a.total).slice(0, limit),
    };
  }

  recentDeploys(opts: Window & { service?: string | undefined }): Deploy[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const from = parseTime(opts.from, "from");
    const to = parseTime(opts.to, "to");
    if (from !== undefined) {
      where.push("ts >= ?");
      params.push(from);
    }
    if (to !== undefined) {
      where.push("ts <= ?");
      params.push(to);
    }
    if (opts.service) {
      where.push("service = ?");
      params.push(opts.service);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return (
      this.db.prepare(`SELECT * FROM deploys ${w} ORDER BY ts`).all(...params) as {
        ts: number;
        service: string;
        version: string;
        commit_sha: string;
        description: string;
      }[]
    ).map((d) => ({
      ts: new Date(d.ts).toISOString(),
      service: d.service,
      version: d.version,
      commit: d.commit_sha,
      description: d.description,
    }));
  }

  getLines(ids: number[]): LogRow[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM logs WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(...ids) as DbRow[];
    return rows.map(toRow);
  }

  close(): void {
    this.db.close();
  }
}

interface DbRow {
  id: number;
  ts: number | null;
  service: string;
  level: LogLevel | null;
  event: string | null;
  correlation_id: string | null;
  request_id: string | null;
  error_type: string | null;
  error_code: string | null;
  text: string;
}

function toRow(r: DbRow): LogRow {
  return {
    id: r.id,
    ts: iso(r.ts),
    service: r.service,
    level: r.level,
    event: r.event,
    correlationId: r.correlation_id,
    requestId: r.request_id,
    errorType: r.error_type,
    errorCode: r.error_code,
    text: r.text,
  };
}

/** Fingerprint = hash(event + error type + normalized message), per PLAN.md. */
export function fingerprint(event: string, errorType: string, message: string): string {
  return sha(`${event}|${errorType}|${normalizePattern(message)}`);
}

/** Drop the timestamp/request-ID header of a legacy line before normalizing it. */
function stripHeader(text: string): string {
  const first = text.split("\n")[0]!;
  if (first.startsWith("{")) {
    try {
      const o = JSON.parse(first) as Record<string, unknown>;
      delete o.ts;
      delete o.time;
      return JSON.stringify(o);
    } catch {
      return first;
    }
  }
  return first
    .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+\S+\s+/, "")
    .replace(/^\[[^\]]+\]\s+/, "")
    .replace(/^\d{13}\s+/, "")
    .replace(/^\w+> \d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+/, "")
    .replace(/^REPORT RequestId: \S+.*$/, "REPORT");
}
