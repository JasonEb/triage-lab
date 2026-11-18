import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSeed, runScenario, type Style } from "./run.js";
import { SCENARIOS, SIM_MINUTES, SIM_START } from "./scenarios.js";
import { SERVICES } from "./world.js";

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `Usage:
  pnpm sim --scenario=<n|all> [--style=structured|legacy] [--seed=<n>] [--out=<dir>]
  pnpm sim --list

Writes <out>/scenario-<n>-<slug>/{structured,legacy}/ logs, deploys.jsonl and
ground-truth.json. Without --style, writes both. Default out: logs/`;

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

export async function runSimCli(args: string[], io: IO): Promise<number> {
  if (args.includes("--list")) {
    for (const s of SCENARIOS)
      io.out(`${String(s.id).padStart(2)}  ${s.slug.padEnd(24)} ${s.title}`);
    return 0;
  }

  const scenarioArg = flag(args, "scenario");
  const styleArg = flag(args, "style");
  const seedArg = flag(args, "seed");
  const out = flag(args, "out") ?? "logs";

  const ids = scenarioArg === "all" ? SCENARIOS.map((s) => s.id) : [Number(scenarioArg)];
  const styles: Style[] = styleArg === undefined ? ["structured", "legacy"] : [styleArg as Style];
  const seed = seedArg === undefined ? undefined : Number(seedArg);

  const problems = [
    scenarioArg === undefined && "--scenario is required",
    ids.some((id) => !SCENARIOS.some((s) => s.id === id)) && `unknown scenario: ${scenarioArg}`,
    styles.some((s) => s !== "structured" && s !== "legacy") && `unknown style: ${styleArg}`,
    seed !== undefined && !Number.isInteger(seed) && `bad seed: ${seedArg}`,
  ].filter(Boolean);
  if (problems.length) {
    io.err(`${problems.join("; ")}\n\n${USAGE}`);
    return 2;
  }

  for (const id of ids) {
    const result = await runScenario(id, seed ?? defaultSeed(id));
    const { scenario } = result;
    const dir = join(out, `scenario-${scenario.id}-${scenario.slug}`);
    mkdirSync(dir, { recursive: true });
    io.out(`Scenario ${scenario.id}: ${scenario.title} (seed ${result.seed}) -> ${dir}`);

    for (const style of styles) {
      const styleDir = join(dir, style);
      rmSync(styleDir, { recursive: true, force: true });
      mkdirSync(styleDir);
      const rendered = result.render(style);
      let lines = 0;
      for (const service of SERVICES) {
        writeFileSync(
          join(styleDir, `${service}.${style === "structured" ? "jsonl" : "log"}`),
          rendered[service],
        );
        lines += rendered[service].split("\n").length - 1;
      }
      io.out(`  ${style.padEnd(10)} ${lines} lines`);
    }

    writeFileSync(
      join(dir, "deploys.jsonl"),
      result.deploys.map((d) => JSON.stringify(d)).join("\n") + "\n",
    );
    writeFileSync(
      join(dir, "ground-truth.json"),
      JSON.stringify(
        {
          scenario: scenario.id,
          slug: scenario.slug,
          title: scenario.title,
          question: scenario.question,
          seed: result.seed,
          window: { start: new Date(SIM_START).toISOString(), minutes: SIM_MINUTES },
          groundTruth: scenario.groundTruth,
          stats: result.stats,
        },
        null,
        2,
      ) + "\n",
    );
  }
  return 0;
}
