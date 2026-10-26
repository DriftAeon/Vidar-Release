// Bare onboarding W1 (docs/projects/bare/onboarding-plan.md D3): the import library the Rust writer produces
// (golden: tests/fixtures/rune-import/acme-claude-md, checked byte for byte by src-tauri/src/rules/import/mod.rs)
// passes cook's lint, and its full-keep set (named after the library) cooks back to the normalised source. Cooks into a temp dir only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(REPO, "tests", "fixtures", "rune-import");
const LIB = join(FIXTURE, "acme-claude-md");
const lf = (t) => t.replace(/\r\n/g, "\n");

// D3 normalisation plus the `+ `/`* ` bullet rewrite (the fixture has no indented top-level bullets).
function normalise(raw) {
  const lines = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.replace(/^[+*] /, "- ")).join("\n") + "\n";
}

// Runes cooking is not shipped (tools/runes/ is export-ignored).
const COOK = join(REPO, "tools", "runes", "cook.mjs");
const skip = existsSync(COOK) ? false : "tools/runes/cook.mjs is not in this tree (not shipped)";

test("a full-keep import set cooks to the normalised source", { skip }, () => {
  // As an editor might save it: a BOM and one CRLF line (git would rewrite both on disk).
  const raw = "﻿" + lf(readFileSync(join(FIXTURE, "source.md"), "utf8")).replace("\n", "\r\n");
  const expected = lf(readFileSync(join(FIXTURE, "normalised.md"), "utf8"));
  assert.equal(normalise(raw), expected);

  const out = mkdtempSync(join(tmpdir(), "rune-import-cook-"));
  try {
    const r = spawnSync(process.execPath, [join(REPO, "tools", "runes", "cook.mjs"), "--root", LIB, "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, `cook failed:\n${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /^warning /m, r.stdout);
    assert.equal(readFileSync(join(out, "acme-claude-md.md"), "utf8"), expected);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
