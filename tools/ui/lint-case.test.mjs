import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintCaseText } from "./lint-case.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT = join(HERE, "lint-case.mjs");
const PLANT_DIR = join(HERE, "..", "..", "src", "__lint_case_probe__");
const PLANT = join(PLANT_DIR, "probe.ts");

test("lint-case: each hand-rolled shape is flagged", () => {
  for (const line of [
    "const a = s.charAt(0).toUpperCase() + s.slice(1);",
    "const a = s[0].toUpperCase() + s.slice(1);",
    "const a = `${s.charAt(0).toUpperCase()}${s.slice(1)}`;",
    "const a = s.toUpperCase() + t.slice(1);",
  ]) assert.equal(lintCaseText(line).length, 1, line);
});

test("lint-case: case-ok on the line passes, plain uses of toUpperCase pass", () => {
  assert.deepEqual(lintCaseText("const k = id.charAt(0).toUpperCase() + id.slice(1); // case-ok: wire key"), []);
  assert.deepEqual(lintCaseText("const k = e.key.toUpperCase();"), []);
});

test("lint-case: the CLI fails on a planted copy and passes on a case-ok line", () => {
  try {
    mkdirSync(PLANT_DIR, { recursive: true });
    writeFileSync(PLANT, "export const x = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);\n");
    const bad = spawnSync(process.execPath, [LINT], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /__lint_case_probe__\/probe\.ts:1/);
    writeFileSync(PLANT, "export const x = (s: string) => s.charAt(0).toUpperCase() + s.slice(1); // case-ok: probe\n");
    const ok = spawnSync(process.execPath, [LINT], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    if (existsSync(PLANT_DIR)) rmSync(PLANT_DIR, { recursive: true, force: true });
  }
});
