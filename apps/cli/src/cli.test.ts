import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./cli.js";

const good = JSON.stringify({
  ts: "2026-11-18T14:02:11.123Z",
  level: "info",
  service: "rx",
  env: "sim",
  event: "rx.refill.requested",
  msg: "Refill requested",
  requestId: "r",
  correlationId: "c",
});

function fixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "triage-cli-"));
  const file = join(dir, "logs.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

describe("triage lint-logs", () => {
  it("prints overall and per-service compliance", async () => {
    const file = fixture([good, good, "rx refill failed!!"]);
    const { io, out } = capture();
    expect(await run(["lint-logs", file], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/overall\s+2\/3\s+66\.7%/);
    expect(text).toMatch(/rx\s+2\/2\s+100\.0%/);
    expect(text).toMatch(/unknown\s+0\/1\s+0\.0%/);
    expect(text).toMatch(/1\s+not valid JSON/);
  });

  it("emits JSON with --json", async () => {
    const { io, out } = capture();
    await run(["lint-logs", fixture([good]), "--json"], io);
    expect(JSON.parse(out.join(""))).toMatchObject({ total: 1, compliant: 1, percent: 100 });
  });

  it("exits 1 when compliance is below --min-percent (CI gate)", async () => {
    const file = fixture([good, "legacy line"]);
    expect(await run(["lint-logs", file, "--min-percent=90"], capture().io)).toBe(1);
    expect(await run(["lint-logs", file, "--min-percent=50"], capture().io)).toBe(0);
  });

  it("exits 2 with usage on bad input", async () => {
    const { io, err } = capture();
    expect(await run(["lint-logs"], io)).toBe(2);
    expect(err.join("\n")).toMatch(/usage/i);
    expect(await run(["nope"], capture().io)).toBe(2);
    expect(await run(["lint-logs", "/does/not/exist.jsonl"], capture().io)).toBe(2);
  });
});
