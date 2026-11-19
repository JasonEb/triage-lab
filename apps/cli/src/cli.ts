import { readFileSync } from "node:fs";
import { lintLogLines, type LintReport } from "@triage/logger";
import { ask, ASK_USAGE, type AskDeps } from "./ask.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `Usage:
  triage lint-logs <file.jsonl> [--json] [--min-percent=<n>]
${ASK_USAGE}

Commands:
  lint-logs   Report the % of log lines that comply with the logging standard,
              overall and by service. With --min-percent, exit 1 below the bar.
  ask         Ask the read-only troubleshooting agent about a simulated incident.`;

function formatReport(file: string, r: LintReport): string {
  const row = (name: string, c: number, t: number, p: number) =>
    `  ${name.padEnd(16)} ${`${c}/${t}`.padStart(11)} ${`${p.toFixed(1)}%`.padStart(7)}`;
  const lines = [`Log compliance: ${file}`, row("overall", r.compliant, r.total, r.percent), ""];
  for (const s of r.byService) lines.push(row(s.service, s.compliant, s.total, s.percent));
  if (r.topIssues.length > 0) {
    lines.push("", "Top issues:");
    for (const i of r.topIssues) lines.push(`  ${String(i.count).padStart(6)}  ${i.issue}`);
  }
  return lines.join("\n");
}

function lintLogs(args: string[], io: IO): number {
  const file = args.find((a) => !a.startsWith("--"));
  const json = args.includes("--json");
  const minArg = args.find((a) => a.startsWith("--min-percent="));
  const min = minArg === undefined ? undefined : Number(minArg.split("=")[1]);

  if (!file || (min !== undefined && Number.isNaN(min))) {
    io.err(USAGE);
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    io.err(`Cannot read ${file}: ${(e as Error).message}`);
    return 2;
  }

  const report = lintLogLines(text.split(/\r?\n/));
  io.out(json ? JSON.stringify(report, null, 2) : formatReport(file, report));

  if (min !== undefined && report.percent < min) {
    io.err(`Compliance ${report.percent.toFixed(1)}% is below the required ${min}%.`);
    return 1;
  }
  return 0;
}

export async function run(argv: string[], io: IO, deps: AskDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "lint-logs":
      return lintLogs(rest, io);
    case "ask":
      return ask(rest, io, deps);
    case undefined:
    case "help":
    case "--help":
      io.out(USAGE);
      return command === undefined ? 2 : 0;
    default:
      io.err(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}
