// Flow layout gate: the Add button (and an open card's close button) stay inside the canvas pane and
// clear of the right toolbar. Reads rects over CDP from the card sandbox's Vidar, with Flow open.
//
// What it does: checks `.flow-plus-btn` is fully inside `#flow-view`, its right edge is at or left of
//   `#toolbench`'s left edge, and elementFromPoint at its centre lands in the button. The same for
//   `.flow-pop-close` when a card is open (skipped with a note otherwise). Then sweeps `#workbench`
//   narrower with a temporary inline max-width (640 and 520 px) and re-checks Add at each; each
//   width mutates and restores the original style attribute in one eval (try/finally). `#wb-tabs`'
//   last tab right edge against `#toolbench` left is printed as information only. Every rect is
//   printed; exit 1 on any failed check.
// Usage:  VIDAR_SANDBOX_ROOT=<root> VIDAR_CDP_PORT=9333 node tools/sandbox/flow-rects.mjs
// Refuses (exit 2): ports 9222/9223; VIDAR_SANDBOX_ROOT unset or not an attested card sandbox (the
//   gateRealInput attestation of tools/drive/drive-input.mjs: dev-cards.json plus the page's own
//   install root). Refusal happens before any DevTools connection when the environment fails.
// Exit 1: a check failed, Flow is not open, or no DevTools page. No dependency beyond Node's WebSocket.
import { gateRealInput } from "../drive/drive-input.mjs";

const PORT = Number(process.env.VIDAR_CDP_PORT ?? 9333);
const SWEEP = [640, 520];
const CONNECT_MS = 5000, EVAL_MS = 15000;

if (PORT === 9222 || PORT === 9223) {
  console.error(`refused: port ${PORT} is a live-window port; flow-rects runs on the sandbox only`);
  process.exit(2);
}

const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref()),
]);

let ws = null, nextId = 0;
const pending = new Map();

async function connect() {
  if (ws) return;
  const CDP = `http://127.0.0.1:${PORT}`;
  let targets;
  try { targets = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(CONNECT_MS) })).json(); }
  catch { throw new Error(`no DevTools on ${PORT}`); }
  const page = targets.find((t) => t.type === "page" && !/overlay/i.test(t.url) && !/overlay/i.test(t.title ?? ""));
  if (!page) throw new Error("no Vidar page target");
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await withTimeout(new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; }), CONNECT_MS, "DevTools websocket open");
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  };
  ws = sock;
}

async function evalJs(expression, ms = EVAL_MS) {
  await connect();
  const id = ++nextId;
  const r = await withTimeout(new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); }), ms, "Runtime.evaluate");
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

try { await gateRealInput({ PORT, evalJs }); }
catch (e) { console.error(e?.message ?? String(e)); process.exit(e?.exitCode ?? 2); }

// Page-side: measures Add (and the card close) and returns plain rects. `limit` null leaves #workbench alone;
// a number sets a temporary inline max-width and restores the original style attribute in finally.
const measureJs = (limit) => `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const hit = (el) => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); };
  const read = () => {
    const view = document.querySelector("#flow-view"), tb = document.querySelector("#toolbench");
    const add = document.querySelector(".flow-plus-btn"), close = document.querySelector(".flow-pop-close");
    const lastTab = [...document.querySelectorAll("#wb-tabs > *")].filter((e) => e.getBoundingClientRect().width > 0).pop();
    return {
      view: box(view), toolbench: box(tb), workbench: box(document.querySelector("#workbench")),
      add: box(add), addHit: add ? hit(add) : null,
      close: box(close), closeHit: close ? hit(close) : null,
      lastTab: box(lastTab),
    };
  };
  const wb = document.querySelector("#workbench");
  const limit = ${limit === null ? "null" : Number(limit)};
  if (limit === null || !wb) return read();
  const had = wb.getAttribute("style");
  try { wb.style.maxWidth = limit + "px"; void wb.offsetWidth; return read(); }
  finally { if (had === null) wb.removeAttribute("style"); else wb.setAttribute("style", had); }
})()`;

let failed = 0;
const f = (n) => (n == null ? "-" : n.toFixed(1));
const show = (name, b) => console.log(b ? `  ${name}: l ${f(b.l)} t ${f(b.t)} r ${f(b.r)} b ${f(b.b)} (${f(b.w)} x ${f(b.h)})` : `  ${name}: absent`);
const check = (ok, what) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };
const EPS = 0.5;

function checkBtn(label, b, hitOk, view, tb) {
  const inside = b.l >= view.l - EPS && b.r <= view.r + EPS && b.t >= view.t - EPS && b.b <= view.b + EPS;
  check(inside, `${label} inside #flow-view`);
  check(!tb || b.r <= tb.l + EPS, `${label} right edge at or left of #toolbench left`);
  check(hitOk === true, `${label} centre hit-tests inside the button`);
}

function report(title, m) {
  console.log(title);
  show("#flow-view", m.view); show("#workbench", m.workbench); show("#toolbench", m.toolbench);
  show(".flow-plus-btn", m.add); show(".flow-pop-close", m.close); show("#wb-tabs last tab", m.lastTab);
  if (m.lastTab && m.toolbench) console.log(`  info: last tab right ${f(m.lastTab.r)} vs #toolbench left ${f(m.toolbench.l)} (${m.lastTab.r <= m.toolbench.l + EPS ? "clear" : "overlaps"}, not a failure)`);
}

try {
  const m0 = await evalJs(measureJs(null));
  report("as found", m0);
  if (!m0.view || !m0.add) { console.error("Flow is not open (no #flow-view or .flow-plus-btn)"); process.exit(1); }
  checkBtn("Add", m0.add, m0.addHit, m0.view, m0.toolbench);
  if (m0.close) checkBtn("Card close", m0.close, m0.closeHit, m0.view, m0.toolbench);
  else console.log("  note: no card is open; .flow-pop-close check skipped");
  for (const w of SWEEP) {
    const m = await evalJs(measureJs(w));
    report(`#workbench max-width ${w}px`, m);
    if (!m.add || !m.view) { check(false, `Add present at ${w}px`); continue; }
    checkBtn(`Add at ${w}px`, m.add, m.addHit, m.view, m.toolbench);
  }
} catch (e) {
  console.error(e?.message ?? String(e));
  process.exit(1);
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
