// The Vidar-layer Driver Mode guard (tools/agent-layer/guard-driver.mjs) for bare tabs: blocks a
// builder or an in-root edit only for a Falcon session whose truth file is on, under --root, and
// fails open everywhere else (no FALCON_SESSION is every Raw bare tab). Wired by the bare settings
// template as a PreToolUse hook.
//
//   node --test tests\guard-driver-bare.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "../tools/lib/paths.mjs";

const GUARD = fileURLToPath(new URL("../tools/agent-layer/guard-driver.mjs", import.meta.url));
const SESSION = "s1234abcd-00000001";

function rig(on) {
  const root = mkdtempSync(join(tmpdir(), "guard-driver-"));
  const driver = resolvePath("driverMode", { root });
  mkdirSync(driver, { recursive: true });
  if (on !== undefined) writeFileSync(join(driver, `${SESSION}.json`), JSON.stringify({ on }));
  return root;
}

function call(root, payload, { session = SESSION, args = ["--root", root] } = {}) {
  const env = { ...process.env };
  delete env.FALCON_SESSION;
  if (session) env.FALCON_SESSION = session;
  return spawnSync(process.execPath, [GUARD, ...args], { input: JSON.stringify(payload), encoding: "utf8", env });
}

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("driver mode on blocks npm with the lane message", () => {
  const root = rig(true);
  try {
    const r = call(root, bash("npm run build"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /driver mode: spawn a lane/);
    assert.equal(call(root, bash("pwsh -Command \"cargo check\"")).status, 2);
    assert.equal(call(root, { tool_name: "Edit", tool_input: { file_path: join(root, "src", "a.ts") } }).status, 2);
    assert.equal(call(root, { tool_name: "Write", tool_input: { file_path: join(resolvePath("runs", { root }), "x", "NOTES.md") } }).status, 0);
    assert.equal(call(root, bash("git status")).status, 0);
    assert.equal(call(root, { ...bash("npm test"), agent_id: "a1" }).status, 0, "a subagent is delegation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("it fails open without FALCON_SESSION, with driver mode off, or without an absolute --root", () => {
  const root = rig(true);
  const off = rig(false);
  try {
    assert.equal(call(root, bash("npm run build"), { session: null }).status, 0, "a Raw bare tab");
    assert.equal(call(off, bash("npm run build")).status, 0);
    assert.equal(call(root, bash("npm run build"), { args: [] }).status, 0);
    assert.equal(call(root, bash("npm run build"), { args: ["--root", "relative"] }).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(off, { recursive: true, force: true });
  }
});

test("the bare settings template wires it as a PreToolUse hook by path with --root", () => {
  const t = JSON.parse(readFileSync(new URL("../profiles/bare/claude.settings.template.json", import.meta.url), "utf8"));
  const entry = t.hooks.PreToolUse.find((m) => m.hooks.some((h) => h.command.includes("guard-driver.mjs")));
  assert.ok(entry, "no guard-driver PreToolUse hook");
  assert.match(entry.matcher, /Bash/);
  assert.equal(entry.hooks[0].command, 'node "{{root}}\\tools\\agent-layer\\guard-driver.mjs" --root "{{root}}"');
});
