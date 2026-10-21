// Drive the running Vidar over the WebView2 DevTools port — the headless
// verification tool. Launch Vidar with the debug flag first:
//
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   Start-Process <repo>\src-tauri\target\release\vidar.exe -WorkingDirectory <repo>
//   (tools\release\swap-release.ps1 -Debug does both)
//
// Usage:
//   node tools\drive\vidar-drive.mjs eval   "<js expression>"        result as JSON (promises awaited)
//   node tools\drive\vidar-drive.mjs invoke <command> [<json args>]  a Tauri command, via the page's own bridge
//   node tools\drive\vidar-drive.mjs click  "<css selector>"         first match; error if none
//   node tools\drive\vidar-drive.mjs text   "<css selector>"         textContent of every match
//   node tools\drive\vidar-drive.mjs shot   <out.png>                screenshot for the user (never parse it here)
//   node tools\drive\vidar-drive.mjs console                         {errors, warnings, messages[]} logged since the page
//                                                                     loaded, load-time ones included (WebGL shader errors).
//                                                                     The smoke gate reads `errors`. Exit 0 either
//                                                                     way; exit 1 only when the tool itself fails
//
// Rendered-flow verbs, each a one-line eval of window.__vidarDrive
// (src\main.ts) — a smoke that used to be ~40 click/text calls is ~5 of these:
//   node tools\drive\vidar-drive.mjs open   '<json {agent, model?, permissionMode?, cwd?}>'   opens a Rendered tab, returns its id.
//                                                                     JSON or a JS object literal; cwd backslashes (single or
//                                                                     doubled) survive; a cwd that is not a directory exits 2
//                                                                     before any tab exists
//   node tools\drive\vidar-drive.mjs send   <tabId> "<text>"          write(text + "\r") — \r submits
//   node tools\drive\vidar-drive.mjs answer <tabId> '<json Answer>'   drives the oldest pending tool-permission card inside
//                                                                     a rendered tab (state.tabs[].cards), or the one
//                                                                     named by Answer.requestId; fire-once — confirm
//                                                                     via `state`, never retry (a retry on a hosted
//                                                                     tab sends the permission response twice)
//   node tools\drive\vidar-drive.mjs card <id> approve|deny ['<json {choice?, comment?}>']
//                                                                     answers an ask-gate modal (ctl spawn/prompt/ask
//                                                                     cards, Astra ask) listed in state.cards; only the
//                                                                     one with onScreen:true is answerable, the rest
//                                                                     queue behind it. Fire-once, same as answer
//   node tools\drive\vidar-drive.mjs state                           every tab, merged with each rendered tab's drive(),
//                                                                     plus `cards`: pending ask-gate modals
//                                                                     {id, kind, title, tab, details, onScreen}
//
// Run ledger — a smoke ends with these two (drive-ledger.mjs, runtime\bridge\driver\ledger.json):
//   the first verb of a smoke (no ledger younger than 2 h and the budget's arming) snapshots,
//   before it acts (ledger v3): the hosted tabs' Falcon sessions (plus hosted tabs with none, by tab
//   id), the local (non-hosted) tab ids, the page's timeOrigin, and the live Falcon session ids
//   (null when Falcon is unavailable or a call fails).
//   node tools\drive\vidar-drive.mjs close-spawned                   ends every hosted tab not in the snapshot, via tab X;
//                                                                     {since, closed, missing, remaining, unresolved}; exit 0;
//                                                                     unresolved (no Falcon session, new) are never closed.
//                                                                     Detection only: it never kills or adopts a session
//   node tools\drive\vidar-drive.mjs check-clean                     exit 4, one stderr line per leftover with its action: hosted
//                                                                     tabs, local tabs, live Falcon sessions nobody holds (shell:
//                                                                     Close Session in the shell; parked: Launcher row), or
//                                                                     "could not list Falcon sessions". Exit 0 clears the ledger
//                                                                     (the run is over). Both exit 1 with no live ledger
//
// Shortcut and paste verbs — code
// path, not OS input; they test our handlers, not the OS clipboard → WebView2 handoff:
//   node tools\drive\vidar-drive.mjs shortcut <id>                   runs a registered shortcut's action (cycle-tab,
//                                                                     cycle-tab-back, …); skips key matching.
//                                                                     Unknown id → error listing the valid ids
//   node tools\drive\vidar-drive.mjs paste <terminal|tray|composer> "<text>"|@<file>
//                                                                     synthetic ClipboardEvent("paste") at the receiver:
//                                                                     terminal = active terminal tab's xterm, tray =
//                                                                     #workbench, composer = active Rendered tab.
//                                                                     @x.png/.jpg/.jpeg → an image file (tray only);
//                                                                     any other @file → its UTF-8 text; @@… → literal "@…".
//                                                                     Returns what the receiver did (handled, lengths,
//                                                                     tray block count) and whether clipboardData arrived
//
// Raw (shell-kind) tabs — gateway agents, Gemini, Pi, Terminal — have no rendered body, so
// `send`/`answer` refuse them; `state` still lists them and gives the tab id. The recipe
// (gateway-tab smoke, ~12 calls):
//   click '#new-session'                                  open the launcher
//   text  '#launcher-menu > button'                       type rows, in order → pick nth-child(N)
//   click '#launcher-menu > button:nth-child(N)'          opens the location column
//   click '.launcher-col[data-depth="0"] > button:nth-child(M)'   UE=1 Vidar=2 Main=3 → spawns
//   invoke write_pty '{"id":"<tab id>","data":"<text>\r"}'        types into the PTY; \u0003 is Ctrl+C
//   eval "[...document.querySelectorAll('.xterm-rows')].map(r=>r.innerText).join('\n')"   read the screen
// Quote the selectors with single quotes from PowerShell; escaping the inner double quotes breaks them.
//
// Opt-in only: the debug port lets anything local drive the window, so the
// normal launch never sets it. This script is the no-dependency fallback and
// the in-session tool.
//
// Budget: VIDAR_DRIVE_BUDGET=<n> caps calls for a smoke — a stuck
// poll loop must not grind the DevTools port forever. Each call (every verb but
// `budget`) reads %TEMP%\vidar-drive-budget.json and decrements it (including
// this call) before acting, so a call that then fails (no DevTools) still counts, and one shell
// command chaining three verbs spends three; at 0 it exits 3 with "budget exhausted: 0 of <n> calls left; … stop and report".
// The cap binds the capped caller (an executor must not re-arm itself):
// a record armed under 2 h ago (drive-budget.mjs LOCK_MS) wins over
// any VIDAR_DRIVE_BUDGET value, exhausted or not — changing the env does not
// re-arm it, and neither does unsetting it (the PowerShell
// tool drops $env between calls).
// Older than that, the next call arms fresh from the env value.
//   node tools\drive\vidar-drive.mjs budget          read-only: calls left and when the lock expires
//   node tools\drive\vidar-drive.mjs budget reset --by-orchestrator
// re-arms explicitly (VIDAR_DRIVE_BUDGET must be set); it is for the session
// that set the cap, never for the capped body, and it prints a warning line
// and records `resetBy` in the file.
// Unset VIDAR_DRIVE_BUDGET and no live record: no cap, the file is never touched.
//
// Timing: set VIDAR_DRIVE_TIME=1 to get the phases on stderr,
// e.g. "list 12 ms · ws 9 ms · eval 31 ms". Each phase is capped so a stall
// names its phase instead of hanging: two calls took 11 s right after a tab
// spawn while the harness added 0.2 s for the same
// command, so the time was inside one of these phases — not yet attributed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stepBudget, resetBudget, budgetStatus, armedFromEnv } from "./drive-budget.mjs";
import { ledgerFile, armsLedger, liveLedger, writeLedger, clearLedger, snapshotRecord, spawnedHosted, leftoverLocal, leftoverSessions } from "./drive-ledger.mjs";

// The Falcon shell runs on its own debug port (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
// --remote-debugging-port=9223), so VIDAR_CDP_PORT lets this same script drive it too.
const CDP = `http://127.0.0.1:${process.env.VIDAR_CDP_PORT ?? 9222}`;
const [cmd, a1, a2] = process.argv.slice(2);
if (!cmd) { console.error("usage: eval|invoke|click|text|shot|open|send|answer|card|state|shortcut|paste|console|close-spawned|check-clean|budget …"); process.exit(2); }
if (cmd === "shortcut" && a1 === undefined) {
  console.error("usage: node tools\\drive\\vidar-drive.mjs shortcut <id>");
  process.exit(2);
}
if (cmd === "paste" && a2 === undefined) {
  console.error("usage: node tools\\drive\\vidar-drive.mjs paste <terminal|tray|composer> \"<text>\"|@<file>");
  process.exit(2);
}

// paste's payload, built before the budget step so a bad @file costs no call.
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
function pastePayload(arg) {
  if (arg.startsWith("@@")) return { text: arg.slice(1) };
  if (!arg.startsWith("@")) return { text: arg };
  const file = arg.slice(1);
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (e) { console.error(`paste: cannot read ${file}: ${e.message}`); process.exit(2); }
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  return type ? { file: { name: path.basename(file), type, base64: bytes.toString("base64") } } : { text: bytes.toString("utf8") };
}
const pasteArg = cmd === "paste" ? pastePayload(a2) : undefined;
if (cmd === "open" && a1 === undefined) {
  console.error("usage: node tools\\drive\\vidar-drive.mjs open '<json {agent, model?, permissionMode?, cwd?}>'");
  process.exit(2);
}
// open's options, parsed here and handed to the page as JSON: the
// arg is not spliced into the evaluated source, where a Windows path would lose its
// backslashes as JS escapes ("cwd is not a directory: C:AppsVidar"). No field
// holds a meaningful backslash, so any run of them (before anything but a
// quote, so an escaped \" survives) becomes "/" before parsing; cwd goes back
// to Windows form after. A cwd that is not a directory is refused here, before
// the budget step, because the tab would already exist when the spawn fails.
function openOpts(arg) {
  const src = arg.replace(/\\+(?=[^"\\])/g, "/");
  let o;
  try { o = JSON.parse(src); }
  catch {
    try { o = vm.runInNewContext(`(${src})`, Object.create(null), { timeout: 1000 }); }
    catch (e) { console.error(`open: cannot parse options: ${e.message}`); process.exit(2); }
  }
  if (!o || typeof o !== "object" || typeof o.agent !== "string") { console.error("open: options need a string `agent`"); process.exit(2); }
  if (o.cwd !== undefined) {
    if (typeof o.cwd !== "string") { console.error("open: cwd must be a string"); process.exit(2); }
    o.cwd = o.cwd.replace(/\//g, "\\");
    if (!path.win32.isAbsolute(o.cwd) || /^\\(?!\\)/.test(o.cwd)) {
      console.error(`open: cwd must be an absolute path (C:\\...): ${o.cwd}`); process.exit(2);
    }
    let dir = false;
    try { dir = fs.statSync(o.cwd).isDirectory(); } catch { /* reported below */ }
    if (!dir) { console.error(`open: cwd is not a directory: ${o.cwd}`); process.exit(2); }
  }
  return o;
}
const openArg = cmd === "open" ? openOpts(a1) : undefined;
if (cmd === "answer" && a2 === undefined) {
  console.error("usage: node tools\\drive\\vidar-drive.mjs answer <tabId> '<json Answer>'");
  process.exit(2);
}
// VIDAR_DRIVE_CARDS=1 is set only by orchestrator-written driven-smoke briefs; it is never advertised
// in docs, usage text or messages.
// `answer` approves tool-permission cards, so it is gated exactly like `card`: otherwise an agent
// could approve its own permission request.
if ((cmd === "card" || cmd === "answer") && process.env.VIDAR_DRIVE_CARDS !== "1") {
  console.error("card answers are the user's; use the Vidar card");
  process.exit(2);
}
if (cmd === "card" && (a1 === undefined || (a2 !== "approve" && a2 !== "deny"))) {
  console.error("usage: node tools\\drive\\vidar-drive.mjs card <id> approve|deny ['<json {choice?, comment?}>']");
  process.exit(2);
}
const cardOpts = process.argv[5];
if (cmd === "card" && cardOpts !== undefined) {
  let parsed;
  try { parsed = JSON.parse(cardOpts); } catch (e) { console.error(`card: options are not JSON: ${e.message}`); process.exit(2); }
  // spliced into the evaluated source below, so only a plain object passes
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("usage: node tools\\drive\\vidar-drive.mjs card <id> approve|deny ['<json {choice?, comment?}>'] — options must be a JSON object");
    process.exit(2);
  }
}

const BUDGET_FILE = path.join(os.tmpdir(), "vidar-drive-budget.json");

// `budget` alone is read-only: what binds now, never a reset and never a step.
if (cmd === "budget" && a1 === undefined) {
  const s = budgetStatus(BUDGET_FILE);
  if (!s) console.log("no live budget: uncapped unless VIDAR_DRIVE_BUDGET is set");
  else console.log(`budget: ${s.remaining} of ${s.armed} calls left; lock expires ${new Date(s.expiresAt).toISOString()}${s.resetBy ? ` (reset by ${s.resetBy})` : ""}`);
  process.exit(0);
}
if (cmd === "budget") {
  const state = a1 === "reset" && a2 === "--by-orchestrator"
    ? resetBudget(BUDGET_FILE, process.env.VIDAR_DRIVE_BUDGET, { byOrchestrator: true })
    : null;
  if (!state) {
    console.error("budget reset is orchestrator-only (needs VIDAR_DRIVE_BUDGET as a positive integer); a capped caller stops and reports instead");
    process.exit(2);
  }
  console.error(`WARNING: drive budget reset --by-orchestrator used; re-armed to ${state.armed} calls`);
  console.log(`budget armed: ${state.armed} calls`);
  process.exit(0);
}
const step = stepBudget(BUDGET_FILE, process.env.VIDAR_DRIVE_BUDGET);
const lockExpiry = () => {
  const s = budgetStatus(BUDGET_FILE);
  return s ? new Date(s.expiresAt).toISOString() : "unknown";
};
if (step && step.remaining < 0) {
  console.error(`budget exhausted: 0 of ${step.armed} calls left; lock expires ${lockExpiry()}; stop and report; only \`budget reset --by-orchestrator\` re-arms it`);
  process.exit(3);
}
const envUnset = step && armedFromEnv(process.env.VIDAR_DRIVE_BUDGET) === null;
if (step?.envIgnored || envUnset) {
  const why = envUnset ? "VIDAR_DRIVE_BUDGET is unset" : `VIDAR_DRIVE_BUDGET=${process.env.VIDAR_DRIVE_BUDGET} ignored`;
  console.error(`${why}: the armed budget binds, ${step.remaining} of ${step.armed} calls left; lock expires ${lockExpiry()}; see \`budget\``);
}

const CONNECT_MS = 5000; // /json/list and the websocket open
const EVAL_MS = 15000;   // one Runtime.evaluate / screenshot
const timing = !!process.env.VIDAR_DRIVE_TIME;
const phases = [];
let last = performance.now();
const lap = (name) => { const now = performance.now(); phases.push(`${name} ${Math.round(now - last)} ms`); last = now; };
const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref()),
]);

let targets;
try { targets = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(CONNECT_MS) })).json(); }
catch (e) {
  console.error(e?.name === "TimeoutError"
    ? `DevTools /json/list on 9222 timed out after ${CONNECT_MS} ms (port open, listener stalled)`
    : "no DevTools on 9222 — launch Vidar with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222");
  process.exit(1);
}
lap("list");
// the main window: a page target that is not the marquee overlay
const page = targets.find((t) => t.type === "page" && !/overlay/i.test(t.url) && !/overlay/i.test(t.title ?? ""));
if (!page) { console.error("no Vidar page target; targets:", targets.map((t) => `${t.type} ${t.url}`)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
try { await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), CONNECT_MS, "DevTools websocket open"); }
catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
lap("ws");
let id = 0;
const pending = new Map();
const events = []; // CDP events (no id); only the `console` verb enables a domain that sends any
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

async function evalJs(expression) {
  const r = await withTimeout(send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), EVAL_MS, "Runtime.evaluate");
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const q = (s) => JSON.stringify(s);

// Run ledger (drive-ledger.mjs): the first verb of a smoke snapshots the hosted tabs' Falcon
// session ids (tab ids change on reload); close-spawned
// and check-clean compare against it and need it live. A page without the drive hook (the Falcon
// shell on VIDAR_CDP_PORT) has no tab state, so it gets no ledger.
const STATE_JS = `(() => window.__vidarDrive?.state ? window.__vidarDrive.state() : null)()`;
// One probe for the ledger and check-clean: `{state, page, falcon}`, falcon being
// `{sessions: falcon_list's, held: falcon_hosted_held's}`. No host (falcon_available false; it never
// starts one) reads as no sessions: Falcon exits 300 s after its last client, so that is the usual
// state at a snapshot. A busy pipe can also read false; detection only, so the worst case is a
// pre-smoke session reported as a leftover, never one closed. Any call throwing gives null.
// falcon_list starts a host if none is up, so it runs only after available is true.
const PROBE_JS = `(async () => {
  const state = window.__vidarDrive?.state ? await window.__vidarDrive.state() : null;
  let falcon = { sessions: [], held: [] };
  try {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    if (await invoke("falcon_available")) {
      const list = await invoke("falcon_list");
      const held = await invoke("falcon_hosted_held");
      falcon = { sessions: list.sessions ?? [], held: held ?? [] };
    }
  } catch { falcon = null; }
  return { state, page: performance.timeOrigin, falcon };
})()`;
const LEDGER = ledgerFile();
const ledgerVerb = cmd === "close-spawned" || cmd === "check-clean";
let ledger = liveLedger(LEDGER, budgetStatus(BUDGET_FILE));
if (!ledger && armsLedger(cmd)) {
  try {
    const probe = await evalJs(PROBE_JS);
    if (probe.state) ledger = writeLedger(LEDGER, snapshotRecord(probe), Date.now());
  } catch (e) {
    console.error(`ledger snapshot skipped: ${e.message ?? e}`);
  }
  lap("ledger");
}
if (!ledger && ledgerVerb) {
  console.log(`${cmd}: no ledger, so no spawning verb ran since the last clean`);
  process.exit(0);
}
const ledgerAt = () => new Date(ledger.at).toISOString();

// close-spawned: the tab X path (`.session-close` → closeSession → closeHostedTab → falcon_kill),
// not a direct falcon_kill invoke, which needs the tab's view generation and silently no-ops on a
// wrong one. Waits up to 8 s for the tabs to leave state.
// Unresolved hosted tabs (no Falcon session, not seen at snapshot) are reported, never closed.
async function closeSpawned() {
  const { spawned: ids, unresolved } = spawnedHosted(ledger, await evalJs(STATE_JS));
  if (ids.length === 0) return { since: ledgerAt(), closed: [], missing: [], remaining: [], unresolved };
  return { since: ledgerAt(), unresolved, ...await evalJs(`(async (ids) => {
    const closed = [], missing = [];
    for (const id of ids) {
      const x = document.querySelector('.session-btn[data-id="' + CSS.escape(id) + '"] .session-close');
      if (x) { x.click(); closed.push(id); } else missing.push(id);
    }
    const live = async () => new Set((await window.__vidarDrive.state()).tabs.map((t) => t.id));
    for (const t0 = Date.now(); Date.now() - t0 < 8000; await new Promise((r) => setTimeout(r, 250))) {
      const now = await live();
      if (ids.every((id) => !now.has(id))) break;
    }
    const now = await live();
    return { closed, missing, remaining: ids.filter((id) => now.has(id)) };
  })(${JSON.stringify(ids)})`) };
}

// `console`: errors and warnings the page logged since it loaded. The page keeps its own console
// store for the document's lifetime whether or not DevTools is attached, and Runtime.enable /
// Log.enable replay it to each new session — so a fresh connection sees load-time messages
// (WebGL shader errors are missed if capture begins after the reveal). Sources:
// Runtime.consoleAPICalled (console.error/warn/assert), Runtime.exceptionThrown (uncaught), and
// Log.entryAdded (browser-side: WebGL, network, security, deprecation). A Log entry with the same
// level and text as a Runtime one is the same message reported twice and is merged.
const CONSOLE_SETTLE_MS = 300; // replay arrives with the enable calls; this catches stragglers
async function consoleSinceLoad() {
  await withTimeout(send("Runtime.enable"), EVAL_MS, "Runtime.enable");
  await withTimeout(send("Log.enable"), EVAL_MS, "Log.enable");
  await new Promise((r) => setTimeout(r, CONSOLE_SETTLE_MS));
  const argText = (a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value))
    : a.unserializableValue ?? a.description ?? a.type;
  const at = (url, line) => (url ? `${url}:${(line ?? 0) + 1}` : "");
  const messages = [];
  for (const e of events) {
    const p = e.params ?? {};
    if (e.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(p.type)) {
      const f = p.stackTrace?.callFrames?.[0];
      messages.push({ level: p.type === "warning" ? "warning" : "error", source: `console.${p.type}`,
        text: (p.args ?? []).map(argText).join(" "), at: at(f?.url, f?.lineNumber) });
    } else if (e.method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails ?? {};
      messages.push({ level: "error", source: "exception", text: d.exception?.description ?? d.text ?? "", at: at(d.url, d.lineNumber) });
    } else if (e.method === "Log.entryAdded" && ["error", "warning"].includes(p.entry?.level)) {
      const x = p.entry;
      const twin = messages.find((m) => !m.merged && m.level === x.level && !m.source.startsWith("log.") && m.text === x.text);
      if (twin) { twin.merged = true; continue; }
      messages.push({ level: x.level, source: `log.${x.source}`, text: x.text, at: at(x.url, x.lineNumber) });
    }
  }
  for (const m of messages) delete m.merged;
  return {
    errors: messages.filter((m) => m.level === "error").length,
    warnings: messages.filter((m) => m.level === "warning").length,
    since: "page load (replayed console store)",
    messages,
  };
}

try {
  let out;
  switch (cmd) {
    case "eval":
      out = await evalJs(a1);
      break;
    case "invoke":
      out = await evalJs(`window.__TAURI_INTERNALS__.invoke(${q(a1)}, ${a2 ?? "{}"})`);
      break;
    case "click":
      out = await evalJs(`(() => { const el = document.querySelector(${q(a1)}); if (!el) throw new Error("no match: " + ${q(a1)}); el.click(); return el.tagName + (el.className ? "." + String(el.className).split(" ").join(".") : ""); })()`);
      break;
    case "text":
      out = await evalJs(`[...document.querySelectorAll(${q(a1)})].map((e) => e.textContent.trim())`);
      break;
    case "shot": {
      const r = await withTimeout(send("Page.captureScreenshot", { format: "png" }), EVAL_MS, "Page.captureScreenshot");
      fs.mkdirSync(path.dirname(path.resolve(a1)), { recursive: true });
      fs.writeFileSync(a1, Buffer.from(r.data, "base64"));
      out = `wrote ${a1}`;
      break;
    }
    case "open":
      out = await evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.openTab(${JSON.stringify(openArg)}); })()`);
      break;
    case "send":
      out = await evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.send(${q(a1)}, ${q(a2)}); })()`);
      break;
    case "answer":
      out = await evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.answer(${q(a1)}, ${a2}); })()`);
      break;
    case "state":
      out = await evalJs(`(() => { if (!window.__vidarDrive) throw new Error("no __vidarDrive hook — old build?"); return window.__vidarDrive.state(); })()`);
      break;
    case "shortcut":
      out = await evalJs(`(() => { if (!window.__vidarDrive?.shortcut) throw new Error("no __vidarDrive.shortcut — old build?"); return window.__vidarDrive.shortcut(${q(a1)}); })()`);
      break;
    case "paste":
      out = await evalJs(`(() => { if (!window.__vidarDrive?.paste) throw new Error("no __vidarDrive.paste — old build?"); return window.__vidarDrive.paste(${q(a1)}, ${JSON.stringify(pasteArg)}); })()`);
      break;
    case "card":
      out = await evalJs(`(() => { if (!window.__vidarDrive?.card) throw new Error("no __vidarDrive.card — old build?"); return window.__vidarDrive.card(${q(a1)}, ${q(a2)}, ${cardOpts ?? "{}"}); })()`);
      break;
    case "console":
      out = await consoleSinceLoad();
      break;
    case "close-spawned":
      out = await closeSpawned();
      break;
    case "check-clean": {
      const probe = await evalJs(PROBE_JS);
      lap(cmd);
      const { spawned: left, unresolved } = spawnedHosted(ledger, probe.state);
      const loc = leftoverLocal(ledger, probe);
      const ses = leftoverSessions(ledger, probe);
      const lines = [];
      if (left.length > 0) lines.push(`not clean: ${left.length} hosted tab(s) opened since ${ledgerAt()} remain: ${left.join(", ")}; run close-spawned`);
      if (unresolved.length > 0) lines.push(`not clean: ${unresolved.length} hosted tab(s) with no Falcon session, not seen at ${ledgerAt()}: ${unresolved.join(", ")}; close them by hand`);
      for (const id of loc.spawned) lines.push(`not clean: local tab ${id} opened since ${ledgerAt()}; close tab ${id} with its X`);
      for (const id of loc.unresolved) lines.push(`not clean: local tab ${id} cannot be told from the snapshot's: page reloaded since the snapshot; close or keep these, then rerun check-clean after deleting runtime/bridge/driver/ledger.json`);
      for (const s of ses.spawned) lines.push(s.kind === "shell"
        ? `not clean: Falcon session ${s.session} opened since ${ledgerAt()} is held by the Falcon shell; end it with Close Session in the Falcon shell`
        : `not clean: Falcon session ${s.session} opened since ${ledgerAt()} is parked; close its row in the launcher's Falcon row`);
      for (const u of ses.unresolved) lines.push(`not clean: ${u}; rerun check-clean with Falcon up, or delete runtime/bridge/driver/ledger.json to end the run by hand`);
      if (lines.length > 0) {
        for (const l of lines) console.error(l);
        process.exit(4);
      }
      clearLedger(LEDGER);
      out = `clean: no tab or Falcon session opened since ${ledgerAt()} remains; ledger cleared`;
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
  lap(cmd);
  if (timing) console.error(phases.join(" · "));
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  process.exit(0);
} catch (e) {
  lap(cmd);
  console.error(String(e.message ?? e) + (timing || /timed out/.test(String(e.message)) ? `  [${phases.join(" · ")}]` : ""));
  process.exit(1);
}
