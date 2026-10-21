// Vidar-layer context gate for bare Claude tabs: the Vidar copy of the global context-handoff gate
// (bare-mode inventory row 8), delivered by path from the generated settings of a bare home
// (profiles/bare/claude.settings.template.json). It replaces "keep going until auto-compact" with a
// scripted handoff: at or past the trigger it tells the model to finish the current step, write a
// handoff doc and stop; /catapult opens the successor from that file.
//
// Usage (hook commands in the bare home's generated settings; Claude pipes the hook JSON on stdin):
//   node "<root>\tools\agent-layer\context-gate.mjs" prompt --root "<root>" --home "<home>"   (UserPromptSubmit)
//   node "<root>\tools\agent-layer\context-gate.mjs" stop   --root "<root>" --home "<home>"   (Stop)
// <home> is the agentHomes folder (or its claude-config folder: both resolve to the same config dir,
// which is also what VIDAR_AGENT_HOME names). UserPromptSubmit injects via
// hookSpecificOutput.additionalContext; Stop emits a top-level {"decision":"block","reason":...}.
//
// Config:  <config dir>\context-gate.json (hand-edited):
//          { budget: 200000, headroom: 20000, sourceMaxAgeSec: 600, handoffMaxAgeHours: 24 }.
//          It fires at min(budget, 0.9 * window) - headroom.
// Token source (the hook input carries none), first file whose own `session_id` equals the hook's wins:
//   (a) <config dir>\statusline\<session_id>.json
//   (b) <root>\runtime\bridge\sessions\<VIDAR_TAB>.json (the paths contract's `sessions` id; the status
//       line bridge writes it; only when VIDAR_TAB looks like a Vidar tab id)
//   (c) <config dir>\statusline-latest.json
// A source older than sourceMaxAgeSec, unreadable or unparseable is "no source" (no-op).
//
// Every failure mode is a silent no-op: exit 0, empty stdout (one stderr line for bad arguments only,
// like every hook-side script: tools-ps1.md). A hook that can fail a prompt or a stop is worse than no gate.
//   - CONTEXT_GATE=0 in the environment
//   - hook input has an `agent_id` (a subagent: the numbers would be the parent's)
//   - stdin is not valid JSON, or has no session_id
//   - no source matches this session, or the matched one is stale
//   - `current_usage` is null, or the summed tokens are 0 or NaN
// Never reads USERPROFILE, HOME, os.homedir() or `~`: Claude's subprocess scrub strips
// CLAUDE_CONFIG_DIR from hook children, so every path comes from --root / --home.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { absoluteArgs, vidarTab } from "../lib/agent-env.mjs";
import { resolve as resolvePath } from "../lib/paths.mjs";

const DEFAULT_CONFIG = { budget: 200000, headroom: 20000, sourceMaxAgeSec: 600, handoffMaxAgeHours: 24 };
const CONFIG_DIR_NAME = "claude-config";

/** The bare Claude config dir for a `--home` that is the agentHomes folder or the config dir itself. */
export function configDirOf(home) {
  return basename(home).toLowerCase() === CONFIG_DIR_NAME ? home : join(home, CONFIG_DIR_NAME);
}

function main() {
  const event = process.argv[2]; // "prompt" | "stop"
  if (event !== "prompt" && event !== "stop") return;
  if (process.env.CONTEXT_GATE === "0") return;

  const args = absoluteArgs(process.argv.slice(3), ["root", "home"]);
  if (args.error) {
    process.stderr.write(`context-gate: ${args.error}\n`);
    return;
  }
  const { root, home } = args.values;
  const cfgDir = configDirOf(home);

  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { return; }
  raw = raw.replace(/^﻿/, "").trim();
  if (!raw) return;

  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (input.agent_id) return;

  const sessionId = input.session_id;
  if (!sessionId || typeof sessionId !== "string") return;
  // Stand down when the vidar-gate mod owns this session (Rendered tabs).
  if (existsSync(join(cfgDir, "context-gate", sessionId + ".mod"))) return;

  const config = readConfig(cfgDir);
  if (process.env.CONTEXT_GATE_BUDGET) {
    const b = Number(process.env.CONTEXT_GATE_BUDGET);
    if (Number.isFinite(b) && b > 0) config.budget = b;
  }

  const source = findSource(cfgDir, root, sessionId);
  if (!source) return;
  const ageSec = (Date.now() - source.mtimeMs) / 1000;
  if (ageSec > config.sourceMaxAgeSec) return;

  const cw = source.data.context_window;
  const usage = cw?.current_usage;
  if (usage == null) return;
  const ctx = Number(usage.input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0);
  if (!Number.isFinite(ctx) || ctx === 0) return;

  let window = Number(cw?.context_window_size);
  if (!Number.isFinite(window) || window === 0) window = 1000000;

  const trigger = Math.min(config.budget, 0.9 * window) - config.headroom;
  if (ctx < trigger) return;

  const cwd = String(input.cwd || "");
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-");
  const handoffDir = join(cfgDir, "handoffs", slug);
  const crossedAt = ensureState(cfgDir, sessionId);
  // A handoff written just before the first crossing (same turn as a budget change) is this one.
  const fresh = freshHandoff(handoffDir, crossedAt, sessionId);
  const handoffPath = fresh || join(handoffDir, `${stamp(new Date(crossedAt))}-${sessionId.slice(0, 8)}.md`);

  const body = `Context gate: this session is at ${Math.round(ctx)} tokens of a ${config.budget} budget `
    + `(trigger ${Math.round(trigger)}). Finish the current step only; start nothing new. Then write `
    + `the handoff to ${handoffPath} in one Write and stop. The next session starts from that file. `
    + `The handoff has the headings State, Next, Paths and Questions (the handoff skill's shape), then a `
    + `footer holding the output of git status --short and the session id. `
    + `If background agents you launched are still running, let them finish first: end turns waiting `
    + `on them, absorb each report, and write the handoff only once none is running.`;

  if (event === "prompt") {
    // Once the handoff exists, never re-instruct a write: every edit would re-trigger the handoff.
    emit("UserPromptSubmit", fresh ? postHandoffBody(handoffPath) : body);
    return;
  }

  // stop
  if (input.stop_hook_active === true) return;
  if (fresh) return;
  emitStop(`Before stopping: ${body}`);
}

export function postHandoffBody(handoffPath) {
  return `Context gate: this session's handoff already exists at ${handoffPath}. Do not edit or `
    + `rewrite it. A user's answer arriving now is appended to the handoff as one line `
    + `"Answer: <question> -> <answer>", because the successor reads the handoff first. `
    + `Answer the user briefly, finish the current step only, and stop.`;
}

function readConfig(cfgDir) {
  try {
    const raw = readFileSync(join(cfgDir, "context-gate.json"), "utf8").replace(/^﻿/, "");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function readJsonFile(path) {
  const st = statSync(path); // throws if missing
  const data = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); // throws if malformed
  return { data, mtimeMs: st.mtimeMs };
}

function findSource(cfgDir, root, sessionId) {
  const candidates = [join(cfgDir, "statusline", `${sessionId}.json`)];
  const tab = vidarTab();
  if (tab) candidates.push(join(resolvePath("sessions", { root }), `${tab}.json`));
  candidates.push(join(cfgDir, "statusline-latest.json"));
  for (const path of candidates) {
    try {
      const found = readJsonFile(path);
      if (found.data.session_id === sessionId) return found;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function ensureState(cfgDir, sessionId) {
  const dir = join(cfgDir, "context-gate");
  const path = join(dir, `${sessionId}.json`);
  try {
    const existing = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
    if (existing && Number.isFinite(existing.crossedAt)) return existing.crossedAt;
  } catch { /* not written yet, or unreadable: write it now */ }

  const crossedAt = Date.now();
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${sessionId}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ crossedAt }), "utf8");
    renameSync(tmp, path);
  } catch { /* best effort: still return the value so this call behaves correctly */ }
  return crossedAt;
}

// A handoff up to this long before the first crossing still counts (budget lowered in the same turn).
const HANDOFF_GRACE_MS = 10 * 60 * 1000;

/** Newest own-sid8 handoff written after crossedAt minus the grace window; null when none. */
function freshHandoff(handoffDir, crossedAt, sessionId) {
  let entries;
  try { entries = readdirSync(handoffDir); } catch { return null; }
  let best = null;
  for (const name of entries) {
    if (!name.endsWith(`-${sessionId.slice(0, 8)}.md`)) continue;
    try {
      const path = join(handoffDir, name);
      const mtimeMs = statSync(path).mtimeMs;
      if (mtimeMs > crossedAt - HANDOFF_GRACE_MS && (!best || mtimeMs > best.mtimeMs)) best = { path, mtimeMs };
    } catch { /* skip unreadable entry */ }
  }
  return best ? best.path : null;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function emit(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

function emitStop(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

try {
  main();
} catch { /* never fail a prompt or a stop */ }
process.exit(0);
