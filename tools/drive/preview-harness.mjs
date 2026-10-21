// Browser-side observer for the preview renderer fixtures, over the DevTools
// protocol. Required (not optional): the parent page cannot read an
// opaque-origin frame's location, so frame navigations, CSP-blocked requests
// and console entries are only observable here.
//
//   1. node tools\drive\preview-probe.mjs                      (loopback transport observer)
//   2. $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//      npm run tauri dev                                  (a separate dev instance)
//   3. node tools\drive\preview-harness.mjs                    (this; drives the run and records)
//
// Output: bridge\preview-harness.json (every window with its events) and a
// per case×config table on stdout with PASS/FAIL against manifest expectations.
import fs from "node:fs";
import { join } from "node:path";
import { resolve as resolveId } from "../lib/paths.mjs";

const CDP = "http://127.0.0.1:9222";
const OUT = join(resolveId("bridge"), "preview-harness.json");
const manifest = JSON.parse(fs.readFileSync("tests/preview-fixtures/manifest.json", "utf8"));

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
if (!page) { console.error("no dev-instance page on 9222; targets:", targets.map((t) => t.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});

// windows: keyed by "case|phase|config"; a window is open between start/end markers
const windows = [];
let open = null;
const orphan = { requests: [], failed: [], navigations: [], logs: [] };
const bucket = () => open ?? orphan;

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  switch (m.method) {
    case "Runtime.consoleAPICalled": {
      const text = m.params.args?.[0]?.value;
      if (typeof text !== "string" || !text.startsWith("VIDAR-HARNESS ")) return;
      const o = JSON.parse(text.slice(14));
      if (o.event === "run-start") { runNonce = o.nonce; }
      else if (o.event === "start") { open = { ...o, t0: Date.now(), requests: [], failed: [], navigations: [], logs: [] }; }
      else if (o.event === "end" && open) { Object.assign(open, o, { t1: Date.now() }); windows.push(open); open = null; }
      else if (o.event === "run-end") { finish(); }
      return;
    }
    case "Network.requestWillBeSent":
      bucket().requests.push({ url: m.params.request.url, type: m.params.type, initiator: m.params.initiator?.type });
      return;
    case "Network.loadingFailed":
      bucket().failed.push({ requestId: m.params.requestId, error: m.params.errorText, blocked: m.params.blockedReason ?? null, type: m.params.type });
      return;
    case "Page.frameNavigated":
      bucket().navigations.push({ frame: m.params.frame.id, url: m.params.frame.url, parent: m.params.frame.parentId ?? null });
      return;
    case "Log.entryAdded":
      bucket().logs.push({ level: m.params.entry.level, source: m.params.entry.source, text: m.params.entry.text.slice(0, 160) });
      return;
  }
};

await send("Network.enable");
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
console.log(`attached to ${page.url}; starting run…`);
await send("Runtime.evaluate", { expression: "window.__vidarRunFixtures && window.__vidarRunFixtures()", awaitPromise: false });

// "hits" means the PROBE received a request — the transport truth. CDP reports
// requestWillBeSent even for requests CSP then blocks before the network, so
// the CDP count is recorded as "attempted", never as a hit.
const PROBE_LOG = join(resolveId("bridge"), "preview-probe.log");
let runNonce = null;
function probeHits(w) {
  if (!runNonce) return 0;
  const log = fs.existsSync(PROBE_LOG) ? fs.readFileSync(PROBE_LOG, "utf8") : "";
  const needle = `run=${runNonce}&case=${w.case}&config=${w.config}&phase=${w.phase}`;
  return log.split("\n").filter((l) => l.includes("REQUEST") && l.includes(needle)).length;
}
function attempted(w) { return w.requests.filter((r) => r.url.startsWith("http://127.0.0.1:1447")).length; }
function cspBlocked(w) { return w.failed.filter((f) => /csp/i.test(f.blocked ?? "")).length; }

function verdict(c, w) {
  if (w.phase !== "mount") return { exp: "-", ok: true };
  const exp = c.expect[w.config] ?? "-";
  const hits = probeHits(w), csp = cspBlocked(w), tried = attempted(w);
  const childNav = w.navigations.filter((n) => n.parent && !/^about:srcdoc$|^about:blank$/.test(n.url)).length;
  let ok;
  switch (exp) {
    case "hits": ok = hits > 0; break;
    case "csp": ok = hits === 0; break; // network denied; csp/tried are recorded as evidence of the attempt
    case "none": ok = hits === 0 && childNav === 0 && (w.sentinel ?? 0) === 0; break;
    case "fires": ok = (w.sentinel ?? 0) > 0; break;
    default: ok = true; // manual / n/a
  }
  return { exp, ok, hits, csp, tried, childNav };
}

function finish() {
  fs.writeFileSync(OUT, JSON.stringify({ page: page.url, windows, orphan }, null, 2));
  const byId = new Map(manifest.cases.map((c) => [c.id, c]));
  let fails = 0;
  console.log("\ncase                         phase        config           hits tried csp nav sent  expect         result");
  for (const w of windows) {
    const c = byId.get(w.case); if (!c) continue;
    if (w.phase !== "mount") { if (w.structural?.length || w.fellBack) console.log(`${w.case.padEnd(28)} ${w.phase.padEnd(12)} ${"-".padEnd(16)} structural:${w.structural?.length ?? 0}${w.fellBack ? " fellBack:" + w.fellBack.reason : ""}`); continue; }
    const v = verdict(c, w);
    if (!v.ok) fails++;
    console.log(`${w.case.padEnd(28)} ${w.phase.padEnd(12)} ${String(w.config).padEnd(16)} ${String(v.hits).padStart(4)} ${String(v.tried).padStart(5)} ${String(v.csp).padStart(3)} ${String(v.childNav).padStart(3)} ${String(w.sentinel ?? 0).padStart(4)}  ${v.exp.padEnd(14)} ${v.ok ? "PASS" : "FAIL"}`);
  }
  const ctrl = windows.find((w) => w.case === "img-src" && w.config === "control");
  console.log(`\ntransport positive control (img-src/control): ${ctrl && probeHits(ctrl) > 0 ? "OK" : "FAILED — run is void"}`);
  console.log(`orphan events outside any window: ${orphan.requests.length} requests, ${orphan.navigations.length} navigations`);
  console.log(`${fails} failures; record: ${OUT}`);
  ws.close();
  process.exit(fails ? 1 : 0);
}
