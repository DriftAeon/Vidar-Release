// Cross-language contract: the permission-mode allowlist is read by Rust through
// include_str! and by the frontend through a JSON import. Both sides must name the same file
// under contracts\, or the allowlists can drift apart again. The Claude
// sidecar's copy is checked against the same file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSION_MODES } from "../src/agents/protocol.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function includeStrTarget(rustFile, name) {
  const source = readFileSync(resolve(ROOT, rustFile), "utf8");
  const m = source.match(new RegExp(`include_str!\\("([^"]*${name.replace(".", "\\.")})"\\)`));
  assert.ok(m, `${rustFile} has no include_str! of ${name}`);
  return resolve(dirname(resolve(ROOT, rustFile)), m[1]);
}

test("Rust and the frontend read the same contract files", () => {
  const modes = resolve(ROOT, "contracts/permission-modes.json");
  assert.equal(includeStrTarget("src-falcon/src/protocol.rs", "permission-modes.json"), modes);
  assert.deepEqual([...PERMISSION_MODES], JSON.parse(readFileSync(modes, "utf8")));
  // The sidecar keeps its own literal: falcon-build.ps1 bundles only the sidecar scripts (no
  // contracts/ folder), so a file read would miss the contracts\ folder inside a Falcon bundle. Pin the literal to the file instead.
  const sidecar = readFileSync(resolve(ROOT, "tools/claude-sidecar.mjs"), "utf8");
  const literal = sidecar.match(/const ALLOWED_MODES = new Set\((\[[^\]]*\])\)/);
  assert.ok(literal, "claude-sidecar.mjs ALLOWED_MODES literal not found");
  assert.deepEqual(JSON.parse(literal[1]), JSON.parse(readFileSync(modes, "utf8")));
});

test("the sidecar's effort literal equals contracts/effort-levels.json", () => {
  const levels = JSON.parse(readFileSync(resolve(ROOT, "contracts/effort-levels.json"), "utf8"));
  const sidecar = readFileSync(resolve(ROOT, "tools/claude-sidecar.mjs"), "utf8");
  const literal = sidecar.match(/const EFFORT_LEVELS = (\[[^\]]*\])/);
  assert.ok(literal, "claude-sidecar.mjs EFFORT_LEVELS literal not found");
  assert.deepEqual(JSON.parse(literal[1]), levels);
});
