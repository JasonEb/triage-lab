import { redactText } from "./redact.js";
import { LogLineSchema, type LogLine } from "./schema.js";

export interface ServiceCompliance {
  service: string;
  total: number;
  compliant: number;
  percent: number;
}

export interface LintReport {
  total: number;
  compliant: number;
  percent: number;
  byService: ServiceCompliance[];
  topIssues: { issue: string; count: number }[];
}

const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);
const PHI_ISSUE = "contains text the redactor would mask";

/** Free-text fields of a schema-valid line that still contain maskable text. */
function phiIssues(line: LogLine): string[] {
  const issues: string[] = [];
  if (redactText(line.msg) !== line.msg) issues.push(`msg: ${PHI_ISSUE}`);
  if (line.error && redactText(line.error.message) !== line.error.message) {
    issues.push(`error.message: ${PHI_ISSUE}`);
  }
  for (const [k, v] of Object.entries(line.ctx ?? {})) {
    if (typeof v === "string" && redactText(v) !== v) issues.push(`ctx.${k}: ${PHI_ISSUE}`);
  }
  return issues;
}

/**
 * Check raw log lines against the standard. A line is compliant when it parses
 * as JSON, matches the schema, and its free text needs no redaction.
 * Blank lines are ignored. Lines that aren't JSON count under service "unknown".
 */
export function lintLogLines(lines: Iterable<string>): LintReport {
  const services = new Map<string, { total: number; compliant: number }>();
  const issueCounts = new Map<string, number>();
  let total = 0;
  let compliant = 0;

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    total++;

    let service = "unknown";
    let issues: string[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "service" in parsed &&
        typeof parsed.service === "string"
      ) {
        service = parsed.service;
      }
      const result = LogLineSchema.safeParse(parsed);
      issues = result.success
        ? phiIssues(result.data)
        : [
            ...new Set(
              result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            ),
          ];
    } catch {
      issues = ["not valid JSON"];
    }

    const s = services.get(service) ?? { total: 0, compliant: 0 };
    s.total++;
    if (issues.length === 0) {
      s.compliant++;
      compliant++;
    }
    services.set(service, s);
    for (const issue of issues) issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
  }

  return {
    total,
    compliant,
    percent: pct(compliant, total),
    byService: [...services.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([service, s]) => ({ service, ...s, percent: pct(s.compliant, s.total) })),
    topIssues: [...issueCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([issue, count]) => ({ issue, count })),
  };
}
