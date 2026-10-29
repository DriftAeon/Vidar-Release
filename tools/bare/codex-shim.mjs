// Codex PreToolUse shim: runs Vidar's Claude-contract guards for a Codex Bare tab.
// Codex speaks nearly the Claude hook contract (stdin JSON, exit 2 + stderr blocks) but names its tools and
// shapes its edits differently, so this rewrites each Codex payload into the Claude shape and runs the guards.
//
// Usage (wired as one hook command, wrapper first so a broken shim also fails closed):
//   node fail-closed.mjs codex-shim.mjs --guard <a.mjs> [--guard <b.mjs> ...] [--open-guard <c.mjs>] [--log <file>]
//   --guard       a blocking guard, run in the order given; first block wins. A guard that does not exit
//                 0 or 2 (crash, hang, missing file) blocks, fail closed (guard-install, guard-crawl, guard-cwd).
//   --open-guard  a fail-open guard (guard-driver): only its exit 2 blocks; an error, a hang or a missing
//                 file allows. Runs after the blocking guards.
//   --log         file that gets one line per unknown payload shape (also env CODEX_SHIM_LOG).
//   Env fallbacks CODEX_SHIM_GUARDS / CODEX_SHIM_OPEN_GUARDS: paths joined with the platform path delimiter.
//   The guard paths are always given by the caller; nothing is read from ~\.claude by default.
//
// Mapping:
//   - Codex's shell tool (Bash, shell, shell_command, local_shell, exec_command) -> `PowerShell`; the command
//     (a string, or an argv array joined with spaces) lands in tool_input.command.
//   - apply_patch -> one Write per `*** Add File:` (path + body) and one Edit per `*** Update File:` /
//     `*** Delete File:` / `*** Move to:` (path; hunks as old_string / new_string). Each call runs every guard.
//   - Any other tool name, a non-JSON or non-object payload, a non-PreToolUse event, or an apply_patch with
//     no file operation is an unknown shape: logged, then blocked (exit 2).
//   - agent_id / agent_type pass through; CLAUDE_PROJECT_DIR is set from the payload `cwd`; guards run in that cwd.
//   - Guard stdout is swallowed. Exception: JSON with hookSpecificOutput.permissionDecision "deny" counts as a block.
//
// Every exit 2 carries a non-empty stderr line: Codex ignores exit 2 with empty stderr (the call runs; verified
// live 2026-10-19, reports/p1w0-live.md). A guard that blocks silently gets `Blocked by <guard file>.`
// Payload shapes: verified against the live probe (tool names Bash and apply_patch, both with tool_input.command).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHELL_TOOLS = new Set(["Bash", "shell", "shell_command", "local_shell", "exec_command", "PowerShell"]);
const PATCH_TOOLS = new Set(["apply_patch"]);
const GUARD_TIMEOUT_MS = 15000;

// Codex payload -> list of Claude-shape payloads, or { unknown: reason }.
export function mapPayload(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return { unknown: "payload is not a JSON object" };
  if (d.hook_event_name !== undefined && d.hook_event_name !== "PreToolUse") {
    return { unknown: `event ${JSON.stringify(d.hook_event_name)} is not PreToolUse` };
  }
  const tool = typeof d.tool_name === "string" ? d.tool_name : "";
  const input = d.tool_input && typeof d.tool_input === "object" && !Array.isArray(d.tool_input) ? d.tool_input : null;
  if (!tool) return { unknown: "no tool_name" };
  if (!input) return { unknown: `tool ${tool}: tool_input is not an object` };
  const base = { ...d };
  delete base.tool_input;
  if (SHELL_TOOLS.has(tool)) {
    const c = input.command;
    const command = Array.isArray(c) && c.every((x) => typeof x === "string") ? c.join(" ") : c;
    if (typeof command !== "string") return { unknown: `tool ${tool}: tool_input.command is neither a string nor a string array` };
    return { calls: [{ ...base, tool_name: "PowerShell", tool_input: { ...input, command } }] };
  }
  if (PATCH_TOOLS.has(tool)) {
    const patch = [input.command, input.input, input.patch].find((x) => typeof x === "string");
    if (patch === undefined) return { unknown: "apply_patch: no patch text in tool_input" };
    const ops = splitPatch(patch);
    if (!ops.length) return { unknown: "apply_patch: no file operation found" };
    const cwd = typeof d.cwd === "string" && d.cwd ? d.cwd : process.cwd();
    const abs = (p) => resolve(cwd, p);
    return {
      calls: ops.map((o) => o.kind === "add"
        ? { ...base, tool_name: "Write", tool_input: { file_path: abs(o.path), content: o.body } }
        : { ...base, tool_name: "Edit", tool_input: { file_path: abs(o.path), old_string: o.oldText ?? "", new_string: o.newText ?? "" } }),
    };
  }
  return { unknown: `tool ${JSON.stringify(tool)} has no mapping` };
}

// Splits a Codex patch into file operations. Body lines of an Add File carry a leading `+`; hunk lines of an
// Update File are ` `/`-`/`+`; `@@` lines and the Begin/End markers are structure.
export function splitPatch(patch) {
  const ops = [];
  let cur = null;
  const finish = () => {
    if (!cur) return;
    if (cur.kind === "add") cur.body = cur.lines.join("\n");
    else { cur.oldText = cur.oldLines.join("\n"); cur.newText = cur.newLines.join("\n"); }
    ops.push(cur);
    if (cur.moveTo) ops.push({ kind: "move", path: cur.moveTo, oldText: "", newText: "" });
    cur = null;
  };
  for (const line of String(patch).replace(/\r\n/g, "\n").split("\n")) {
    let m;
    if ((m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/))) {
      finish();
      cur = m[1] === "Add"
        ? { kind: "add", path: m[2], lines: [] }
        : { kind: m[1] === "Update" ? "update" : "delete", path: m[2], oldLines: [], newLines: [] };
    } else if ((m = line.match(/^\*\*\* Move to: (.+?)\s*$/))) {
      if (cur) cur.moveTo = m[1];
    } else if (line.startsWith("*** ")) {
      continue; // Begin Patch, End Patch, End of File
    } else if (cur?.kind === "add") {
      cur.lines.push(line.startsWith("+") ? line.slice(1) : line);
    } else if (cur?.kind === "update") {
      if (line.startsWith("@@")) continue;
      if (line.startsWith("-")) cur.oldLines.push(line.slice(1));
      else if (line.startsWith("+")) cur.newLines.push(line.slice(1));
      else if (line.startsWith(" ")) { cur.oldLines.push(line.slice(1)); cur.newLines.push(line.slice(1)); }
    }
  }
  finish();
  return ops;
}

// A block's stderr, never empty: a silent guard exit 2 gets a fallback naming the guard file.
function reasoned(stderr, script) {
  return stderr && stderr.trim() ? stderr : `Blocked by ${basename(script)}.\n`;
}

// Runs one guard on one Claude-shape payload. Returns { block: boolean, stderr, why }.
function runGuard(script, payload, env, cwd, failOpen) {
  if (!existsSync(script)) {
    return failOpen ? { block: false } : { block: true, stderr: `codex shim: guard ${script} is missing: blocked, fail closed.\n` };
  }
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: GUARD_TIMEOUT_MS, env, cwd,
  });
  if (r.status === 2) return { block: true, stderr: reasoned(r.stderr, script) };
  if (r.status === 0) {
    let deny = null;
    try {
      const o = JSON.parse(r.stdout || "");
      if (o?.hookSpecificOutput?.permissionDecision === "deny") deny = o.hookSpecificOutput.permissionDecisionReason || "denied by guard";
    } catch { /* non-JSON stdout is swallowed */ }
    return deny ? { block: true, stderr: `${deny}\n` } : { block: false };
  }
  if (failOpen) return { block: false };
  const how = r.status ?? r.error?.code ?? r.signal ?? "?";
  return { block: true, stderr: `codex shim: guard ${script} did not run cleanly (exit ${how}): blocked, fail closed. Tell the user the guard needs fixing; do not retry or route around it.\n` };
}

// Pure core: payload object + guard lists -> { exit, stderr }. `log(line)` gets unknown-shape notes.
export function evaluate(d, { guards, openGuards = [], env = process.env, log = () => {} }) {
  if (!guards.length) return { exit: 2, stderr: "codex shim: no --guard given: blocked, fail closed. Tell the user the hook line is broken.\n" };
  const m = mapPayload(d);
  if (m.unknown) {
    log(`unknown payload shape: ${m.unknown}`);
    return { exit: 2, stderr: `codex shim: ${m.unknown}: blocked, fail closed. Tell the user the Codex hook payload is not one the shim knows.\n` };
  }
  const cwdOk = typeof d.cwd === "string" && d.cwd && existsSync(d.cwd) && statSync(d.cwd).isDirectory();
  const childEnv = { ...env };
  if (typeof d.cwd === "string" && d.cwd) childEnv.CLAUDE_PROJECT_DIR = d.cwd;
  for (const call of m.calls) {
    for (const g of guards) {
      const r = runGuard(g, call, childEnv, cwdOk ? d.cwd : undefined, false);
      if (r.block) return { exit: 2, stderr: r.stderr };
    }
    for (const g of openGuards) {
      const r = runGuard(g, call, childEnv, cwdOk ? d.cwd : undefined, true);
      if (r.block) return { exit: 2, stderr: r.stderr };
    }
  }
  return { exit: 0, stderr: "" };
}

export function parseArgs(argv, env = process.env) {
  const split = (v) => (v ? v.split(delimiter).filter(Boolean) : []);
  const o = { guards: [], openGuards: [], log: env.CODEX_SHIM_LOG || "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--guard" && argv[i + 1]) o.guards.push(argv[++i]);
    else if (a === "--open-guard" && argv[i + 1]) o.openGuards.push(argv[++i]);
    else if (a === "--log" && argv[i + 1]) o.log = argv[++i];
  }
  if (!o.guards.length) o.guards = split(env.CODEX_SHIM_GUARDS);
  if (!o.openGuards.length) o.openGuards = split(env.CODEX_SHIM_OPEN_GUARDS);
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (line) => {
    if (!opts.log) return;
    try { appendFileSync(opts.log, `${new Date().toISOString()} ${line}\n`); } catch { /* logging never decides */ }
  };
  let raw = "";
  try { raw = readFileSync(0, "utf8").replace(/^﻿/, ""); } catch { /* no stdin */ }
  let d = null;
  try { d = JSON.parse(raw); } catch { /* d stays null: evaluate logs and blocks it */ }
  const res = evaluate(d, { guards: opts.guards, openGuards: opts.openGuards, log });
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.exit);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
