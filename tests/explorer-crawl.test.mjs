// Explorer crawl: fake CDP session over a jsdom page. No live port is ever opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { crawl, skipReason, SKIP_NAMES } from "../tools/explorer/crawl.mjs";
import { installExternalGuard } from "../tools/drive/drive-input.mjs";
import { auditRun } from "../tools/explorer/report-audit.mjs";

const html = fs.readFileSync(new URL("./fixtures/explorer-crawl/app.html", import.meta.url), "utf8");
const okDevCards = { preConnect: () => ({ ok: true, appRoot: "C:\\sbx\\app" }), attest: async () => ({ ok: true }) };
const badDevCards = { preConnect: () => ({ ok: false, reason: "port 9222 is a live-window port" }), attest: async () => ({ ok: true }) };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "explorer-crawl-"));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function fixture(devCards = okDevCards) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window, doc = w.document;
  w.WeakRef = WeakRef;
  w.Element.prototype.scrollIntoView = () => {};
  const hidden = (el) => { for (let p = el; p; p = p.parentElement) if (p.hasAttribute("hidden")) return true; return false; };
  const rectOf = (el) => {
    const i = [...doc.body.querySelectorAll("*")].indexOf(el);
    return { x: 10, y: 10 + 20 * i, left: 10, top: 10 + 20 * i, width: el.classList.contains("squeezed") ? 0 : 100, height: 16 };
  };
  w.Element.prototype.getBoundingClientRect = function () { return rectOf(this); };
  doc.elementFromPoint = (x, y) => [...doc.body.querySelectorAll("*")].reverse()
    .find((el) => !hidden(el) && x >= 10 && x <= 110 && y >= rectOf(el).y && y <= rectOf(el).y + 16) ?? null;
  const sent = [];
  const ctx = {
    PORT: "9333", loadDevCards: async () => devCards, flags: { settle: "5" },
    evalJs: async (e) => JSON.parse(JSON.stringify((await w.eval(e)) ?? null)),
    consoleVerb: async () => ({ messages: w.__log.map((text) => ({ level: "error", text })) }),
    send: async (m, p) => {
      sent.push([m, p]);
      if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed") doc.elementFromPoint(p.x, p.y)?.click();
      if (m === "Input.dispatchKeyEvent" && p.key === "Escape" && p.type !== "keyUp") doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return {};
    },
  };
  return { w, ctx, sent };
}
const count = (arr, v) => arr.filter((x) => x === v).length;

test("gate refuses an unattested window and writes nothing", async () => {
  const run = tmp();
  const { ctx, sent } = fixture(badDevCards);
  await assert.rejects(crawl(ctx, { run }), (e) => e.exitCode === 2 && /attested sandbox/.test(e.message));
  assert.equal(sent.length, 0);
  assert.deepEqual(lines(path.join(run, "run-log.jsonl")), []);
});

test("skip-list names are never pressed; the rest are visited once", async () => {
  const { w, ctx } = fixture();
  const sum = await crawl(ctx, { run: tmp() });
  for (const id of ["send", "quit", "m-delete"]) assert.equal(count(w.__clicks, id), 0, id);
  for (const id of ["t-home", "t-settings", "m-recent", "m-prefs", "boom"]) assert.equal(count(w.__clicks, id), 1, id);
  assert.equal(sum.visited, 6); // 5 above + File Menu
  assert.ok(sum.skipped["skip-list"] >= 2 && sum.skipped["no-press"] >= 1, JSON.stringify(sum.skipped));
  assert.ok(SKIP_NAMES.test("Sign in") && !SKIP_NAMES.test("Settings"));
  assert.equal(skipReason({ role: "button", name: "Quit", state: { enabled: true } }), "no-press");
});

test("Hide and disable toggles are skip-list targets", () => {
  assert.equal(skipReason({ role: "button", name: "Hide Claude From The Launcher", state: { enabled: true } }), "skip-list");
  assert.equal(skipReason({ role: "button", name: "Disable Module", state: { enabled: true } }), "skip-list");
});

test("Escape closes a menu and a closed parent is pressed again", async () => {
  const run = tmp();
  const { w, ctx, sent } = fixture();
  await crawl(ctx, { run });
  assert.ok(sent.some(([m, p]) => m === "Input.dispatchKeyEvent" && p.key === "Escape"));
  // Open Recent closes the menu itself, so Preferences is only reachable after File Menu is re-pressed.
  assert.ok(count(w.__clicks, "file") >= 2, `file clicks: ${w.__clicks}`);
  assert.ok(w.__clicks.indexOf("m-prefs") > w.__clicks.indexOf("m-recent"));
  const log = lines(path.join(run, "run-log.jsonl"));
  assert.ok(log.every((l) => l.verb === "act" && l.episode === "crawl"));
  assert.ok(log.some((l) => l.args[0] === "key" && l.args[1] === "Escape"));
});

test("findings are validated, grouped per flag and locator, and carry the console error", async () => {
  const run = tmp();
  const { ctx } = fixture();
  const sum = await crawl(ctx, { run });
  const f = lines(path.join(run, "findings.jsonl"));
  assert.ok(f.every((x) => x.goal === "crawl" && x.episode === "crawl" && x.kind === "fail"));
  const observed = f.map((x) => x.observed);
  assert.equal(new Set(observed).size, observed.length, "one finding per (flag, locator)");
  assert.equal(count(observed, 'zero-size: button "Cramped Link"'), 1);
  assert.ok(f.some((x) => x.observed === "boom: widget failed" && x.intent === "open More Options"));
  assert.equal(sum.findings.fail, f.length);
});

test("an overlay over a pre-existing control is not reported; a new zero-size control still is", async () => {
  const run = tmp();
  const { w, ctx } = fixture();
  const doc = w.document;
  const orig = doc.elementFromPoint;
  doc.addEventListener("click", (e) => { if (e.target.id === "t-settings") w.__cover = true; });
  // Once Settings opens, a veil sits over the existing Send button.
  doc.elementFromPoint = (x, y) => { const h = orig(x, y); return w.__cover && h?.id === "send" ? doc.getElementById("panel") : h; };
  await crawl(ctx, { run });
  const observed = lines(path.join(run, "findings.jsonl")).map((x) => x.observed);
  assert.ok(!observed.some((o) => /occluded/.test(o)), observed.join("; "));
  assert.equal(count(observed, 'zero-size: button "Cramped Link"'), 1);
});

test("an occluded finding names what covers the control", async () => {
  const run = tmp();
  const { w, ctx } = fixture();
  const doc = w.document;
  const menu = doc.getElementById("menu");
  menu.className = "veil extra";
  menu.style.position = "sticky";
  const orig = doc.elementFromPoint;
  // The menu container itself answers for its Preferences item.
  doc.elementFromPoint = (x, y) => { const h = orig(x, y); return h?.id === "m-prefs" ? menu : h; };
  await crawl(ctx, { run });
  const observed = lines(path.join(run, "findings.jsonl")).map((x) => x.observed);
  assert.ok(observed.includes('occluded: menuitem "Preferences" under div.veil "File" (ancestor-sibling)'), observed.join("; "));
});

test("a press that calls open_url is blocked and recorded as a detour", async () => {
  const run = tmp();
  const { w, ctx } = fixture();
  const real = [];
  w.Response = Response;
  w.fetch = async (url) => { real.push(String(url)); return new Response("ok"); };
  const ti = {};
  Object.defineProperty(ti, "invoke", { writable: false, configurable: false,
    value: async (cmd, args) => { const r = await w.fetch("http://ipc.localhost/" + cmd, { method: "POST", body: JSON.stringify(args ?? {}) }); if (r.status >= 400) throw new Error(await r.text()); return null; } });
  w.__TAURI_INTERNALS__ = ti;
  const b = w.document.createElement("button");
  b.id = "rel"; b.textContent = "Open Releases"; b.setAttribute("aria-expanded", "false");
  b.onclick = () => { w.__TAURI_INTERNALS__.invoke("open_url", { url: "https://example.test/rel" }).catch(() => {}); };
  w.document.body.appendChild(b);
  await crawl(ctx, { run });
  assert.deepEqual(real, []);
  const f = lines(path.join(run, "findings.jsonl")).filter((x) => x.kind === "detour");
  assert.equal(f.length, 1);
  assert.equal(f[0].observed, '"Open Releases" opens open_url {"url":"https://example.test/rel"}');
  assert.equal(f[0].expected, "stays in the app");
});

test("a call blocked before the crawl is not a detour on its first press", async () => {
  const run = tmp();
  const { w, ctx } = fixture();
  const real = [];
  w.Response = Response;
  w.fetch = async (url) => { real.push(String(url)); return new Response("ok"); };
  const ti = {};
  Object.defineProperty(ti, "invoke", { writable: false, configurable: false,
    value: async (cmd, args) => { const r = await w.fetch("http://ipc.localhost/" + cmd, { method: "POST", body: JSON.stringify(args ?? {}) }); if (r.status >= 400) throw new Error(await r.text()); return null; } });
  w.__TAURI_INTERNALS__ = ti;
  await installExternalGuard(ctx);
  await ti.invoke("open_url", { url: "https://example.test/before" }).catch(() => {});
  assert.equal(w.__vidarExternalGuard.blocked.length, 1);
  await crawl(ctx, { run });
  assert.deepEqual(real, []);
  assert.deepEqual(lines(path.join(run, "findings.jsonl")).filter((x) => x.kind === "detour"), []);
});

test("--max stops the crawl", async () => {
  const { w, ctx } = fixture();
  const sum = await crawl(ctx, { run: tmp(), max: 2 });
  assert.equal(sum.pressed, 2);
  assert.equal(w.__clicks.length, 2);
});

test("audit of a crawl run", async () => {
  const run = tmp();
  await crawl(fixture().ctx, { run });
  const problems = await auditRun(run);
  assert.deepEqual(problems, []);
});
