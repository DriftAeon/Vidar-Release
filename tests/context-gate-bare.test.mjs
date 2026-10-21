// The Vidar copy of the context gate (tools/agent-layer/context-gate.mjs) for bare tabs: config and
// state under the bare home's claude-config, token source (b) under --root's sessions folder, the
// same silent no-op rules as the global hook. USERPROFILE/HOME point at a trap folder that must stay empty.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "../tools/lib/paths.mjs";

const GATE = fileURLToPath(new URL("../tools/agent-layer/context-gate.mjs", import.meta.url));
const SID = "0a33187a-0000-4000-8000-000000000001";
const TAB = "s3-abc123";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "context-gate-"));
  const root = join(dir, "root");
  const home = join(dir, "homes");
  const cfg = join(home, "claude-config");
  const trap = join(dir, "trap");
  for (const d of [root, cfg, trap]) mkdirSync(d, { recursive: true });
  const sessions = resolvePath("sessions", { root });
  mkdirSync(sessions, { recursive: true });
  return { dir, root, home, cfg, trap, sessions, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The status line payload the bridge writes: `used` tokens of a 1M window. */
function status(sb, used, sid = SID) {
  writeFileSync(join(sb.sessions, `${TAB}.json`), JSON.stringify({
    session_id: sid,
    context_window: { context_window_size: 1000000, current_usage: { input_tokens: used, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }));
}

function run(sb, event, input, { argv, env } = {}) {
  return spawnSync(process.execPath, [GATE, event, ...(argv ?? ["--root", sb.root, "--home", sb.home])], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, VIDAR_TAB: TAB, USERPROFILE: sb.trap, HOME: sb.trap, CONTEXT_GATE: "", CONTEXT_GATE_BUDGET: "", ...env },
  });
}

const HOOK = { session_id: SID, cwd: "C:\\work\\trial-repo" };

test("below the trigger: silent no-op", () => {
  const sb = sandbox();
  try {
    status(sb, 50_000);
    for (const ev of ["prompt", "stop"]) {
      const r = run(sb, ev, HOOK);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    }
    assert.deepEqual(readdirSync(sb.trap), []);
  } finally {
    sb.done();
  }
});

test("prompt past the trigger injects additionalContext with a handoff path in the bare home", () => {
  const sb = sandbox();
  try {
    status(sb, 190_000); // default trigger: 200000 - 20000 = 180000
    const r = run(sb, "prompt", HOOK);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const text = out.hookSpecificOutput.additionalContext;
    assert.ok(text.includes(join(sb.cfg, "handoffs", "C-work-trial-repo") + "\\"), text);
    assert.match(text, /-0a33187a\.md/);
    assert.match(text, /State, Next, Paths and Questions/);
    assert.deepEqual(readdirSync(sb.trap), [], "nothing written into the real profile");
    assert.ok(readdirSync(join(sb.cfg, "context-gate")).includes(`${SID}.json`), "crossing state lands in the bare home");
  } finally {
    sb.done();
  }
});

test("the threshold comes from <home>\\claude-config\\context-gate.json", () => {
  const sb = sandbox();
  try {
    status(sb, 120_000);
    assert.equal(run(sb, "prompt", HOOK).stdout, "", "120000 is under the default trigger");
    writeFileSync(join(sb.cfg, "context-gate.json"), JSON.stringify({ budget: 130_000, headroom: 20_000 }));
    assert.notEqual(run(sb, "prompt", HOOK).stdout, "", "trigger is now 110000");
  } finally {
    sb.done();
  }
});

test("--home may name the claude-config folder itself", () => {
  const sb = sandbox();
  try {
    status(sb, 190_000);
    const r = run(sb, "prompt", HOOK, { argv: ["--root", sb.root, "--home", sb.cfg] });
    assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes(join(sb.cfg, "handoffs")), r.stdout);
  } finally {
    sb.done();
  }
});

test("stop blocks once; a fresh handoff ends both the block and the re-instruction", () => {
  const sb = sandbox();
  try {
    status(sb, 190_000);
    const first = JSON.parse(run(sb, "stop", HOOK).stdout);
    assert.equal(first.decision, "block");
    assert.match(first.reason, /^Before stopping: /);
    assert.equal(run(sb, "stop", { ...HOOK, stop_hook_active: true }).stdout, "");

    const slugDir = join(sb.cfg, "handoffs", "C-work-trial-repo");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, "2026-10-13-1200-0a33187a.md"), "# State\n");
    assert.equal(run(sb, "stop", HOOK).stdout, "");
    const after = JSON.parse(run(sb, "prompt", HOOK).stdout);
    assert.match(after.hookSpecificOutput.additionalContext, /handoff already exists at .*0a33187a\.md/);
  } finally {
    sb.done();
  }
});

test("silent no-ops: subagent, CONTEXT_GATE=0, other session, stale source, bad stdin", () => {
  const sb = sandbox();
  try {
    status(sb, 190_000);
    assert.equal(run(sb, "prompt", { ...HOOK, agent_id: "a1" }).stdout, "");
    assert.equal(run(sb, "prompt", HOOK, { env: { CONTEXT_GATE: "0" } }).stdout, "");
    assert.equal(run(sb, "prompt", { ...HOOK, session_id: "ffffffff-0000-4000-8000-000000000009" }).stdout, "");
    writeFileSync(join(sb.cfg, "context-gate.json"), JSON.stringify({ sourceMaxAgeSec: -1 }));
    assert.equal(run(sb, "prompt", HOOK).stdout, "", "a source older than sourceMaxAgeSec");
    const bad = spawnSync(process.execPath, [GATE, "prompt", "--root", sb.root, "--home", sb.home], { input: "{ nope", encoding: "utf8" });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, "");
  } finally {
    sb.done();
  }
});

test("missing or relative arguments: one stderr line, empty stdout, exit 0", () => {
  const sb = sandbox();
  try {
    status(sb, 190_000);
    for (const argv of [[], ["--root", sb.root], ["--root", "rel", "--home", sb.home], ["--root", sb.root, "--home", "homes"]]) {
      const r = run(sb, "prompt", HOOK, { argv });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^context-gate: .+\n$/);
    }
  } finally {
    sb.done();
  }
});

test("the bare settings template holds both gate hooks as arrays, by path with --root and --home", () => {
  const t = JSON.parse(readFileSync(new URL("../profiles/bare/claude.settings.template.json", import.meta.url), "utf8"));
  for (const [event, arg] of [["UserPromptSubmit", "prompt"], ["Stop", "stop"]]) {
    assert.ok(Array.isArray(t.hooks[event]), `${event} is an array`);
    const cmd = t.hooks[event][0].hooks[0].command;
    assert.equal(cmd, `node "{{root}}\\tools\\agent-layer\\context-gate.mjs" ${arg} --root "{{root}}" --home "{{home}}"`);
  }
  assert.ok(Array.isArray(t.hooks.InstructionsLoaded));
});

test("the vidar-app plugin ships both handoff skills with no user-home reference", () => {
  for (const name of ["catapult", "handoff"]) {
    const text = readFileSync(new URL(`../plugins/vidar-app/skills/${name}/SKILL.md`, import.meta.url), "utf8");
    assert.match(text, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
    assert.match(text, /VIDAR_AGENT_HOME/);
    assert.doesNotMatch(text, /~[\\/]\.claude|\.claude[\\/]|USERPROFILE|runes/i);
  }
});

test("the skills follow the gate: the writer appends one Answer line, the successor never edits", () => {
  const line = "Answer: <question> -> <answer>";
  const skill = (name) => readFileSync(new URL(`../plugins/vidar-app/skills/${name}/SKILL.md`, import.meta.url), "utf8");
  assert.ok(readFileSync(GATE, "utf8").includes(line), "the gate asks for the Answer line");
  assert.ok(skill("handoff").includes(line), "handoff names the gate's Answer line");
  assert.doesNotMatch(skill("handoff"), /never edit the file again/i);
  assert.match(skill("catapult"), /Never edit the handoff file/);
});
