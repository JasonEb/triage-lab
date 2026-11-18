import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSimCli } from "./cli.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe("pnpm sim", () => {
  it("writes one style's logs plus deploys and ground truth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-"));
    const { io, out } = capture();
    expect(await runSimCli(["--scenario=3", "--style=structured", `--out=${dir}`], io)).toBe(0);

    const base = join(dir, "scenario-3-bad-deploy-payload");
    expect(readdirSync(join(base, "structured")).sort()).toEqual([
      "billing.jsonl",
      "intake.jsonl",
      "notifications.jsonl",
      "rx.jsonl",
      "scheduling.jsonl",
    ]);
    expect(existsSync(join(base, "legacy"))).toBe(false);

    const deploys = readFileSync(join(base, "deploys.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(deploys.some((d: { version: string }) => d.version === "v2.4.0")).toBe(true);

    const truth = JSON.parse(readFileSync(join(base, "ground-truth.json"), "utf8"));
    expect(truth).toMatchObject({
      scenario: 3,
      seed: 1003,
      groundTruth: { category: "data", culpritService: "rx" },
    });
    expect(out.join("\n")).toMatch(/structured\s+\d+ lines/);
  });

  it("writes both styles by default and accepts --seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-"));
    expect(await runSimCli(["--scenario=6", "--seed=7", `--out=${dir}`], capture().io)).toBe(0);
    const base = join(dir, "scenario-6-sms-silent-drop");
    expect(readdirSync(join(base, "legacy"))).toContain("notifications.log");
    expect(readdirSync(join(base, "structured"))).toContain("notifications.jsonl");
    expect(JSON.parse(readFileSync(join(base, "ground-truth.json"), "utf8")).seed).toBe(7);
  });

  it("lists scenarios", async () => {
    const { io, out } = capture();
    expect(await runSimCli(["--list"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/1\s+pharmacy-5xx/);
    expect(out.join("\n")).toMatch(/6\s+sms-silent-drop/);
  });

  it("rejects bad arguments", async () => {
    expect(await runSimCli([], capture().io)).toBe(2);
    expect(await runSimCli(["--scenario=9"], capture().io)).toBe(2);
    expect(await runSimCli(["--scenario=1", "--style=fancy"], capture().io)).toBe(2);
  });
});
