// Guard probe (bare-mode slice 1, W0): does each global block-target guard still block under the Bare PTY env?
// Per guard it sends one crafted PreToolUse payload through the command the settings file wires (wrapper
// included), with USERPROFILE and HOME at <home>\user-home and CLAUDE_CONFIG_DIR set, as a Bare tab has them,
// and prints the exit code against the expected one. Any mismatch exits 1. Run before the guards resolve the
// real home (WG: guard-install and guard-agent-brief allow, fail open) and again after.
//
// Usage: node tools/bare/guard-probe.mjs [--settings <settings.json>] [--home <dir>] [--emit] [--codex [--config <vidar.json>]]
//   --codex     probe the Codex hook lines instead: read `bareCodexGuards` from --config (default <repo>/vidar.json),
//               copy the files to <home>\layer\hooks and build each line as `guards::copy_codex` does (call operator,
//               PowerShell single quotes, `; exit $LASTEXITCODE`), then send three real PreToolUse payloads (Bash
//               allow, Bash blocked, apply_patch blocked; shapes from p1w0-live.md) through
//               `pwsh -NoProfile -Command <line>`, as Codex runs commandWindows. Every block must exit 2 with a
//               non-empty stderr (Codex ignores a silent exit 2). With --emit: print `bareCodexGuards` instead.
//   --emit      adds a top-level `agent` field: "claude" with `bareGuards`, "codex" with `bareCodexGuards`.
//   --settings  the global settings file whose hooks are probed; default <real home>\.claude\settings.json.
//   --home      a Bare home (the folder holding user-home and claude-config); default a scratch folder under
//               the OS temp dir. The probe only reads from it; it creates user-home and claude-config if absent.
//   --emit      print `bareGuards` (JSON) for the block targets and run nothing: each `run` is the command's
//               quoted tokens as the settings have them, wrapper first. Aliased guards stay out (guard-driver),
//               as do guards that cannot block (guard-bang-length is a Stop hook).
//
// Trip targets: the guards' trip-log.mjs (<real home>\.claude\hooks, as the guards resolve it, so a copied
// guard in <home>\layer\hooks\ reports the same file) `tripsPath()` is read in a child under the Bare env and printed;
// `no tripsPath` when the file does not export it (WG adds it). The guards themselves run with
// GUARD_TRIPS_PATH at a scratch file, so the probe never appends to the real ledger.
// guard-blender asks (exit 0, permissionDecision "ask") instead of exiting 2; the table expects that.
// The guards' own tests pin the home and are not run here.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(HERE, "..", "..");
const WRAPPER = "fail-closed";

// Probe cases, one per block-target guard. `real` is the real home's .claude folder (a path argument at run
// time, never a literal). `expect`: exit code, plus `ask` when the exit-0 reply must carry permissionDecision ask.
export function probeCases({ realClaude, cwd }) {
  const sub = { agent_id: "probe-sub", agent_type: "Striker", cwd };
  return [
    { guard: "guard-install", expect: { exit: 2 },
      payload: { ...sub, tool_name: "Write", tool_input: { file_path: join(realClaude, "guard-probe.txt"), content: "x" } } },
    { guard: "guard-bash-write", expect: { exit: 2 },
      payload: { tool_name: "Bash", cwd, tool_input: { command: "echo x > guard-probe.txt" } } },
    { guard: "guard-crawl", expect: { exit: 2 },
      payload: { tool_name: "Bash", cwd, tool_input: { command: "find /c/ -name guard-probe" } } },
    { guard: "guard-cwd", expect: { exit: 2 },
      payload: { tool_name: "Bash", cwd, tool_input: { command: "cd ~/.claude && ls" } } },
    { guard: "guard-agent-brief", expect: { exit: 2 },
      payload: { tool_name: "Agent", cwd, tool_input: { subagent_type: "Explore", prompt: "use the Write tool" } } },
    { guard: "guard-blender", expect: { exit: 0, ask: true },
      payload: { tool_name: "mcp__blender__execute_blender_code", cwd, tool_input: { code: "import bpy, os\nos.listdir('.')" } } },
  ];
}

export const BLOCK_TARGETS = probeCases({ realClaude: "", cwd: "" }).map((c) => c.guard);

// Quoted-or-bare tokens of a hook command, `node` dropped.
export function commandTokens(command) {
  const out = [];
  for (const m of String(command).matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out[0] && /^node(\.exe)?$/i.test(out[0]) ? out.slice(1) : out;
}

// Settings hooks -> one entry per command whose script is a block target:
// { guard, event, matcher?, command, run: [tokens...] }. Order follows the file.
export function guardList(settings, targets = BLOCK_TARGETS) {
  const list = [];
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    for (const g of groups ?? []) {
      for (const h of g.hooks ?? []) {
        if (h?.type !== "command" || typeof h.command !== "string") continue;
        const run = commandTokens(h.command);
        const scripts = run.filter((t) => /\.mjs$/i.test(t)).map((t) => basename(t.replaceAll("\\", "/"), ".mjs"));
        const guard = scripts.filter((s) => s !== WRAPPER).pop();
        if (!guard || !targets.includes(guard)) continue;
        const e = { guard, event, command: h.command, run };
        if (g.matcher) e.matcher = g.matcher;
        list.push(e);
      }
    }
  }
  return list;
}

// The `bareGuards` value for vidar.json.
export function emitBareGuards(settings) {
  return guardList(settings).map(({ guard, command, ...rest }) => {
    const { event, matcher, run } = rest;
    return matcher ? { event, matcher, run } : { event, run };
  });
}

// ---- Codex (`bareCodexGuards`) ----

export const CODEX_GUARDS = ["guard-install", "guard-crawl", "guard-cwd"];
const CODEX_OPEN = ["guard-driver"];
const CODEX_MATCHER = "Bash|apply_patch";

// The `bareCodexGuards` value for vidar.json, derived from the Claude settings: the wrapper, the three blocking
// guards in CODEX_GUARDS order, guard-driver as the open guard. Paths are taken from the settings' commands.
export function emitCodexGuards(settings) {
  const wired = guardList(settings, [...CODEX_GUARDS, ...CODEX_OPEN]);
  const script = (name) => wired.flatMap((w) => w.run).find((t) => basename(t.replaceAll("\\", "/"), ".mjs") === name);
  const wrapper = script(WRAPPER);
  const run = [wrapper, ...CODEX_GUARDS.map(script)].filter(Boolean);
  if (run.length < 2) return [];
  const entry = { event: "PreToolUse", matcher: CODEX_MATCHER, run };
  const open = CODEX_OPEN.map(script).filter(Boolean);
  if (open.length) entry.open = open;
  return [entry];
}

// A PowerShell single-quoted string, `'` doubled (guards.rs `ps_quote`).
export function psQuote(s) {
  return `'${String(s).replaceAll("'", "''")}'`;
}

// `guards::codex_command`: call operator first, `--` flags bare, the rest single-quoted, then the exit-code relay.
export function codexCommand(node, argv) {
  return `${["&", psQuote(node), ...argv.map((a) => (a.startsWith("--") ? a : psQuote(a)))].join(" ")}; exit $LASTEXITCODE`;
}

// Hook lines as `guards::copy_codex` builds them, with the files already copied to `dir`:
// [{ event, matcher?, line }]. PreToolUse: [fail-closed] shim --guard each --open-guard each; others: the run list.
export function codexHookLines(guards, { node, dir, shim = "codex-shim.mjs" }) {
  const copy = (f) => join(dir, basename(String(f).replaceAll("\\", "/")));
  return guards.map((g) => {
    const wrapped = basename(String(g.run[0]).replaceAll("\\", "/"), ".mjs").toLowerCase() === WRAPPER;
    let argv;
    if (g.event === "PreToolUse") {
      argv = [];
      if (wrapped) argv.push(copy(g.run[0]));
      argv.push(copy(shim));
      for (const f of g.run.slice(wrapped ? 1 : 0)) argv.push("--guard", copy(f));
      for (const f of g.open ?? []) argv.push("--open-guard", copy(f));
    } else argv = g.run.map(copy);
    const e = { event: g.event, line: codexCommand(node, argv) };
    if (g.matcher) e.matcher = g.matcher;
    return e;
  });
}

// The three real PreToolUse payload shapes (reports/p1w0-live.md): Bash and apply_patch, both with
// tool_input.command. The blocked apply_patch is an Add File into the real .claude folder from a subagent.
export function codexCases({ realClaude, cwd }) {
  const common = { session_id: "probe", turn_id: "probe", transcript_path: "", cwd, hook_event_name: "PreToolUse", model: "probe", permission_mode: "default", tool_use_id: "exec-probe" };
  const target = join(realClaude, "guard-probe.txt");
  return [
    { name: "Bash allow", expect: { exit: 0 }, payload: { ...common, tool_name: "Bash", tool_input: { command: "echo P1W0-ALLOW" } } },
    { name: "Bash blocked", expect: { exit: 2, stderr: true }, payload: { ...common, tool_name: "Bash", tool_input: { command: "find /c/ -name guard-probe" } } },
    { name: "apply_patch blocked", expect: { exit: 2, stderr: true },
      payload: { ...common, agent_id: "probe-sub", agent_type: "Striker", tool_name: "apply_patch",
        tool_input: { command: `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch` } } },
  ];
}

// Codex verdict: the exit code must match, and a block must carry a non-empty stderr.
export function judgeCodexCase(expect, res) {
  const stderrOk = !expect.stderr || String(res.stderr ?? "").trim().length > 0;
  const ok = res.status === expect.exit && stderrOk;
  const got = `exit ${res.status}${expect.stderr ? (stderrOk ? " +stderr" : " NO STDERR") : ""}`;
  return { ok, got, want: `exit ${expect.exit}${expect.stderr ? " +stderr" : ""}` };
}

// Pure verdict: result { status, stdout } against expect { exit, ask? }.
export function judgeCase(expect, res) {
  let ask = false;
  try { ask = JSON.parse(res.stdout || "{}").hookSpecificOutput?.permissionDecision === "ask"; } catch { /* not JSON */ }
  const ok = res.status === expect.exit && (!expect.ask || ask);
  const got = `exit ${res.status}${ask ? " (ask)" : ""}`;
  return { ok, got, want: `exit ${expect.exit}${expect.ask ? " (ask)" : ""}` };
}

// Bare PTY env: the caller's env minus anything GUARD_* / CLAUDE_*, USERPROFILE and HOME at user-home.
export function bareEnv(home, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!/^(GUARD_|CLAUDE_)/i.test(k)) env[k] = v;
  const userHome = join(home, "user-home");
  return { ...env, USERPROFILE: userHome, HOME: userHome, CLAUDE_CONFIG_DIR: join(home, "claude-config") };
}

function parseArgs(argv) {
  const o = { settings: null, home: null, emit: false, codex: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--emit") o.emit = true;
    else if (a === "--codex") o.codex = true;
    else if (a === "--config") o.config = argv[++i];
    else if (a === "--settings") o.settings = argv[++i];
    else if (a === "--home") o.home = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

// The trip-log.mjs the guards import: under the account's real home, as the guards resolve it
// (`GUARD_REAL_HOME`, test-only, else os.userInfo().homedir; never USERPROFILE, which a Bare tab moves), so
// a copy in <home>\layer\hooks\ finds the same file as the original beside it.
export function tripLogPath(env = process.env) {
  return join(env.GUARD_REAL_HOME || userInfo().homedir, ".claude", "hooks", "trip-log.mjs");
}

// `tripsPath()` from that trip-log.mjs, read in a child under `env`; "no tripsPath" when absent or not exported.
export function tripsPathOf(env) {
  const tripLog = tripLogPath(env);
  if (!existsSync(tripLog)) return "no tripsPath";
  const code = `const m = await import(process.argv[1]); process.stdout.write(typeof m.tripsPath === "function" ? String(m.tripsPath()) : "no tripsPath");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(tripLog).href],
    { env, encoding: "utf8", timeout: 15000 });
  return r.status === 0 && r.stdout ? r.stdout : "no tripsPath";
}

// --codex: copy the configured files to <home>\layer\hooks, build the lines, run the cases through
// `pwsh -NoProfile -Command <line>` (stdin = the payload), judge exit code and stderr.
function probeCodex(o, home, runEnv, realHome) {
  const config = o.config ? pathResolve(o.config) : resolvePath("config", { root: REPO });
  const guards = JSON.parse(readFileSync(config, "utf8").replace(/^﻿/, "")).bareCodexGuards;
  if (!Array.isArray(guards) || !guards.length) { console.log(`no bareCodexGuards in ${config}`); return 1; }
  const dir = join(home, "layer", "hooks");
  mkdirSync(dir, { recursive: true });
  const shim = join(HERE, "codex-shim.mjs");
  for (const f of [shim, ...guards.flatMap((g) => [...g.run, ...(g.open ?? [])])]) copyFileSync(f, join(dir, basename(f.replaceAll("\\", "/"))));
  const lines = codexHookLines(guards, { node: process.execPath, dir });
  const line = lines.find((l) => l.event === "PreToolUse");
  if (!line) { console.log("no PreToolUse entry in bareCodexGuards"); return 1; }
  console.log(`config ${config}\nbare env USERPROFILE=${runEnv.USERPROFILE}\nline ${line.line}`);
  let bad = 0;
  for (const c of codexCases({ realClaude: join(realHome, ".claude"), cwd: REPO })) {
    const r = spawnSync("pwsh", ["-NoProfile", "-Command", line.line], { input: JSON.stringify(c.payload), env: runEnv, encoding: "utf8", timeout: 40000, cwd: REPO });
    const v = judgeCodexCase(c.expect, { status: r.status, stderr: r.stderr });
    if (!v.ok) bad++;
    console.log(`${c.name.padEnd(20)} want ${v.want.padEnd(14)} got ${v.got.padEnd(14)} ${v.ok ? "ok" : "MISMATCH"}${r.status === 2 ? `  stderr: ${String(r.stderr).trim().split("\n")[0].slice(0, 100)}` : ""}`);
  }
  console.log(bad ? `${bad} mismatch(es)` : "all match");
  return bad ? 1 : 0;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const realHome = userInfo().homedir;
  const settingsPath = o.settings ?? join(realHome, ".claude", "settings.json");
  if (o.emit) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const out = o.codex ? { agent: "codex", bareCodexGuards: emitCodexGuards(settings) } : { agent: "claude", bareGuards: emitBareGuards(settings) };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  }
  const home = o.home ? pathResolve(o.home) : mkdtempSync(join(tmpdir(), "guard-probe-"));
  mkdirSync(join(home, "user-home"), { recursive: true });
  mkdirSync(join(home, "claude-config"), { recursive: true });
  const env = bareEnv(home);
  const runEnv = { ...env, GUARD_TRIPS_PATH: join(mkdtempSync(join(tmpdir(), "guard-probe-trips-")), "trips.jsonl") };
  if (o.codex) return probeCodex(o, home, runEnv, realHome);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const wired = guardList(settings);
  let bad = 0;
  console.log(`settings ${settingsPath}\nbare env USERPROFILE=${env.USERPROFILE} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`);
  for (const c of probeCases({ realClaude: join(realHome, ".claude"), cwd: REPO })) {
    const w = wired.find((x) => x.guard === c.guard);
    if (!w) { console.log(`${c.guard.padEnd(18)} NOT WIRED in settings`); bad++; continue; }
    const r = spawnSync(w.command, { shell: true, input: JSON.stringify(c.payload), env: runEnv, encoding: "utf8", timeout: 20000, cwd: REPO });
    const v = judgeCase(c.expect, { status: r.status, stdout: r.stdout });
    if (!v.ok) bad++;
    console.log(`${c.guard.padEnd(18)} ${w.event.padEnd(11)} want ${v.want.padEnd(10)} got ${v.got.padEnd(10)} ${v.ok ? "ok" : "MISMATCH"}  trips: ${tripsPathOf(env)}`);
  }
  console.log(bad ? `${bad} mismatch(es)` : "all match");
  return bad ? 1 : 0;
}

if (process.argv[1] && pathResolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
