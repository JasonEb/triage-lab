#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { runEvalsCli } from "./cli.js";

// Load a git-ignored .env if present (TRIAGE_ANTHROPIC_API_KEY, TRIAGE_MODEL, ...).
if (existsSync(".env")) process.loadEnvFile(".env");

process.exitCode = await runEvalsCli(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});
