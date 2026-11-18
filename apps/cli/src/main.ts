#!/usr/bin/env -S npx tsx
import { run } from "./cli.js";

const code = await run(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});
process.exitCode = code;
