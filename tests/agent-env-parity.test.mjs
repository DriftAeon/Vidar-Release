// Env parity, JS half: tools/lib/agent-env.mjs buildBareEnv against tests/fixtures/agent-env-parity.json.
// The Rust half (src-tauri/src/bare/env_parity.rs) reads the same fixture through prepare_with (Claude)
// and env::codex (Codex), so the sweep's bare cells and a Vidar Bare tab get the same env names from the
// same contract and parent env.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildBareEnv, inDropList, readEnvContract } from "../tools/lib/agent-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-env-parity.json", import.meta.url), "utf8"));
const profile = JSON.parse(readFileSync(new URL("../profiles/bare/claude.json", import.meta.url), "utf8"));
const codexProfile = JSON.parse(readFileSync(new URL("../profiles/bare/codex.json", import.meta.url), "utf8"));
const contract = readEnvContract(ROOT);
const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());

function build(p = profile) {
  return buildBareEnv({ parent: fixture.parent, profile: p, root: "X:\\vidar", home: "X:\\vidar\\runtime\\homes", contract });
}

test("parity: the JS builder gives the fixture's Codex names, and no inherited CODEX_* value", () => {
  const env = build(codexProfile);
  assert.deepEqual(Object.keys(env).sort(byName), [...fixture.codex.expected].sort(byName));
  assert.equal(env.CODEX_HOME, "X:\\vidar\\runtime\\homes\\codex-home");
  assert.equal(env.VIDAR_AGENT_HOME, "X:\\vidar\\runtime\\homes\\codex-home");
  assert.equal(env.CODEX_SANDBOX_NETWORK_DISABLED, undefined);
  assert.equal(env.LOCALAPPDATA, fixture.parent.LOCALAPPDATA, "Bare Codex runs on the real LOCALAPPDATA");
  assert.equal(build().LOCALAPPDATA, "X:\\vidar\\runtime\\homes\\user-home\\AppData\\Local", "Claude's stays redirected");
  assert.throws(() => buildBareEnv({ parent: {}, profile: codexProfile, root: "X:\\v", home: "X:\\h", contract }), /LOCALAPPDATA/);
  assert.equal(env.PathExt, fixture.parent.PathExt, "the first spelling in fixture order wins");
});

test("parity: the JS builder gives the fixture's expected names, spelling included", () => {
  assert.deepEqual(Object.keys(build()).sort(byName), [...fixture.expected].sort(byName));
});

test("parity: no drop-list value survives from the parent and the overlay values are filled", () => {
  const env = build();
  // CLAUDE_CONFIG_DIR is on the drop list and set again by the overlay: the inherited value must be gone.
  for (const [n, v] of Object.entries(env)) {
    if (inDropList(n, contract)) assert.ok(Object.hasOwn(profile.overlay, n) && v !== fixture.parent[n], `${n} inherited`);
  }
  assert.equal(env.CLAUDE_CONFIG_DIR, "X:\\vidar\\runtime\\homes\\claude-config");
  assert.equal(env.HOMEDRIVE, "X:");
  assert.equal(env.HOMEPATH, "\\vidar\\runtime\\homes\\user-home");
  assert.equal(env.Path, fixture.parent.Path, "first spelling and its value win");
  assert.equal(env["=ExitCode"], undefined, "only =X: drive entries are kept");
});
