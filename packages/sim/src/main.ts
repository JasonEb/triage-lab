import { runSimCli } from "./cli.js";

process.exitCode = await runSimCli(process.argv.slice(2), {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});
