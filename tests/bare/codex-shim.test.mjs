// tools/bare/codex-shim.mjs: Codex payload -> Claude-contract guards. The guards are copies of the four real ones
// (read from the account's ~\.claude\hooks, never edited there) in a temp dir; the shim is given their paths.
// Payload fixtures are the live-probe captures (see codex-shim.fixtures.mjs). Real-guard tests are skipped when the
// guards are not on disk.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mapPayload, splitPatch } from "../../tools/bare/codex-shim.mjs";
import { REAL_PATCH_ADD, REAL_PATCH_UPDATE, REAL_SHELL, TWO_FILE_PATCH, patch, shell } from "./codex-shim.fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = resolve(HERE, "..", "..", "tools", "bare", "codex-shim.mjs");
const REAL_HOOKS = join(userInfo().homedir, ".claude", "hooks");
const NAMES = ["fail-closed", "guard-install", "guard-crawl", "guard-cwd", "guard-driver"];
const haveGuards = NAMES.every((n) => existsSync(join(REAL_HOOKS, `${n}.mjs`)));
const real = { skip: haveGuards ? false : "real guards not found under ~\\.claude\\hooks" };

const scratch = mkdtempSync(join(tmpdir(), "codex-shim-"));
const hooks = join(scratch, "hooks");
const work = join(scratch, "work");
const root = join(scratch, "root"); // stands in for the repo root (GUARD_DRIVER_DIR)
for (const d of [hooks, work, join(root, "src"), join(scratch, "home")]) mkdirSync(d, { recursive: true });
if (haveGuards) for (const n of NAMES) copyFileSync(join(REAL_HOOKS, `${n}.mjs`), join(hooks, `${n}.mjs`));
const g = (n) => join(hooks, `${n}.mjs`);
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GUARD_|CLAUDE_|FALCON_)/.test(k)) delete env[k];
  return {
    ...env,
    USERPROFILE: scratch, HOME: scratch,
    GUARD_REAL_HOME: scratch, GUARD_TRIPS_PATH: join(scratch, "trips.jsonl"),
    GUARD_INSTALL_VETTED: join(scratch, "vetted.json"), GUARD_CWD_HOME: join(scratch, "home"),
    GUARD_DRIVER_DIR: root,
    ...extra,
  };
}

function run(payload, args, env = baseEnv(), { wrap = false } = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const argv = wrap ? [g("fail-closed"), SHIM, ...args] : [SHIM, ...args];
  const r = spawnSync(process.execPath, argv, { input, encoding: "utf8", env, timeout: 60000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const three = ["--guard", g("guard-install"), "--guard", g("guard-crawl"), "--guard", g("guard-cwd")];

function stub(name, body) {
  const p = join(scratch, `${name}.mjs`);
  writeFileSync(p, body);
  return p;
}

test("mapPayload: shell tool becomes PowerShell, argv arrays join, agent fields and extras pass through", () => {
  const m = mapPayload(shell(work, "ls", { agent_id: "a1", agent_type: "worker" }));
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].tool_name, "PowerShell");
  assert.equal(m.calls[0].tool_input.command, "ls");
  assert.equal(m.calls[0].agent_id, "a1");
  assert.equal(m.calls[0].agent_type, "worker");
  assert.equal(m.calls[0].cwd, work);
  const arr = mapPayload({ ...shell(work, "x"), tool_input: { command: ["pwsh", "-c", "ls"] } });
  assert.equal(arr.calls[0].tool_input.command, "pwsh -c ls");
});

test("mapPayload: the three real probe payloads map as captured", () => {
  const s = mapPayload(REAL_SHELL);
  assert.equal(s.calls[0].tool_name, "PowerShell");
  assert.equal(s.calls[0].tool_input.command, "echo P1W0-ALLOW");
  assert.equal(s.calls[0].turn_id, REAL_SHELL.turn_id);
  const add = mapPayload(REAL_PATCH_ADD);
  assert.equal(add.calls.length, 1);
  assert.equal(add.calls[0].tool_name, "Write");
  assert.match(add.calls[0].tool_input.file_path, /probe\.txt$/);
  assert.equal(add.calls[0].tool_input.content, "P1W0-PATCH");
  const upd = mapPayload(REAL_PATCH_UPDATE);
  assert.equal(upd.calls[0].tool_name, "Edit");
  assert.equal(upd.calls[0].tool_input.old_string, "P1W0-PATCH");
  assert.equal(upd.calls[0].tool_input.new_string, "P1W0-PATCH-2");
});

test("real fixtures through the shim: allow path exits 0 with no output", () => {
  const ok = stub("ok-real", `process.exit(0);`);
  for (const p of [REAL_SHELL, REAL_PATCH_ADD, REAL_PATCH_UPDATE]) {
    const r = run(p, ["--guard", ok]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  }
});

test("real fixtures through the real guards: allowed; a blocked command from the real shape is blocked", real, () => {
  for (const p of [REAL_SHELL, REAL_PATCH_ADD, REAL_PATCH_UPDATE]) {
    const r = run({ ...p, cwd: work }, three);
    assert.equal(r.status, 0, r.stderr);
  }
  const blocked = run({ ...REAL_SHELL, cwd: work, tool_input: { command: "find / -name x" } }, three);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /crawl guard: BLOCKED/);
});

test("a silent guard exit 2 gets a fallback reason naming the guard file (blocking and open guards)", () => {
  const silent = stub("guard-silent", `process.exit(2);`);
  const spaces = stub("guard-spaces", `process.stderr.write("  \\n");process.exit(2);`);
  const sh = shell(work, "ls");
  for (const [args, name] of [[["--guard", silent], "guard-silent.mjs"], [["--guard", spaces], "guard-spaces.mjs"],
    [["--guard", stub("okg", `process.exit(0);`), "--open-guard", silent], "guard-silent.mjs"]]) {
    const r = run(sh, args);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `Blocked by ${name}.\n`);
  }
  if (haveGuards) {
    const w = run(sh, ["--guard", silent], baseEnv(), { wrap: true });
    assert.equal(w.status, 2);
    assert.match(w.stderr, /Blocked by guard-silent\.mjs\./);
  }
});

test("a JSON deny with no reason still carries one", () => {
  const deny = stub("deny-bare", `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"deny"}}));`);
  const r = run(shell(work, "ls"), ["--guard", deny]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.trim().length > 0);
});

test("every real-guard block carries a non-empty stderr", real, () => {
  const cases = [
    shell(work, "Invoke-WebRequest https://example.com/a.zip -OutFile a.zip"),
    shell(work, "find / -name x"),
    shell(work, "cd ~/.claude"),
  ];
  for (const c of cases) {
    const r = run(c, three);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.trim().length > 0, JSON.stringify(c.tool_input));
  }
});

test("shim's own fail-closed paths (unknown tool, bad payload, no guards) write a reason", () => {
  const ok = stub("ok-reason", `process.exit(0);`);
  for (const [payload, args] of [[{ ...shell(work, "ls"), tool_name: "web_search" }, ["--guard", ok]], ["not json", ["--guard", ok]],
    [shell(work, "ls"), []]]) {
    const r = run(payload, args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^codex shim: .+blocked, fail closed/);
  }
});

test("mapPayload: unknown shapes are flagged", () => {
  for (const bad of [null, [], "x", { tool_name: "WebSearch", tool_input: {} }, { tool_name: "mcp__a__b", tool_input: {} },
    { tool_input: {} }, { tool_name: "Bash" }, { ...shell(work, "ls"), hook_event_name: "PostToolUse" },
    patch(work, "*** Begin Patch\n*** End Patch")]) {
    assert.ok(mapPayload(bad).unknown, JSON.stringify(bad));
  }
});

test("splitPatch: add body, update hunks, delete and move", () => {
  const ops = splitPatch(`${TWO_FILE_PATCH}*** Delete File: gone.txt\n*** Update File: a.txt\n*** Move to: b.txt\n`);
  assert.deepEqual(ops.map((o) => [o.kind, o.path]), [["add", "src/new-thing.ts"], ["update", "src/old-thing.ts"], ["delete", "gone.txt"], ["update", "a.txt"], ["move", "b.txt"]]);
  assert.equal(ops[0].body, "export const a = 1;\nexport const b = 2;");
  assert.equal(ops[1].oldText, "keep\nbefore");
  assert.equal(ops[1].newText, "keep\nafter");
});

test("apply_patch with two files: two guard calls, Write then Edit, absolute paths, passthrough and project dir", () => {
  const rec = join(scratch, "rec.jsonl");
  const recorder = stub("recorder", `import{appendFileSync,readFileSync}from"node:fs";const p=JSON.parse(readFileSync(0,"utf8"));appendFileSync(${JSON.stringify(rec)},JSON.stringify({p,proj:process.env.CLAUDE_PROJECT_DIR,cwd:process.cwd()})+"\\n");`);
  const r = run(patch(work, TWO_FILE_PATCH, { agent_id: "sub-1", agent_type: "worker" }), ["--guard", recorder]);
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(rec, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.p.tool_name), ["Write", "Edit"]);
  assert.equal(lines[0].p.tool_input.file_path, resolve(work, "src/new-thing.ts"));
  assert.equal(lines[0].p.tool_input.content, "export const a = 1;\nexport const b = 2;");
  assert.equal(lines[1].p.tool_input.old_string, "keep\nbefore");
  assert.equal(lines[1].p.tool_input.new_string, "keep\nafter");
  for (const l of lines) {
    assert.equal(l.p.agent_id, "sub-1");
    assert.equal(l.p.agent_type, "worker");
    assert.equal(l.proj, work);
  }
});

test("guard-install blocks a download through the shim, exit 2 and its stderr relayed", real, () => {
  const r = run(shell(work, "Invoke-WebRequest https://example.com/a.zip -OutFile a.zip"), three);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /install guard: BLOCKED/);
});

test("guard-install sees apply_patch content: a download script is blocked, a plain source file passes", real, () => {
  const bad = patch(work, "*** Begin Patch\n*** Add File: get.ps1\n+Invoke-WebRequest https://example.com/a.zip -OutFile a.zip\n*** End Patch\n");
  const r = run(bad, three);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /install guard: BLOCKED/);
  const ok = run(patch(work, "*** Begin Patch\n*** Add File: note.ts\n+export const a = 1;\n*** End Patch\n"), three);
  assert.equal(ok.status, 0, ok.stderr);
});

test("guard-crawl blocks a drive-root search through the shim", real, () => {
  const r = run(shell(work, "find / -name x"), three);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /crawl guard: BLOCKED/);
});

test("guard-cwd blocks a cd into .claude through the shim", real, () => {
  const r = run(shell(work, "cd ~/.claude"), three);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cwd guard: BLOCKED/);
});

test("an ordinary command passes all three guards, stdout empty", real, () => {
  const r = run(shell(work, "git status"), three);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("guard-driver: on blocks an edit in the repo; off, missing truth file or missing FALCON_SESSION allows", real, () => {
  const truth = join(root, "runtime", "bridge", "driver");
  const args = [...three, "--open-guard", g("guard-driver")];
  const edit = patch(root, "*** Begin Patch\n*** Add File: src/x.ts\n+export const a = 1;\n*** End Patch\n");
  const env = baseEnv({ FALCON_SESSION: "s1" });

  assert.equal(run(edit, args, env).status, 0, "no truth file allows");

  mkdirSync(truth, { recursive: true });
  writeFileSync(join(truth, "s1.json"), JSON.stringify({ on: true }));
  const on = run(edit, args, env);
  assert.equal(on.status, 2);
  assert.match(on.stderr, /driver mode/);
  assert.equal(run(shell(root, "cargo build"), args, env).status, 2, "a build is blocked too");
  assert.equal(run(edit, args, baseEnv()).status, 0, "no FALCON_SESSION allows");

  writeFileSync(join(truth, "s1.json"), JSON.stringify({ on: false }));
  assert.equal(run(edit, args, env).status, 0, "off allows");
  writeFileSync(join(truth, "s1.json"), "{not json");
  assert.equal(run(edit, args, env).status, 0, "unreadable truth file allows");
});

test("a crashing or missing driver allows; a crashing or missing blocking guard blocks", () => {
  const crash = stub("crash", `throw new Error("boom");`);
  const ok = stub("ok", `process.exit(0);`);
  const sh = shell(work, "ls");
  assert.equal(run(sh, ["--guard", ok, "--open-guard", crash]).status, 0);
  assert.equal(run(sh, ["--guard", ok, "--open-guard", join(scratch, "nope.mjs")]).status, 0);
  const bad = run(sh, ["--guard", crash, "--guard", ok]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /fail closed/);
  const gone = run(sh, ["--guard", join(scratch, "nope.mjs")]);
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /missing/);
});

test("fail-closed wrapper in front: bad guard blocks, good chain relays exit 2 and stderr", real, () => {
  const crash = stub("crash2", `throw new Error("boom");`);
  const bad = run(shell(work, "ls"), ["--guard", crash], baseEnv(), { wrap: true });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /fail closed/);
  const blocked = run(shell(work, "find / -name x"), three, baseEnv(), { wrap: true });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /crawl guard: BLOCKED/);
  assert.equal(run(shell(work, "git status"), three, baseEnv(), { wrap: true }).status, 0);
});

test("first block wins: later guards do not run", () => {
  const rec = join(scratch, "after.txt");
  const blocker = stub("blocker", `process.stderr.write("first says no\\n");process.exit(2);`);
  const after = stub("after", `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(rec)},"ran");`);
  const r = run(shell(work, "ls"), ["--guard", blocker, "--guard", after]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "first says no\n");
  assert.equal(existsSync(rec), false);
});

test("guard stdout: non-JSON is swallowed, a JSON deny blocks, other JSON passes silently", () => {
  const noisy = stub("noisy", `process.stdout.write("hello\\n");`);
  const r = run(shell(work, "ls"), ["--guard", noisy]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const deny = stub("deny", `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:"nope"}}));`);
  const d = run(shell(work, "ls"), ["--guard", deny]);
  assert.equal(d.status, 2);
  assert.match(d.stderr, /nope/);
  const ask = stub("ask", `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"ask"}}));`);
  const a = run(shell(work, "ls"), ["--guard", ask]);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, "");
});

test("unknown tool, non-JSON stdin and no guards all block, and the unknown shapes are logged", () => {
  const log = join(scratch, "shim.log");
  const ok = stub("ok2", `process.exit(0);`);
  const args = ["--guard", ok, "--log", log];
  const u = run({ ...shell(work, "ls"), tool_name: "web_search" }, args);
  assert.equal(u.status, 2);
  assert.match(u.stderr, /no mapping/);
  const j = run("not json", args);
  assert.equal(j.status, 2);
  const none = run(shell(work, "ls"), []);
  assert.equal(none.status, 2);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /unknown payload shape: tool "web_search"/);
  assert.match(lines[1], /not a JSON object/);
});

test("guards come from args or env, never a default", () => {
  const ok = stub("ok3", `process.exit(0);`);
  const sh = shell(work, "ls");
  assert.equal(run(sh, [], baseEnv({ CODEX_SHIM_GUARDS: ok })).status, 0);
  const blocker = stub("blocker2", `process.exit(2);`);
  assert.equal(run(sh, [], baseEnv({ CODEX_SHIM_GUARDS: ok, CODEX_SHIM_OPEN_GUARDS: blocker })).status, 2);
});
