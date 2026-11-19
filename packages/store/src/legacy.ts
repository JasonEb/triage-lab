import type { LogLevel } from "@triage/logger";

export interface LegacyEntry {
  /** Epoch ms, or null if no timestamp could be found. */
  ts: number | null;
  /** How precise the source timestamp was (1 = ms, 1000 = s, 60000 = minute). */
  precisionMs: number;
  level: LogLevel | null;
  requestId: string | null;
  /** The entry's text, including continuation lines (stack traces). */
  text: string;
  /** 1-based line number where the entry starts. */
  lineNo: number;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function levelFromWord(word: string | undefined): LogLevel | null {
  switch (word?.toLowerCase()) {
    case "debug":
    case "dbg":
      return "debug";
    case "info":
    case "inf":
      return "info";
    case "warn":
    case "warning":
    case "wrn":
      return "warn";
    case "error":
    case "err":
    case "fatal":
      return "error";
    default:
      return null;
  }
}

/** First level-looking word among the first few tokens. */
function levelNear(s: string): LogLevel | null {
  for (const w of s.split(/[\s\t\][:]+/).slice(0, 5)) {
    const l = levelFromWord(w);
    if (l) return l;
  }
  return null;
}

type Head = Omit<LegacyEntry, "text" | "lineNo">;

/**
 * Recognizers for the start of an entry. Any line that matches none of them
 * is a continuation of the previous entry (stack traces, wrapped messages).
 * These are format-driven, not service-driven: a new service using one of
 * these shapes is parsed without changes.
 */
const STARTS: ((line: string, prev: Head | null) => Head | null)[] = [
  // 2026-11-18T14:02:11.254Z<TAB>requestId<TAB>LEVEL<TAB>msg   (Lambda console)
  (line) => {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/.exec(line);
    if (!m) return null;
    const rest = m[2]!;
    return {
      ts: Date.parse(m[1]!),
      precisionMs: m[1]!.includes(".") ? 1 : 1000,
      level: levelNear(rest.replace(UUID, "")),
      requestId: UUID.exec(rest.split("\t")[0] ?? "")?.[0] ?? null,
    };
  },
  // REPORT RequestId: <uuid> ...   (Lambda platform line, no timestamp)
  (line, prev) => {
    const m = /^(?:REPORT|START|END) RequestId: (\S+)/.exec(line);
    if (!m) return null;
    return {
      ts: prev?.ts ?? null,
      precisionMs: prev?.precisionMs ?? 1,
      level: "info",
      requestId: m[1]!,
    };
  },
  // [2026-11-18 14:02:11] LEVEL ...
  (line) => {
    const m = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]\s+(.*)$/.exec(line);
    if (!m) return null;
    return {
      ts: Date.parse(`${m[1]}T${m[2]}Z`),
      precisionMs: 1000,
      level: levelNear(m[3]!),
      requestId: null,
    };
  },
  // 1795006805676 service level ...   (epoch ms)
  (line) => {
    const m = /^(\d{13})\s+(.*)$/.exec(line);
    if (!m) return null;
    return { ts: Number(m[1]), precisionMs: 1, level: levelNear(m[2]!), requestId: null };
  },
  // {"ts": "...", "sev": "ERR", ...}   (ad-hoc JSON)
  (line) => {
    if (!line.startsWith("{")) return null;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const rawTs = o.ts ?? o.time ?? o.timestamp;
      const ts =
        typeof rawTs === "string" || typeof rawTs === "number" ? new Date(rawTs).getTime() : NaN;
      const levelRaw = o.sev ?? o.severity ?? o.level;
      return {
        ts: Number.isNaN(ts) ? null : ts,
        precisionMs: typeof rawTs === "string" && /\.\d{3}/.test(rawTs) ? 1 : 1000,
        level: typeof levelRaw === "string" ? levelFromWord(levelRaw) : null,
        requestId: typeof o.requestId === "string" ? o.requestId : null,
      };
    } catch {
      return null;
    }
  },
  // prefix> 2026-11-18 14:02 [!|!!] ...   (minute precision, markers for warn/error)
  (line) => {
    const m = /^\w+> (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s+(.*)$/.exec(line);
    if (!m) return null;
    const rest = m[3]!;
    const level: LogLevel = rest.startsWith("!! ")
      ? "error"
      : rest.startsWith("! ")
        ? "warn"
        : "info";
    return { ts: Date.parse(`${m[1]}T${m[2]}:00Z`), precisionMs: 60_000, level, requestId: null };
  },
];

/** Best-effort parse of a legacy log file into entries. */
export function parseLegacy(text: string): LegacyEntry[] {
  const entries: LegacyEntry[] = [];
  const lines = text.split(/\r?\n/);
  let prev: Head | null = null;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let head: Head | null = null;
    for (const start of STARTS) {
      head = start(line, prev);
      if (head) break;
    }
    const last = entries.at(-1);
    if (!head && last) {
      last.text += "\n" + line;
      return;
    }
    const h = head ?? { ts: null, precisionMs: 1, level: null, requestId: null };
    entries.push({ ...h, text: line, lineNo: i + 1 });
    prev = h;
  });
  return entries;
}

/**
 * Reduce a message to its shape: lowercase, with IDs, numbers, emails, phones
 * and timestamps replaced, so repeated messages collapse into one pattern.
 */
export function normalizePattern(text: string): string {
  return text
    .split("\n")[0]!
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?z?/g, " ")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun), \d{1,2} \w{3} \d{4} \d{2}:\d{2}:\d{2} gmt/g, " ")
    .replace(UUID, "<id>")
    .replace(new RegExp(UUID.source, "gi"), "<id>")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, "<email>")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "<phone>")
    .replace(/\b[a-z]+_\d+\b/g, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
