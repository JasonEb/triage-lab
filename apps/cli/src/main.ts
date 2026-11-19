#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { run } from "./cli.js";

// Load a git-ignored .env if present (ANTHROPIC_API_KEY, TRIAGE_MODEL, ...).
if (existsSync(".env")) process.loadEnvFile(".env");

const code = await run(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});
process.exitCode = code;
