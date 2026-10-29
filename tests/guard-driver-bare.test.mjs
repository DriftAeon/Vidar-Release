// The Vidar-layer Driver Mode guard (tools/agent-layer/guard-driver.mjs) for bare tabs: blocks a
// builder or an in-root edit only for a Falcon session whose truth file is on, under --root, and
// fails open everywhere else (no FALCON_SESSION is every Raw bare tab). Wired as a PreToolUse hook by
// the stock hook rune profiles/bare/stock-runes/hooks/guard-driver.md.
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

test("the stock guard-driver hook rune wires it as a PreToolUse hook by path with --root, not the template", () => {
  // The hook reaches a session only through its vault's stock rune.
  const rune = readFileSync(new URL("../profiles/bare/stock-runes/hooks/guard-driver.md", import.meta.url), "utf8").replace(/\r/g, "");
  const field = (k) => rune.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1];
  assert.equal(field("kind"), "hook");
  assert.equal(field("event"), "PreToolUse");
  assert.match(field("matcher") ?? "", /Bash/);
  assert.equal(field("command"), 'node "{{root}}\\tools\\agent-layer\\guard-driver.mjs" --root "{{root}}"');
  const t = readFileSync(new URL("../profiles/bare/claude.settings.template.json", import.meta.url), "utf8");
  assert.ok(!t.includes("guard-driver.mjs"), "the settings template still wires guard-driver");
});

test("the stock mcp-gate hook rune wires the MCP gate as a PreToolUse hook by path, not the template", () => {
  // The hook reaches a session only through its vault's stock rune.
  const rune = readFileSync(new URL("../profiles/bare/stock-runes/hooks/mcp-gate.md", import.meta.url), "utf8").replace(/\r/g, "");
  const field = (k) => rune.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1];
  assert.equal(field("kind"), "hook");
  assert.equal(field("agent"), "claude");
  assert.equal(field("event"), "PreToolUse");
  assert.equal(field("matcher"), "mcp__.*");
  assert.equal(field("command"), 'node "{{root}}\\tools\\bare\\mcp-gate.mjs"');
  const t = readFileSync(new URL("../profiles/bare/claude.settings.template.json", import.meta.url), "utf8");
  assert.ok(!t.includes("mcp-gate.mjs"), "the settings template still wires mcp-gate");
  JSON.parse(t);
  const stock = readFileSync(new URL("../profiles/bare/templates/stock-claude.json", import.meta.url), "utf8");
  assert.ok(stock.includes('"mcp-gate"'), "stock-claude does not slot mcp-gate");
});
