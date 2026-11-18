import { makePatients } from "./catalog.js";
import { buildPlatform, startTraffic } from "./platform.js";
import { Recorder, type LogRecord } from "./recorder.js";
import { renderLegacy, renderStructured, type Rendered } from "./render.js";
import { Rng } from "./rng.js";
import { SimRuntime } from "./runtime.js";
import {
  backgroundDeploys,
  getScenario,
  SIM_MINUTES,
  SIM_START,
  type Scenario,
} from "./scenarios.js";
import { baselineWorld, type Deploy } from "./world.js";

export type Style = "structured" | "legacy";

export interface SimResult {
  scenario: Scenario;
  seed: number;
  records: LogRecord[];
  deploys: Deploy[];
  stats: SimRuntime["stats"];
  render(style: Style): Rendered;
}

export const defaultSeed = (scenarioId: number) => 1000 + scenarioId;

export async function runScenario(
  scenarioId: number,
  seed = defaultSeed(scenarioId),
): Promise<SimResult> {
  const scenario = getScenario(scenarioId);
  const start = SIM_START;
  const end = start + SIM_MINUTES * 60_000;

  const world = baselineWorld(start, end);
  const setupRng = new Rng(seed ^ 0x5eed);
  world.deploys.push(...backgroundDeploys(setupRng));
  scenario.apply(world, setupRng);
  world.deploys.sort((a, b) => a.ts.localeCompare(b.ts));

  const sim = new SimRuntime({ start, end, seed });
  const recorder = new Recorder(() => sim.now);
  const patients = makePatients(600);
  const handlers = buildPlatform(sim, recorder, world, patients);
  startTraffic(sim, world, patients, handlers);
  await sim.run();

  const records = recorder.sorted();
  return {
    scenario,
    seed,
    records,
    deploys: world.deploys,
    stats: sim.stats,
    render: (style) =>
      style === "structured" ? renderStructured(records) : renderLegacy(records, patients),
  };
}
