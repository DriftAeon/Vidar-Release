// tools/bare/guard-probe.mjs pure parts: settings parse -> guard list, the expected table, --emit shape, the
// verdict rule and the Bare env (importing the module spawns nothing; main runs only as a script).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { BLOCK_TARGETS, CODEX_GUARDS, bareEnv, codexCases, codexCommand, codexHookLines, commandTokens, emitBareGuards, emitCodexGuards, guardList, judgeCase, judgeCodexCase, probeCases, psQuote, tripLogPath, tripsPathOf } from "../tools/bare/guard-probe.mjs";

const cmd = (...p) => `node ${p.map((x) => `"${x}"`).join(" ")}`;
const hook = (command) => ({ type: "command", command });
const settings = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash|Write", hooks: [hook(cmd("H/fail-closed.mjs", "H/guard-install.mjs"))] },
      { matcher: "Bash|PowerShell", hooks: [hook(cmd("H/fail-closed.mjs", "H/guard-crawl.mjs")), hook(cmd("H/guard-driver.mjs"))] },
      { matcher: "Read", hooks: [hook(cmd("H/warn-read-size.mjs"))] },
    ],
    Stop: [{ hooks: [hook(cmd("H/guard-bang-length.mjs"))] }],
  },
};

test("commandTokens: drops node, keeps quoted paths whole", () => {
  assert.deepEqual(commandTokens('node "C:\\a b\\x.mjs" "y.mjs" --flag'), ["C:\\a b\\x.mjs", "y.mjs", "--flag"]);
});

test("guardList: only block targets, wrapper kept in run, matcher and event carried", () => {
  const l = guardList(settings);
  assert.deepEqual(l.map((x) => x.guard), ["guard-install", "guard-crawl"]);
  assert.deepEqual(l[0].run, ["H/fail-closed.mjs", "H/guard-install.mjs"]);
  assert.equal(l[1].event, "PreToolUse");
  assert.equal(l[1].matcher, "Bash|PowerShell");
});

test("emitBareGuards: { event, matcher?, run } and nothing else", () => {
  const e = emitBareGuards(settings);
  assert.deepEqual(e[0], { event: "PreToolUse", matcher: "Bash|Write", run: ["H/fail-closed.mjs", "H/guard-install.mjs"] });
  assert.equal(e.length, 2);
  assert.deepEqual(emitBareGuards({}), []);
});

test("probeCases: one case per block target, aliased and Stop guards absent", () => {
  const cases = probeCases({ realClaude: "R/.claude", cwd: "W" });
  assert.deepEqual(cases.map((c) => c.guard), BLOCK_TARGETS);
  assert.equal(new Set(BLOCK_TARGETS).size, 6);
  for (const g of ["guard-bang-length", "guard-driver"]) assert.ok(!BLOCK_TARGETS.includes(g));
  assert.equal(cases[0].expect.exit, 2);
  assert.ok(cases[0].payload.tool_input.file_path.replaceAll("\\", "/").startsWith("R/.claude"));
  assert.ok(cases[0].payload.agent_id);
});

test("judgeCase: exit must match; ask needs the decision", () => {
  assert.equal(judgeCase({ exit: 2 }, { status: 2, stdout: "" }).ok, true);
  assert.equal(judgeCase({ exit: 2 }, { status: 0, stdout: "" }).ok, false);
  const ask = JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } });
  assert.equal(judgeCase({ exit: 0, ask: true }, { status: 0, stdout: ask }).ok, true);
  assert.equal(judgeCase({ exit: 0, ask: true }, { status: 0, stdout: "" }).ok, false);
});

test("bareEnv: user-home and config dir set, GUARD_* and CLAUDE_* dropped", () => {
  const e = bareEnv("B", { PATH: "p", GUARD_TRIPS_PATH: "x", CLAUDE_CONFIG_DIR: "y", HOME: "real" });
  assert.equal(e.PATH, "p");
  assert.ok(!("GUARD_TRIPS_PATH" in e));
  assert.ok(/user-home$/.test(e.USERPROFILE) && e.HOME === e.USERPROFILE);
  assert.ok(/claude-config$/.test(e.CLAUDE_CONFIG_DIR));
});

test("tripLogPath: the real home's hooks folder as the guards resolve it, never USERPROFILE or the guard's folder", () => {
  const real = join(userInfo().homedir, ".claude", "hooks", "trip-log.mjs");
  assert.equal(tripLogPath({ USERPROFILE: "B/user-home", HOME: "B/user-home" }), real);
  assert.equal(tripLogPath(bareEnv("B", {})), real);
  assert.equal(tripLogPath({ GUARD_REAL_HOME: "R" }), join("R", ".claude", "hooks", "trip-log.mjs"));
});

test("tripsPathOf: reads tripsPath() from the real home's trip-log.mjs, so a copied guard reports the same ledger", () => {
  const real = mkdtempSync(join(tmpdir(), "guard-probe-real-"));
  try {
    const env = { ...process.env, GUARD_REAL_HOME: real };
    assert.equal(tripsPathOf(env), "no tripsPath");
    const hooks = join(real, ".claude", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "trip-log.mjs"), `export function tripsPath() { return "LEDGER"; }\n`);
    assert.equal(tripsPathOf(env), "LEDGER");
  } finally { rmSync(real, { recursive: true, force: true }); }
});

// ---- --codex ----

test("psQuote and codexCommand: single quotes doubled, -- flags bare, call operator first, exit relay last", () => {
  assert.equal(psQuote("a'b"), "'a''b'");
  assert.equal(codexCommand("N", ["F", "--guard", "G"]), "& 'N' 'F' --guard 'G'; exit $LASTEXITCODE");
});

test("codexHookLines: PreToolUse runs wrapper, shim, --guard each, --open-guard each, from the copy dir", () => {
  const dir = join("H", "layer", "hooks");
  const [l] = codexHookLines([{ event: "PreToolUse", matcher: "Bash|apply_patch", run: ["X/fail-closed.mjs", "X/guard-install.mjs", "X/guard-cwd.mjs"], open: ["X/guard-driver.mjs"] }], { node: "N", dir });
  const p = (f) => psQuote(join(dir, f));
  assert.equal(l.matcher, "Bash|apply_patch");
  assert.equal(l.line, `& 'N' ${p("fail-closed.mjs")} ${p("codex-shim.mjs")} --guard ${p("guard-install.mjs")} --guard ${p("guard-cwd.mjs")} --open-guard ${p("guard-driver.mjs")}; exit $LASTEXITCODE`);
});

test("codexHookLines: unwrapped list has no wrapper token; another event runs its run list directly", () => {
  const dir = "D";
  const lines = codexHookLines([
    { event: "PreToolUse", run: ["X/guard-cwd.mjs"] },
    { event: "Stop", run: ["X/a.mjs", "X/b.mjs"] },
  ], { node: "N", dir });
  assert.equal(lines[0].line, `& 'N' ${psQuote(join(dir, "codex-shim.mjs"))} --guard ${psQuote(join(dir, "guard-cwd.mjs"))}; exit $LASTEXITCODE`);
  assert.equal(lines[1].line, `& 'N' ${psQuote(join(dir, "a.mjs"))} ${psQuote(join(dir, "b.mjs"))}; exit $LASTEXITCODE`);
  assert.ok(!("matcher" in lines[0]));
});

test("emitCodexGuards: wrapper, the three Codex guards in order, guard-driver open; empty without guards", () => {
  const s = { hooks: { PreToolUse: [
    { matcher: "Bash|PowerShell", hooks: [hook(cmd("H/fail-closed.mjs", "H/guard-crawl.mjs")), hook(cmd("H/fail-closed.mjs", "H/guard-cwd.mjs")), hook(cmd("H/guard-driver.mjs"))] },
    { matcher: "Bash|Write", hooks: [hook(cmd("H/fail-closed.mjs", "H/guard-install.mjs"))] },
    { matcher: "Bash", hooks: [hook(cmd("H/fail-closed.mjs", "H/guard-bash-write.mjs"))] },
  ] } };
  assert.deepEqual(emitCodexGuards(s), [{ event: "PreToolUse", matcher: "Bash|apply_patch",
    run: ["H/fail-closed.mjs", "H/guard-install.mjs", "H/guard-crawl.mjs", "H/guard-cwd.mjs"], open: ["H/guard-driver.mjs"] }]);
  assert.deepEqual(CODEX_GUARDS, ["guard-install", "guard-crawl", "guard-cwd"]);
  assert.deepEqual(emitCodexGuards({}), []);
});

test("codexCases: Bash allow, Bash blocked, apply_patch blocked; PreToolUse payload shape", () => {
  const c = codexCases({ realClaude: "R/home", cwd: "W" });
  assert.deepEqual(c.map((x) => x.name), ["Bash allow", "Bash blocked", "apply_patch blocked"]);
  assert.deepEqual(c.map((x) => x.expect.exit), [0, 2, 2]);
  assert.ok(c.slice(1).every((x) => x.expect.stderr));
  for (const x of c) {
    assert.equal(x.payload.hook_event_name, "PreToolUse");
    assert.equal(typeof x.payload.tool_input.command, "string");
  }
  assert.equal(c[2].payload.tool_name, "apply_patch");
  assert.ok(c[2].payload.tool_input.command.includes("*** Add File: " + join("R/home", "guard-probe.txt")));
});

test("judgeCodexCase: a block needs exit 2 and a non-empty stderr", () => {
  assert.equal(judgeCodexCase({ exit: 2, stderr: true }, { status: 2, stderr: "reason" }).ok, true);
  assert.equal(judgeCodexCase({ exit: 2, stderr: true }, { status: 2, stderr: "  \n" }).ok, false);
  assert.equal(judgeCodexCase({ exit: 2, stderr: true }, { status: 1, stderr: "x" }).ok, false);
  assert.equal(judgeCodexCase({ exit: 0 }, { status: 0, stderr: "" }).ok, true);
});
