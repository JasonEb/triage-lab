import type { LogLine } from "./schema.js";

/**
 * Redaction for free-text log fields (msg, error.message, error.stack, ctx strings).
 *
 * This is a safety net, not the primary control. The primary control is the
 * schema: identifiers go in typed fields (patientIdHash), and free text should
 * not contain PHI in the first place. Redaction catches the mistakes, and runs
 * again before any text reaches an LLM.
 *
 * Pattern-based name detection is heuristic. It catches labeled names
 * ("patient Jane Doe"), honorifics ("Dr. Okafor"), and a configurable list;
 * it will not catch a bare name in arbitrary prose.
 */

/** Dermatology-leaning default list; synthetic data uses these. Extend via options. */
export const DEFAULT_MEDICATIONS = [
  "isotretinoin",
  "accutane",
  "tretinoin",
  "adapalene",
  "tazarotene",
  "spironolactone",
  "doxycycline",
  "minocycline",
  "sarecycline",
  "clindamycin",
  "erythromycin",
  "benzoyl peroxide",
  "azelaic acid",
  "dapsone",
  "metronidazole",
  "ivermectin",
  "hydrocortisone",
  "triamcinolone",
  "clobetasol",
  "betamethasone",
  "tacrolimus",
  "pimecrolimus",
  "crisaborole",
  "ruxolitinib",
  "dupilumab",
  "methotrexate",
  "calcipotriene",
  "finasteride",
  "minoxidil",
] as const;

export interface RedactOptions {
  /** Redact medication names (default true). */
  medications?: boolean;
  /** Extra medication names on top of the defaults. */
  extraMedications?: readonly string[];
  /** Known names to redact wherever they appear (e.g. synthetic patient roster). */
  names?: readonly string[];
  /** Platform identifier formats to mask as [ID] wherever they appear (e.g. /pt_\d{5}/). */
  idPatterns?: readonly RegExp[];
}

type Rule = [pattern: RegExp, replacement: string | ((...m: string[]) => string)];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordList = (words: readonly string[]) =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) => escape(w).replace(/\s+/g, "\\s+"))
    .join("|");

// Capitalized words that commonly follow "patient"/"member" and are not names.
const NOT_NAMES = new Set([
  "Record",
  "Records",
  "Portal",
  "Profile",
  "Not",
  "Service",
  "Intake",
  "Id",
]);

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

// Order matters: specific, labeled patterns run before broad numeric ones.
const BASE_RULES: Rule[] = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [TOKEN]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  [/\b(mrn|patient[_ ]?id|member[_ ]?id)(\s*[:#=]\s*|\s+)(?!\[)[A-Za-z0-9_-]{3,}/gi, "$1$2[ID]"],
  [/(?<![\w-])(?:\d[ -]?){12,18}\d(?![\w-])/g, "[CARD]"],
  [/(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g, "[SSN]"],
  [/(?<![\w-])\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?(?![\w-])/g, "[DATE]"],
  [/(?<![\w/])\d{1,2}\/\d{1,2}\/\d{2,4}(?![\w/])/g, "[DATE]"],
  [new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "gi"), "[DATE]"],
  [/(?<![\w-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?![\w-])/g, "[PHONE]"],
  // Seven-digit local numbers (555-0142), optionally with a +1 prefix.
  [/(?<![\w-])(?:\+?1[\s.-])?\d{3}-\d{4}(?![\w-])/g, "[PHONE]"],
  [/\b(?:Mr|Mrs|Ms|Mx|Miss|Dr)\.?\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?/g, "[NAME]"],
  [
    /\b([Pp]atient|[Mm]ember|[Cc]aregiver|[Gg]uardian|[Nn]ame)((?:\s+[Nn]ame)?\s*[:=]?\s+)([A-Z][a-z'-]+)((?:\s+[A-Z][a-z'-]+)?)/g,
    (match, label, sep, first) => (NOT_NAMES.has(first!) ? match! : `${label}${sep}[NAME]`),
  ],
];

const ruleCache = new Map<string, Rule[]>();

function rulesFor(options: RedactOptions): Rule[] {
  const key = JSON.stringify({ ...options, idPatterns: options.idPatterns?.map(String) });
  const cached = ruleCache.get(key);
  if (cached) return cached;

  const rules: Rule[] = (options.idPatterns ?? []).map((p) => [
    new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"),
    "[ID]",
  ]);
  rules.push(...BASE_RULES);
  if (options.names?.length) {
    rules.push([new RegExp(`\\b(?:${wordList(options.names)})\\b`, "gi"), "[NAME]"]);
  }
  if (options.medications !== false) {
    const meds = [...DEFAULT_MEDICATIONS, ...(options.extraMedications ?? [])];
    rules.push([new RegExp(`\\b(?:${wordList(meds)})\\b`, "gi"), "[MEDICATION]"]);
  }
  if (ruleCache.size > 32) ruleCache.clear();
  ruleCache.set(key, rules);
  return rules;
}

export function redactText(text: string, options: RedactOptions = {}): string {
  let out = text;
  for (const [pattern, replacement] of rulesFor(options)) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/** Redact every free-text field of a log line. Returns a new object. */
export function redactLogLine(line: LogLine, options: RedactOptions = {}): LogLine {
  const out: LogLine = { ...line, msg: redactText(line.msg, options) };
  if (line.error) {
    out.error = { ...line.error, message: redactText(line.error.message, options) };
    if (line.error.stack !== undefined) out.error.stack = redactText(line.error.stack, options);
  }
  if (line.ctx) {
    out.ctx = Object.fromEntries(
      Object.entries(line.ctx).map(([k, v]) => [
        k,
        typeof v === "string" ? redactText(v, options) : v,
      ]),
    );
  }
  return out;
}
