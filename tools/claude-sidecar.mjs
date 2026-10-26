// Claude sidecar for Vidar's Rendered body. A thin passthrough between Vidar
// (JSON lines on stdin/stdout) and the Claude Agent SDK, which owns the
// installed claude.exe. It adds exactly four message types of its own
// (permission_request out; permission_response / interrupt /
// set_permission_mode in) and one status envelope ({type:"sidecar"}). Every
// SDK message goes to stdout verbatim, one per line, after `shrink` caps
// oversized tool inputs/outputs (the parsed object is here, so the cap is
// exact and never drops a permission request). No network of its own. One
// OPT-IN file write of its own: with `statuslineMirror: true` in vidar.json it
// mirrors ~\.claude\statusline\<session_id>.json on every top-level assistant
// message, best-effort, so outside readers have a context source in Rendered/headless
// bodies where the terminal statusline script never runs (see observeStatusline).
// Off (the default) it writes nothing under ~\.claude and removes any mirror file
// it marked as its own. A --profile (bare) tab writes only inside its own agent home: the mirror,
// always on, under <config dir>\statusline\, and its first system/init to
// <home>\manifests\falcon-<FALCON_SESSION>.init.json (claude-sidecar-bare.mjs).
//
// Usage: node claude-sidecar.mjs --cwd <dir> [--model <m>] [--effort <low|medium|high|xhigh|max>]
//        [--permission-mode <mode>] [--resume <session-id>] --claude <path\to\claude.exe> [--falcon]
//        [--rules-file <abs path to a built rules .md>] [--flow-payload bare --root <abs root>] [--mcp-servers <JSON>]: Flow, see claude-sidecar-bare.mjs flowOptions
//        [--gateway <module id> --vendor-preparer <abs vendor-prepare.ps1> --pwsh <abs pwsh.exe>]
//        [--profile bare --root <abs Vidar root> --home <abs agent home>] [--require-mcp <JSON names>: Flow, see claude-sidecar-mcp-wait.mjs]
//
// --profile (Falcon only, never with --rules-file or --gateway): a Rendered Bare tab. The SDK options
//   come from the profile (claude-sidecar-bare.mjs), never from vidar.json; Falcon built the env.
//
// --gateway (Falcon only): re-enter this sidecar through tools/vendor/vendor-prepare.ps1, which
//   checks the fence, sets the vendor env and passes --vendor-settings/--vendor-plugin/--vendor-prompt.
//
// --falcon (absent by default): Falcon durably hosts Claude sessions outside Vidar and cannot
//   infer from stdin bytes alone whether a command landed or a permission is still outstanding,
//   so this flag turns on two bookkeeping record families below. It is a pure addition: without
//   it, stdout is byte-for-byte what it is today (Vidar's adapter treats an unknown top-level
//   type as unknown and an unknown "sidecar" subtype as a red error, so unconditional new records
//   would corrupt every existing Vidar Rendered tab).
//
// stdin  (Vidar → sidecar), one JSON per line:
//   {"type":"user","content":"…"}                         text or Messages content blocks
//   {"type":"permission_response","id":"…","behavior":"allow"|"deny",
//     "updatedInput"?:{…},"updatedPermissions"?:[…],"message"?:"…"}
//   {"type":"interrupt"}
//   {"type":"set_permission_mode","mode":"default"|"acceptEdits"|"plan"|"auto"}
//   {"type":"set_model","model":"…"}                      any alias or id the CLI's /model accepts
//   {"type":"set_effort","level":"low"|"medium"|"high"|"xhigh"|"max"}   session-scoped; answered by an "effort" line
//   In --falcon mode only, any of the above may also carry a numeric "cid"; each cid that
//   appears gets exactly one terminal outcome record back (see below).
// stdout (sidecar → Vidar): SDK messages as-is, plus
//   {"type":"permission_request","id":"…","toolUseId":"…","tool":"Bash","input":{…},"inputBytes":n,"suggestions":[…]}
//   {"type":"sidecar","subtype":"ready"|"error"|"closed", …}   ready carries "model": the expected model (settings), or null
//   {"type":"sidecar","subtype":"mode","mode":"…"} | {"subtype":"mode_failed","message":"…"}   answers set_permission_mode
//   {"type":"sidecar","subtype":"model","model":"…"} | {"subtype":"model_failed","message":"…"} answers set_model
//   {"type":"sidecar","subtype":"models","models":[{"value","label","resolved"}]}   the CLI's model list, once, after initialize
//   {"type":"sidecar","subtype":"cache_ttl","ttl":"5m"|"1h"}   prompt-cache TTL, from the PostModelSwitch hook
//   {"type":"effort","level":"high"}   reasoning effort: seeded from statusline-latest.json at start, then per turn from the Stop hook
//   {"type":"rate_limit_event", …}     5H/7D seeded from statusline-latest.json at start, in the SDK's own envelope; real events overwrite it
//   --falcon only, keyed to the Rust consumer's observe_falcon (src-falcon/src/claude.rs) —
//   field names and state strings below must match it exactly, or the record is silently ignored
//   and the command times out 30s later as delivery-unknown:
//   {"type":"falcon","subtype":"outcome","cid":<number>,"state":"applied"|"failed","message"?:"…",
//     "mode"?:"…","model"?:"…"}   one per inbound cid, terminal; "mode"/"model" only on an applied
//     set_permission_mode/set_model, because the Rust side commits the label only on "applied"
//   {"type":"falcon","subtype":"permission","id":"<permission id>","state":
//     "opened"|"responded"|"returned"|"settled"|"cancelled"|"failed","signal"?:"…"}
//     per permission id, alongside the existing permission_request/lifecycle. Only "settled" and
//     "cancelled" are terminal; everything else leaves the request pending, because the CLI may
//     still be blocked on it:
//       opened    the card is out, nobody has answered
//       responded a permission_response arrived on stdin and reached canUseTool's resolver
//       returned  canUseTool returned its result to the SDK. This proves the CALLBACK finished
//                 and NOTHING about delivery: the SDK writes the control_response after we
//                 return, on its own transport, and drops the write silently when the query has
//                 already cleaned up (node_modules\@anthropic-ai\claude-agent-sdk\sdk.mjs,
//                 Query.handleControlRequest: `if(this.cleanupPerformed)return` sits between our
//                 return and `transport.write`). There is no SDK callback or event for "your
//                 permission answer was delivered", so "returned" is as much as this side knows.
//       settled   a terminal signal from the AGENT, carried on "signal": "tool_result" (a
//                 tool_result block for this permission's tool_use_id — the CLI only writes one
//                 after it has consumed the decision), "permission_denied" (a system message or a
//                 result.permission_denials entry naming the tool_use_id), or "result" (the turn
//                 that opened the request ended, so the CLI is no longer blocked on it)
//       cancelled the SDK aborted the request, or stdin closed and we denied it ourselves
//       failed    building/delivering the result threw here; the CLI is still blocked, so this
//                 deliberately does not settle the request
//     A request with no tool_use_id and no turn end simply stays "returned": an honest unknown.
//     Falcon settles those on child exit as its own "cancelled-by-exit", which is a Falcon state
//     and never a record here.

import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { CAP, bytes, summarizeInput, shrink } from "./claude-sidecar-shrink.mjs";
import { readVidarConfig, vidarRoot, startStatuslineMirror } from "./claude-sidecar-statusline.mjs";
import { seededEffort, seededLimits } from "./claude-sidecar-seed.mjs";
import { bareOptions, bareSettingsModel, flowOptions, setPluginArgs, writeInitOnce } from "./claude-sidecar-bare.mjs";
import { startLedger } from "./claude-sidecar-ledger.mjs";
import { settingSourcesFor } from "./claude-sidecar-trust.mjs";
import { createInterruptWindow, forwardInterrupt, replayHistory } from "./claude-sidecar-recover.mjs";

const ALLOWED_MODES = new Set(["default", "acceptEdits", "plan", "auto"]); // auto = the classifier mode, not bypass
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]; // pinned to contracts/effort-levels.json by tests/contracts-shared.test.mjs
/* ---- args ---- */

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const cwd = arg("--cwd");
const model = arg("--model");
const effort = arg("--effort");
const permissionMode = arg("--permission-mode") ?? "default";
const falcon = argv.includes("--falcon"); // gates every record in the "falcon" block of the header comment; absent by default

// A gateway re-enters this sidecar through the SAME preparation as Raw tabs.
// Only identity and nonsecret arguments are on the command line; stdin/stdout remain the SDK stream.
const gateway = arg("--gateway");
if (arg("--profile") !== undefined) {
  if (!falcon) fail("a launch profile needs --falcon");
  if (gateway) fail("a launch profile carries no gateway");
}
if (gateway) {
  const prepare = arg("--vendor-preparer");
  // Falcon resolves pwsh.exe from its own PATH; a bare "pwsh" here would search the session cwd first.
  // No existsSync(pwsh): Store PowerShell's WindowsApps alias fails it (2026-10-12); the spawn error handler covers a missing binary.
  const pwsh = arg("--pwsh");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(gateway) || !prepare || !isAbsolute(prepare) || !existsSync(prepare)
    || !pwsh || !isAbsolute(pwsh)) {
    process.stderr.write("Gateway preparation is unavailable\n");
    process.exit(1);
  }
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--gateway", "--vendor-preparer", "--pwsh", "--model"].includes(argv[i])) { i++; continue; }
    forwarded.push(argv[i]);
  }
  const { spawn } = await import("node:child_process");
  const child = spawn(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", prepare,
    "-Vendor", gateway, "-Node", process.execPath, "-Sidecar", fileURLToPath(import.meta.url),
    "-SidecarArgs", Buffer.from(JSON.stringify(forwarded)).toString("base64")], { cwd, stdio: "inherit", windowsHide: true });
  child.on("error", () => { process.stderr.write("Gateway preparation could not start\n"); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 1));
  await new Promise(() => {}); // The preparation process owns the checked fence for its child's lifetime.
}

/* The CLI names its resolved model only in system/init, which streaming mode
   emits at the FIRST turn — so a fresh tab would show no model until a message
   was already paid for. Read the same sources a terminal `claude` resolves from
   (INFERRED precedence, matching the CLI docs: ANTHROPIC_MODEL, then the
   project's local and shared settings, then the user's) and report it on the
   ready line as the expected model; init confirms or corrects it. Read-only. */
function settingsModel() {
  if (bare) return bareSettingsModel(bare.configDir);
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  const files = [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];
  for (const f of files) {
    try {
      const m = JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")).model;
      if (typeof m === "string" && m.trim()) return m.trim();
    } catch { /* absent or unparsable: next layer */ }
  }
  return null;
}

const resume = arg("--resume");
const claudeExe = arg("--claude");

function out(obj) {
  let line = JSON.stringify(obj) + "\n";
  // Gateway credentials must never enter Falcon's journal or optional sidecar dump.
  if (arg("--vendor-settings") && process.env.ANTHROPIC_AUTH_TOKEN) {
    const key = process.env.ANTHROPIC_AUTH_TOKEN;
    line = line.split(JSON.stringify(key).slice(1, -1)).join("[Redacted]");
  }
  process.stdout.write(line);
  // Diagnostic only, off unless VIDAR_SIDECAR_DUMP names a file: answers "does the SDK
  // ever yield <task-notification>, and what shape do hand-backs have" without a rebuild
  // (this file loads from disk each launch — a new tab picks up the env var, not a running one).
  // Lazy-opened by appendFileSync itself; a write failure (bad path, no permission) is swallowed
  // so the dump can never take the real stdout stream down with it.
  if (process.env.VIDAR_SIDECAR_DUMP) {
    try { appendFileSync(process.env.VIDAR_SIDECAR_DUMP, line); } catch {}
  }
}
function fail(message, code = 1) {
  out({ type: "sidecar", subtype: "error", message });
  process.exit(code);
}
// --falcon only: exactly one terminal outcome per inbound cid. `extra` carries the "mode"/"model"
// field that observe_falcon only commits when state is "applied".
function falconOutcome(cid, state, message, extra) {
  if (!falcon || typeof cid !== "number") return;
  out({ type: "falcon", subtype: "outcome", cid, state, ...(message ? { message } : {}), ...(extra ?? {}) });
}

if (!cwd) fail("--cwd is required");
if (!ALLOWED_MODES.has(permissionMode)) fail(`permission mode not allowed: ${permissionMode}`);
if (effort !== undefined && !EFFORT_LEVELS.includes(effort)) fail(`effort level not allowed: ${effort}`);
if (resume !== undefined && !/^[0-9a-f-]{36}$/.test(resume)) fail("resume id is not a UUID");
// A launch profile (Falcon admitted it): the whole option set comes from the profile file.
const profileArg = arg("--profile");
let bare = null;
if (profileArg !== undefined) {
  if (arg("--rules-file")) fail("a launch profile carries no rules file");
  try { bare = bareOptions({ profile: profileArg, root: arg("--root"), home: arg("--home"), payload: arg("--payload"), setPlugins: setPluginArgs(argv) }); }
  catch (e) { fail(`launch profile: ${e?.message ?? e}`); }
}
const flow = flowOptions({ profile: profileArg, payload: arg("--flow-payload"), servers: arg("--mcp-servers"), root: arg("--root") }, fail); // {} unless a Flow stage

/* ---- stdin → prompt queue + control ---- */

const queue = [];
let waiter = null;
let closed = false;
function push(item) {
  queue.push(item);
  if (waiter) { const w = waiter; waiter = null; w(); }
}
// One generator per query: a query rebuilt after an interrupt (see "run") gets a fresh one, and
// the dead query's generator, if anything still wakes it, returns before it takes an item.
let promptGen = 0;
async function* prompt() {
  const gen = ++promptGen; // --require-mcp (Flow): the first generator holds its first prompt until those servers connect
  if (gen === 1 && arg("--require-mcp") !== undefined) await (await import("./claude-sidecar-mcp-wait.mjs")).holdFirstPrompt(arg("--require-mcp"), () => q.mcpServerStatus(), out);
  for (;;) {
    while (queue.length && gen === promptGen) {
      const item = queue.shift();
      intWindow.hand(item);
      yield item;
    }
    if (closed || gen !== promptGen) return;
    await new Promise((r) => { waiter = r; });
  }
}

const pending = new Map(); // permission id → resolve(response)
// --falcon only: ids resolved via abort or session close rather than a permission_response, so
// canUseTool's post-await code knows not to also emit "settled" for an id already "cancelled".
const cancelledPermissions = new Set();
// --falcon only: permission id → tool_use_id (or null) for callbacks that have RETURNED but whose
// delivery to the CLI nothing has confirmed. An id leaves this map only when an agent signal
// settles it, which is the only thing that also emits "settled".
const returnedPermissions = new Map();
let q = null;

// A throw soon after a forwarded interrupt ends the turn and rebuilds the query (see "run").
const intWindow = createInterruptWindow();
let sessionId = resume ?? null; // the conversation a rebuilt query resumes

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { out({ type: "sidecar", subtype: "error", message: "bad JSON on stdin" }); return; }
  switch (m.type) {
    case "user":
      // "next": a message landing mid-turn (a Falcon steer) folds in at the next tool boundary, never "now" (aborts the turn)
      push({ type: "user", message: { role: "user", content: m.content }, parent_tool_use_id: null, origin: { kind: "human" }, priority: "next" });
      falconOutcome(m.cid, "applied"); // push cannot fail
      break;
    case "permission_response": {
      const r = pending.get(m.id);
      if (!r) {
        out({ type: "sidecar", subtype: "error", message: `no pending permission ${m.id}` });
        falconOutcome(m.cid, "failed", `no pending permission ${m.id}`);
        return;
      }
      pending.delete(m.id);
      r(m);
      if (falcon) out({ type: "falcon", subtype: "permission", id: m.id, state: "responded" });
      falconOutcome(m.cid, "applied");
      break;
    }
    case "interrupt": {
      // q?.interrupt() short-circuits the WHOLE chain (including .then) to undefined when there
      // is no session, so the "no session" outcome has to be reported before that line, not in it.
      if (falcon && typeof m.cid === "number" && !q) { falconOutcome(m.cid, "failed", "no session"); break; }
      if (q) intWindow.start();
      forwardInterrupt(q, () => q, m.cid, { out, falconOutcome });
      break;
    }
    case "set_model": {
      // same shape as set_permission_mode: the SDK's control request settles, then Vidar commits
      const want = typeof m.model === "string" ? m.model.trim() : "";
      if (!want || want.length > 80) {
        out({ type: "sidecar", subtype: "model_failed", message: "model name missing or too long" });
        falconOutcome(m.cid, "failed", "model name missing or too long");
        return;
      }
      if (!q) {
        out({ type: "sidecar", subtype: "model_failed", message: "no session" });
        falconOutcome(m.cid, "failed", "no session");
        return;
      }
      q.setModel(want).then(
        () => {
          options.model = want; // a query rebuilt after an interrupt keeps it
          out({ type: "sidecar", subtype: "model", model: want });
          falconOutcome(m.cid, "applied", undefined, { model: want });
        },
        (e) => {
          out({ type: "sidecar", subtype: "model_failed", message: `set_model: ${e?.message ?? e}` });
          falconOutcome(m.cid, "failed", `set_model: ${e?.message ?? e}`);
        },
      );
      break;
    }
    case "set_effort": {
      // session-scoped flag layer only (Query.applyFlagSettings); never settings.json, unlike the SDK's /effort
      const level = m.level;
      if (!EFFORT_LEVELS.includes(level)) {
        out({ type: "sidecar", subtype: "error", message: `effort level not allowed: ${level}` });
        falconOutcome(m.cid, "failed", `effort level not allowed: ${level}`);
        return;
      }
      if (!q) {
        out({ type: "sidecar", subtype: "error", message: "set_effort: no session" });
        falconOutcome(m.cid, "failed", "no session");
        return;
      }
      q.applyFlagSettings({ effortLevel: level }).then(
        () => {
          options.effort = level; // a query rebuilt after an interrupt keeps it
          out({ type: "effort", level });
          falconOutcome(m.cid, "applied");
        },
        (e) => {
          out({ type: "sidecar", subtype: "error", message: `set_effort: ${e?.message ?? e}` });
          falconOutcome(m.cid, "failed", `set_effort: ${e?.message ?? e}`);
        },
      );
      break;
    }
    case "set_permission_mode":
      if (!ALLOWED_MODES.has(m.mode)) {
        out({ type: "sidecar", subtype: "error", message: `mode not allowed: ${m.mode}` });
        falconOutcome(m.cid, "failed", `mode not allowed: ${m.mode}`);
        return;
      }
      // Answer when the SDK's control request settles, so Vidar commits the label on truth
      if (!q) {
        out({ type: "sidecar", subtype: "mode_failed", message: "no session" });
        falconOutcome(m.cid, "failed", "no session");
        return;
      }
      q.setPermissionMode(m.mode).then(
        () => {
          options.permissionMode = m.mode; // a query rebuilt after an interrupt keeps it
          out({ type: "sidecar", subtype: "mode", mode: m.mode });
          falconOutcome(m.cid, "applied", undefined, { mode: m.mode });
        },
        (e) => {
          out({ type: "sidecar", subtype: "mode_failed", message: `set_permission_mode: ${e?.message ?? e}` });
          falconOutcome(m.cid, "failed", `set_permission_mode: ${e?.message ?? e}`);
        },
      );
      break;
    default:
      out({ type: "sidecar", subtype: "error", message: `unknown stdin type ${m.type}` });
      falconOutcome(m.cid, "failed", `unknown stdin type ${m.type}`);
  }
});
rl.on("close", () => {
  closed = true;
  if (waiter) { const w = waiter; waiter = null; w(); }
  // Cancel every pending prompt as a deny; the SDK then cancels the CLI's prompt.
  for (const [id, r] of pending) {
    pending.delete(id);
    if (falcon) { cancelledPermissions.add(id); out({ type: "falcon", subtype: "permission", id, state: "cancelled" }); }
    r({ behavior: "deny", message: "Vidar closed the session" });
  }
});

/* ---- permission host ---- */

async function canUseTool(toolName, input, options) {
  const id = randomUUID();
  const n = bytes(input);
  const shown = n <= CAP ? input : { ...summarizeInput(toolName, input), __truncated: n };
  // toolUseId links the card to the tool pill Vidar already drew from the assistant message
  out({ type: "permission_request", id, toolUseId: options?.toolUseID ?? null, tool: toolName, input: shown, inputBytes: n, suggestions: options?.suggestions ?? [] });
  if (falcon) out({ type: "falcon", subtype: "permission", id, state: "opened" });
  const resp = await new Promise((resolve) => {
    pending.set(id, resolve);
    const onAbort = () => {
      if (pending.delete(id)) {
        if (falcon) { cancelledPermissions.add(id); out({ type: "falcon", subtype: "permission", id, state: "cancelled" }); }
        resolve({ behavior: "deny", message: "cancelled" });
      }
    };
    const sig = options?.signal;
    if (sig?.aborted) onAbort();
    else sig?.addEventListener?.("abort", onAbort, { once: true });
  });
  // Wrapped so a throw while building the result reports "failed" rather than a state that
  // sounds delivered — the Rust side then deliberately leaves the permission pending, because
  // the CLI is still blocked on a response that never actually arrived.
  try {
    let result;
    if (resp.behavior === "allow") {
      const r = { behavior: "allow", updatedInput: resp.updatedInput ?? input };
      if (Array.isArray(resp.updatedPermissions)) r.updatedPermissions = resp.updatedPermissions;
      result = r;
    } else {
      result = { behavior: "deny", message: typeof resp.message === "string" && resp.message ? resp.message : "Denied in Vidar" };
    }
    // already terminal via "cancelled" above: don't report anything further for the same id.
    // Otherwise say only what is true — the callback returned. Delivery is the SDK's to do
    // after this returns, and it reports neither success nor failure of that write.
    if (falcon && !cancelledPermissions.delete(id)) {
      returnedPermissions.set(id, options?.toolUseID ?? null);
      out({ type: "falcon", subtype: "permission", id, state: "returned" });
    }
    return result;
  } catch (e) {
    if (falcon) { returnedPermissions.delete(id); out({ type: "falcon", subtype: "permission", id, state: "failed" }); }
    throw e;
  }
}

/* ---- agent signals that settle a returned permission (--falcon only) ---- */

function settlePermission(id, signal) {
  if (!returnedPermissions.delete(id)) return;
  out({ type: "falcon", subtype: "permission", id, state: "settled", signal });
}
function settleByToolUse(toolUseId, signal) {
  if (typeof toolUseId !== "string" || !toolUseId) return;
  for (const [id, tu] of returnedPermissions) if (tu === toolUseId) { settlePermission(id, signal); return; }
}
// The only honest sources of "the CLI acted on that decision" the stream offers:
//   - a tool_result block for the permission's tool_use_id (the CLI writes one only after the
//     tool ran or was refused, so the decision was consumed);
//   - a denial naming the tool_use_id (system/permission_denied, or result.permission_denials,
//     which sdk.d.ts calls the authoritative record);
//   - the turn's own result message, which ends the turn the request was opened in: whatever
//     happened to the answer, the CLI is not blocked on it any more.
// Nothing here invents a signal for a request whose turn is still running.
function observeAgentSignals(msg) {
  if (!returnedPermissions.size) return;
  try {
    if (msg?.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) if (b?.type === "tool_result") settleByToolUse(b.tool_use_id, "tool_result");
      return;
    }
    if (msg?.type === "system" && msg.subtype === "permission_denied") {
      settleByToolUse(msg.tool_use_id, "permission_denied");
      return;
    }
    if (msg?.type === "result") {
      for (const d of Array.isArray(msg.permission_denials) ? msg.permission_denials : []) settleByToolUse(d?.tool_use_id, "permission_denied");
      for (const id of [...returnedPermissions.keys()]) settlePermission(id, "result");
    }
  } catch { /* bookkeeping must never break the stream */ }
}

// Per-message observers, started after arg validation: the opt-in statusline mirror (claude-sidecar-statusline.mjs; a bare tab mirrors into its own config dir, always) and, --falcon only, the usage ledger (claude-sidecar-ledger.mjs).
const observers = [startStatuslineMirror(bare ? { configDir: bare.configDir } : {}), startLedger({ enabled: falcon })];

/* ---- run ---- */
const options = {
  cwd,
  permissionMode,
  includePartialMessages: true, ...flow, // a Flow stage's systemPrompt (Bare payload text) and mcpServers
  settingSources: settingSourcesFor(cwd), // project settings (hooks) only in folders Claude trusted
  canUseTool,
  // Effort is not on the stream; the SDK surfaces it only on hook inputs that
  // fire inside a turn (input.effort.level, same shape as the statusline's).
  // Stop fires once per turn, so that is where the status line learns it.
  hooks: {
    Stop: [{ hooks: [async (input) => {
      const level = input?.effort?.level;
      if (typeof level === "string" && level) out({ type: "effort", level });
      return {};
    }] }],
    // The prompt cache's TTL is on no other hook input and nowhere on the stream, so this
    // is the one place the panel can learn whether it is 1h or 5m (overage). `source`
    // includes "sdk" and "resume", so a Vidar model switch and a resume both reach here.
    // Returns {} deliberately: PostModelSwitch's output is `additionalContext`, and a
    // string there would be injected into the next request.
    PostModelSwitch: [{ hooks: [async (input) => {
      const ttl = input?.cache_ttl;
      if (ttl === "5m" || ttl === "1h") out({ type: "sidecar", subtype: "cache_ttl", ttl });
      return {};
    }] }],
  },
};
if (model) options.model = model;
if (effort) options.effort = effort;
if (resume) options.resume = resume;
if (claudeExe) options.pathToClaudeCodeExecutable = claudeExe;
// Built rules file (Falcon admits it under <vidar>\runtime\rules\built first): the CLI appends its text to the
// system prompt; works with systemPrompt unset and on resume (rule-injection W0 probe a).
const rulesFile = arg("--rules-file");
if (rulesFile) options.extraArgs = { "append-system-prompt-file": rulesFile };
// Local plugin dirs: `pluginDirs` (string[]) in vidar.json, relative paths against the Vidar root (walk up to
// the dir holding the sidecar, via the statusline module's readVidarConfig, so a Falcon bundle copy resolves).
// Absent or bad: option omitted. A bare tab never reads vidar.json: its plugins are the profile's.
const pluginDirs = (() => {
  if (bare) return [];
  const found = readVidarConfig();
  if (!found) return [];
  const { root, cfg } = found;
  return (Array.isArray(cfg?.pluginDirs) ? cfg.pluginDirs : [])
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => ({ type: "local", path: isAbsolute(p) ? p : resolve(root, p) }));
})();
// The Vidar app plugin (<root>\plugins\vidar-app) is always on, independent of vidar.json, when the folder
// exists; its drive tools are auto-allowed by server prefix. Deduped against pluginDirs by resolved path.
const appPluginDir = (() => {
  if (bare) return null;
  const root = vidarRoot();
  const dir = root ? join(root, "plugins", "vidar-app") : null;
  return dir && existsSync(dir) ? dir : null;
})();
if (appPluginDir) {
  const key = (p) => resolve(p).toLowerCase();
  const rest = pluginDirs.filter((p) => key(p.path) !== key(appPluginDir));
  options.plugins = [{ type: "local", path: appPluginDir }, ...rest];
  options.allowedTools = [...(options.allowedTools ?? []), "mcp__plugin_vidar_drive"];
} else if (pluginDirs.length) options.plugins = pluginDirs;

// Bare: user settings only (the tab's own CLAUDE_CONFIG_DIR, set by Falcon), the profile's payload
// (sent as systemPrompt.append, the checked text, not a path the CLI rereads), exactly its rendered
// plugin set, the drive tools allowed. No `env` option: it would replace the env Falcon built.
if (bare) {
  options.settingSources = bare.settingSources;
  options.systemPrompt = bare.systemPrompt;
  options.extraArgs = { ...(options.extraArgs ?? {}), ...bare.extraArgs };
  delete options.extraArgs["append-system-prompt-file"]; // a --rules-file path would be a second append
  options.plugins = bare.plugins;
  options.allowedTools = bare.allowedTools;
}

// The checked vendor fence and plugin replace configurable Rendered plugin directories, as in Raw.
// systemPrompt.append replaces the CLI's --append-system-prompt-file, so the built rules text joins the
// vendor prompt in the one append string and the extraArgs entry is dropped.
if (arg("--vendor-settings")) {
  options.settings = arg("--vendor-settings");
  options.plugins = [{ type: "local", path: arg("--vendor-plugin") }];
  delete options.allowedTools;
  const append = [arg("--vendor-prompt"), options.systemPrompt?.append];
  if (rulesFile) {
    append.push(readFileSync(rulesFile, "utf8"));
    delete options.extraArgs["append-system-prompt-file"];
    if (!Object.keys(options.extraArgs).length) delete options.extraArgs;
  }
  options.systemPrompt = { type: "preset", preset: "claude_code", append: append.filter(Boolean).join("\n\n") };
}

// Resume: replay the session's history first so the body shows what came before.
if (resume) await replayHistory(resume, getSessionMessages, { out, shrink });

let initRecorded = false;
for (let first = true; ; first = false) {
  try {
    q = query({ prompt: prompt(), options });
    if (first) {
      out({ type: "sidecar", subtype: "ready", pid: process.pid, model: model ?? settingsModel() });
      // seeds, emitted before the stream can yield so any real event lands after and wins
      { const level = seededEffort(effort, bare?.configDir); if (level) out({ type: "effort", level }); }
      { const seed = seededLimits(bare?.configDir); if (seed) out(seed); }
    }
    // the CLI's own model list (initialize response) feeds the status-bar picker;
    // absent or late, the picker just has nothing to offer
    q.initializationResult().then(
      // `resolvedModel` is the canonical id an alias row covers ("sonnet" → "claude-sonnet-5");
      // without it the picker cannot tell which row is the model already running
      (r) => out({ type: "sidecar", subtype: "models", models: (r?.models ?? []).map((x) => ({ value: x.value, label: x.displayName ?? x.value, resolved: x.resolvedModel })) }),
      () => {},
    );
    for await (const msg of q) {
      // A bare tab's first system/init, as received: what the CLI actually loaded (create-new).
      if (bare && !initRecorded && msg?.type === "system" && msg.subtype === "init") {
        initRecorded = true;
        writeInitOnce(bare, process.env.FALCON_SESSION, msg);
      }
      if (typeof msg?.session_id === "string" && msg.session_id) sessionId = msg.session_id;
      // the CLI's own mode changes (plan mode, an accepted setMode) ride a rebuilt query too
      if (msg?.type === "system" && (msg.subtype === "init" || msg.subtype === "status") && ALLOWED_MODES.has(msg.permissionMode)) options.permissionMode = msg.permissionMode;
      intWindow.observe(msg); // a new turn after the interrupted one's result closes the window
      out(shrink(msg));
      if (falcon) observeAgentSignals(msg); // after the message, so a client sees the cause first
      for (const observe of observers) observe(msg);
    }
    out({ type: "sidecar", subtype: "closed" });
    process.exit(0);
  } catch (e) {
    const message = `query: ${e?.message ?? e}`;
    if (closed || !sessionId || !intWindow.caught()) fail(message);
    intWindow.recover(message, { pending, falcon, cancelledPermissions, out, observeAgentSignals, queue, options, sessionId });
  }
}
