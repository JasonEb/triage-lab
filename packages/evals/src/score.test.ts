import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnosis } from "@triage/agent";
import { getScenario, runSimCli } from "@triage/sim";
import { LogStore } from "@triage/store";
import { beforeAll, describe, expect, it } from "vitest";
import { scoreDiagnosis } from "./score.js";

let structured: LogStore;
let legacy: LogStore;
const gt = getScenario(1).groundTruth;

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), "score-"));
  await runSimCli(["--scenario=1", `--out=${out}`], { out: () => {}, err: () => {} });
  structured = LogStore.fromScenarioDir(join(out, "scenario-1-pharmacy-5xx"), "structured");
  legacy = LogStore.fromScenarioDir(join(out, "scenario-1-pharmacy-5xx"), "legacy");
}, 60_000);

const diag = (category: string, service: string, lineIds: number[]): Diagnosis =>
  ({
    summary: "s",
    suspectedRootCause: { category, service, description: "d" },
    evidence: lineIds.map((lineId) => ({ lineId, reason: "r" })),
    confidence: "high",
    suggestedNextSteps: [],
    runbook: "",
  }) as Diagnosis;

/** First line ID matching a search, via the same store API the tools use. */
function find(store: LogStore, query: string): number {
  const id = store.searchLogs({ query, limit: 1 }).rows[0]?.id;
  if (id === undefined) throw new Error(`no line for ${query}`);
  return id;
}

describe("scoreDiagnosis", () => {
  it("scores a correct, cited diagnosis 1/1/1 (structured: by event name)", () => {
    const id = find(structured, "PHARMACY_5XX");
    expect(scoreDiagnosis(diag("dependency", "rx", [id]), gt, structured)).toEqual({
      category: 1,
      service: 1,
      evidence: 1,
    });
  });

  it("matches legacy evidence by pattern, since legacy lines have no event", () => {
    const id = find(legacy, "503");
    expect(scoreDiagnosis(diag("dependency", "rx", [id]), gt, legacy).evidence).toBe(1);
  });

  it("gives no evidence credit for unrelated or missing citations", () => {
    expect(scoreDiagnosis(diag("dependency", "rx", [1]), gt, structured).evidence).toBe(0);
    expect(scoreDiagnosis(diag("dependency", "rx", []), gt, structured).evidence).toBe(0);
    expect(scoreDiagnosis(diag("dependency", "rx", [99_999_999]), gt, structured).evidence).toBe(0);
  });

  it("scores each check independently", () => {
    const id = find(structured, "PHARMACY_5XX");
    expect(scoreDiagnosis(diag("timeout", "notifications", [id]), gt, structured)).toEqual({
      category: 0,
      service: 0,
      evidence: 1,
    });
    expect(scoreDiagnosis(diag("insufficient_data", "", []), gt, structured)).toEqual({
      category: 0,
      service: 0,
      evidence: 0,
    });
  });
});
