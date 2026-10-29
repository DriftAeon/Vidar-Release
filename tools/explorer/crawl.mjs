// No-model navigation crawl: breadth-first over tabs, menus, links and nav buttons in the
// attested card sandbox. Every press goes through the `act` verb, so the run log and console cursor
// behave as they do for an agent. Findings: <run>/findings.jsonl (goal and episode "crawl").
// Usage: node tools/explorer/crawl.mjs --run <dir> [--port 9333] [--max 150]
// Refuses (exit 2) unless the target passes the real-input gate (never 9222/9223, never an unattested window).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateRealInput, matchNoPress, drainExternal } from "../drive/drive-input.mjs";
import { logVerb } from "../drive/run-log.mjs";
import { validateFindingLine } from "../drive/explorer-contracts.mjs";
import { act } from "../drive/verbs/act.mjs";
import { snapshot } from "../drive/verbs/snapshot.mjs";

export const SKIP_NAMES = /\b(send|approve|deny|delete|remove|hide|disable|close|end|jettison|quit|restart|swap|login|log in|sign|run)\b/i;
export const SKIP_CARD = /\bcard\b/i;
export const SKIP_COMPOSER = /\bcomposer\b/i;
const CANDIDATE_ROLES = ["tab", "menuitem", "link", "button"];
const NAV_BUTTON = /\b(settings|menu|more|options|bench|launcher|modules?|files|history|agents|workbench|tray|open|new tab|preferences|help|about)\b/i;
const LANDMARK_ROLES = ["dialog", "alertdialog", "menu", "listbox", "tablist", "toolbar"];
const INTERACTIVE = ["button", "link", "tab", "menuitem", "menuitemcheckbox", "checkbox", "radio", "switch", "option", "textbox", "combobox", "slider"];

const keyOf = (l) => `${l.role}\u0000${l.name}\u0000${l.nth}`;
const sigOf = (snap) => snap.nodes.filter((n) => LANDMARK_ROLES.includes(n.role)).map((n) => `${n.role}:${n.name}`).sort().join("|");
const find = (snap, loc) => snap.nodes.find((n) => keyOf(n.locator) === keyOf(loc));

/** @returns {string|null} why a node is not a crawl target, or null when it is one. */
export function skipReason(n) {
  if (!CANDIDATE_ROLES.includes(n.role)) return null; // not a candidate at all
  if (!n.name) return "unnamed";
  if (n.state?.enabled === false) return "disabled";
  if (matchNoPress({ role: n.role, name: n.name, cls: "" })) return "no-press";
  if (SKIP_NAMES.test(n.name)) return "skip-list";
  if (SKIP_CARD.test(n.name)) return "card";
  if (SKIP_COMPOSER.test(n.name)) return "composer";
  if (n.role === "button" && n.state?.expanded === undefined && !NAV_BUTTON.test(n.name)) return "not-navigation";
  return undefined; // target
}

/** Crawls through `base` (a drive ctx: PORT, evalJs, send, plus loadDevCards/consoleVerb/snapshotFn in tests). */
export async function crawl(base, { run, max = 150, now = () => new Date() }) {
  const env = { ...(base.env ?? process.env), VIDAR_DRIVE_EXPLORER: "1", VIDAR_EXPLORER_RUN: run, VIDAR_EXPLORER_EPISODE: "crawl" };
  const ctx = { ...base, env, flags: base.flags ?? {} };
  await gateRealInput(ctx);
  await drainExternal(ctx); // calls blocked before the crawl are not its detours
  const snapFn = base.snapshotFn ?? ((c, o) => snapshot(c, o));
  const full = () => snapFn(ctx, { delta: false });
  const skipped = {}, kinds = {}, written = new Set(), known = new Set(), visited = new Set();
  const queue = [];
  let presses = 0, step = 0;
  fs.mkdirSync(run, { recursive: true });

  const finding = (group, kind, intent, did, observed, expected) => {
    if (written.has(group)) return;
    written.add(group);
    const line = { t: now().toISOString(), goal: "crawl", step: ++step, intent, did, observed: String(observed).slice(0, 300), expected, kind, episode: "crawl" };
    const errs = validateFindingLine(line);
    if (errs.length) throw new Error(`finding invalid: ${errs.join("; ")}`);
    fs.appendFileSync(path.join(run, "findings.jsonl"), JSON.stringify(line) + "\n");
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  };
  const discover = (snap, parent) => {
    for (const n of snap.nodes) {
      const k = keyOf(n.locator);
      if (known.has(k)) continue;
      known.add(k);
      const why = skipReason(n);
      if (why === null) continue;
      if (why) { skipped[why] = (skipped[why] ?? 0) + 1; continue; }
      queue.push({ loc: n.locator, name: n.name, parent });
    }
  };
  const drive = async (a1, a2) => {
    try {
      const out = await act({ ...ctx, a1, a2 });
      logVerb(env, "act", ctx.PORT, [a1, a2], out, 0);
      return out;
    } catch (e) { logVerb(env, "act", ctx.PORT, [a1, a2], undefined, e.exitCode ?? 1); throw e; }
  };
  const errorsOf = (out, item) => {
    for (const m of out?.console ?? []) finding(`console\u0000${m.text}`, "fail", `open ${item.name}`, `press ${item.name}`, m.text, "no console errors");
  };
  /** Presses a trigger by locator; returns the act result, or null when out of budget / gone / refused. */
  const pressItem = async (item, node) => {
    if (presses >= max) return null;
    presses++;
    try { return await drive("press", node.ref); }
    catch (e) {
      if (/stale ref/.test(e.message)) finding(`stale\u0000${keyOf(item.loc)}`, "stale", `open ${item.name}`, `press ${node.ref}`, e.message, "ref stays valid while crawling");
      else if (e.exitCode === 2) skipped["refused"] = (skipped["refused"] ?? 0) + 1;
      else throw e;
      return null;
    }
  };
  const locate = async (item) => {
    let node = find(await full(), item.loc);
    if (!node && item.parent) { await reopen(item.parent); node = find(await full(), item.loc); }
    return node;
  };
  const reopen = async (item) => { // press a parent trigger again (its own ancestors first when it is off screen)
    const node = await locate(item);
    if (node) await pressItem(item, node);
  };

  const first = await full();
  discover(first, null);
  while (queue.length && presses < max) {
    const item = queue.shift();
    const k = keyOf(item.loc);
    if (visited.has(k)) { skipped["visited"] = (skipped["visited"] ?? 0) + 1; continue; }
    const node = await locate(item);
    if (!node) { skipped["gone"] = (skipped["gone"] ?? 0) + 1; continue; }
    const beforeSnap = await full();
    const before = sigOf(beforeSnap);
    const beforeKeys = new Set(beforeSnap.nodes.map((n) => keyOf(n.locator)));
    visited.add(k);
    const out = await pressItem(item, node);
    if (!out) continue;
    if (out.hit && out.hit.ok === false) skipped["miss"] = (skipped["miss"] ?? 0) + 1;
    for (const n of out.delta?.nodes ?? []) {
      if (!INTERACTIVE.includes(n.role) || beforeKeys.has(keyOf(n.locator))) continue; // only what the press added
      const under = n.cover ? ` under ${n.cover.tag}${n.cover.cls ? `.${n.cover.cls.split(/\s+/)[0]}` : ""} "${n.cover.name}" (${n.cover.relation})` : "";
      for (const f of n.flags) finding(`flag\u0000${f}\u0000${keyOf(n.locator)}`, "fail", `open ${item.name}`, `press ${node.ref}`, `${f}: ${n.role} "${n.name}"${f === "occluded" ? under : ""}`, "no layout flags");
    }
    for (const x of out.external ?? []) finding(`detour\u0000${x.cmd}\u0000${keyOf(item.loc)}`, "detour", `open ${item.name}`, `press ${node.ref}`, `"${item.name}" opens ${x.cmd} ${x.args}`, "stays in the app");
    errorsOf(out, item);
    if (out.delta) discover(await full(), item);
    try { errorsOf(await drive("key", "Escape"), item); } catch (e) { if (e.exitCode !== 2) throw e; }
    if ((sigOf(await full()) !== before) && item.parent) await reopen(item.parent);
  }
  return { visited: visited.size, pressed: presses, skipped, findings: kinds };
}

async function cdpCtx(port) {
  const EVAL_MS = 15000;
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref())]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const page = targets.find((t) => t.type === "page" && !/overlay/i.test(t.url) && !/overlay/i.test(t.title ?? ""));
  if (!page) throw new Error("no Vidar page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await withTimeout(new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }), 5000, "DevTools websocket open");
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression, ms = EVAL_MS) => {
    const r = await withTimeout(send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), ms, "Runtime.evaluate");
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { ctx: { PORT: String(port), evalJs, send, withTimeout, EVAL_MS, events }, close: () => ws.close() };
}

async function main(argv) {
  const opt = (name, dflt) => { const i = argv.indexOf(name); return i < 0 ? dflt : argv[i + 1]; };
  const run = opt("--run");
  const max = Number(opt("--max", 150));
  if (!run || !Number.isInteger(max) || max < 1) { console.error("usage: node tools/explorer/crawl.mjs --run <dir> [--port 9333] [--max 150]"); return 2; }
  let conn;
  try {
    conn = await cdpCtx(opt("--port", 9333));
    console.log(JSON.stringify(await crawl(conn.ctx, { run: path.resolve(run), max })));
    return 0;
  } catch (e) { console.error(String(e.message ?? e)); return e.exitCode ?? 1; }
  finally { conn?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
