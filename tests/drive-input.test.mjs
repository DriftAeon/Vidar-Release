// Explorer hands: gate, no-press list, key combos, hit report, allowlist, run log, turn cap.
// Fake CDP session objects throughout; no live port is ever opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_PRESS, matchNoPress, parseCombo, gateRealInput, pressTarget, pressKey, drainExternal, explorerRefusal, takeTurn } from "../tools/drive/drive-input.mjs";
import { appendRunLog, logVerb } from "../tools/drive/run-log.mjs";
import { act } from "../tools/drive/verbs/act.mjs";

const okDevCards = { preConnect: () => ({ ok: true, appRoot: "C:\\sbx\\app" }), attest: async () => ({ ok: true }) };
const badPre = { preConnect: () => ({ ok: false, reason: "port 9222 is a live-window port" }), attest: async () => ({ ok: true }) };
const badAttest = { preConnect: okDevCards.preConnect, attest: async () => ({ ok: false, reason: "wrong root" }) };

function fakeCtx(page, devCards = okDevCards) {
  const sent = [];
  return { sent, PORT: "9333", loadDevCards: async () => devCards, evalJs: async () => page, send: async (m, p) => { sent.push([m, p]); return {}; } };
}
const found = (over = {}) => ({ found: true, at: { x: 10, y: 20 }, role: "button", name: "Open", cls: "", inCaption: false, inRelay: false,
  hit: { ok: true, at: { x: 10, y: 20 }, got: { role: "button", name: "Open", cls: "" } }, ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "drive-input-"));

test("gate refuses an unattested window with exit 2", async () => {
  for (const dc of [badPre, badAttest]) {
    await assert.rejects(gateRealInput(fakeCtx(found(), dc)), (e) => e.exitCode === 2 && /^refused: real input needs the attested sandbox/.test(e.message));
  }
  await assert.rejects(pressKey(fakeCtx(null, badPre), "Enter"), (e) => e.exitCode === 2);
});

test("gate allows an attested window and press dispatches", async () => {
  const ctx = fakeCtx(found());
  const r = await pressTarget(ctx, "#open");
  assert.equal(r.pressed, true);
  assert.deepEqual(ctx.sent.map(([, p]) => p.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.deepEqual([ctx.sent[1][1].x, ctx.sent[1][1].y], [10, 20]);
});

// Fake page shaped like the real one: invoke is non-writable and goes through window.fetch at call time.
async function fakePage() {
  const { JSDOM } = await import("jsdom");
  const w = new JSDOM("<body></body>", { runScripts: "outside-only" }).window;
  const real = [];
  const baseFetch = async (url) => { real.push(String(url)); return new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } }); };
  w.Response = Response;
  w.fetch = baseFetch;
  const ti = {};
  Object.defineProperty(ti, "invoke", {
    writable: false, configurable: false,
    value: async (cmd, args) => {
      const res = await w.fetch("http://ipc.localhost/" + cmd, { method: "POST", body: JSON.stringify(args ?? {}) });
      const text = await res.text();
      if (res.headers.get("Tauri-Response") !== "ok" && res.status >= 400) throw new Error(text);
      return text;
    },
  });
  w.__TAURI_INTERNALS__ = ti;
  const ctx = { ...fakeCtx(null), evalJs: async (e) => JSON.parse(JSON.stringify((await w.eval(e)) ?? null)) };
  return { w, real, ctx, baseFetch };
}

test("external guard blocks open_url, passes build_stamp, installs once, drains", async () => {
  const { w, real, ctx } = await fakePage();
  await gateRealInput(ctx);
  const wrapped = w.fetch;
  await gateRealInput(ctx);
  assert.equal(w.fetch, wrapped, "second gate does not wrap again");
  await assert.rejects(w.__TAURI_INTERNALS__.invoke("open_url", { url: "x".repeat(300) }), /blocked by sandbox driver: open_url/);
  assert.equal(await w.__TAURI_INTERNALS__.invoke("build_stamp"), "ok");
  assert.deepEqual(real, ["http://ipc.localhost/build_stamp"], "open_url never reached the real fetch");
  const got = await drainExternal(ctx);
  assert.equal(got.length, 1);
  assert.equal(got[0].cmd, "open_url");
  assert.equal(got[0].args.length, 200);
  assert.deepEqual(await drainExternal(ctx), []);
  for (const cmd of ["update_cli", "release_build_start", "swap_start", "falcon_show"]) {
    await assert.rejects(w.__TAURI_INTERNALS__.invoke(cmd), /blocked/);
  }
  assert.equal(real.length, 1);
  w.fetch = async (u) => { real.push(String(u)); return new Response("ok"); }; // fetch replaced: the next gate reinstalls
  await gateRealInput(ctx);
  assert.notEqual(w.fetch, wrapped);
  await assert.rejects(w.__TAURI_INTERNALS__.invoke("pick_folder"), /blocked/);
  const w2 = await w.eval("fetch");
  assert.equal(await (await w2("ipc://localhost/open_folder")).text(), "blocked by sandbox driver: open_folder");
});

test("gate refusal installs no guard", async () => {
  const { w, ctx, baseFetch } = await fakePage();
  const refused = { ...ctx, loadDevCards: async () => badPre };
  await assert.rejects(gateRealInput(refused), (e) => e.exitCode === 2);
  assert.equal(w.fetch, baseFetch);
  assert.equal(w.__vidarExternalGuard, undefined);
});

test("no-press: the shared decision pair is pressable, the real swap UI is not", () => {
  // Runes / Flow / Settings confirms: swap-yes and swap-no outside the swap container
  for (const [name, cls] of [["Delete", "swap-yes"], ["Cancel", "swap-no"], ["Trust", "swap-yes vs-trust-confirm"], ["Cancel", "swap-no vs-trust-cancel"]]) {
    assert.equal(matchNoPress({ role: "button", name, cls, inSwapUi: false }), null, `${name} ${cls}`);
  }
  // The title bar's swap confirm reuses the pair: Yes starts a swap, so it stays refused by container
  assert.ok(matchNoPress({ role: "button", name: "Yes", cls: "swap-yes", inSwapUi: true }));
  assert.ok(matchNoPress({ role: "button", name: "No", cls: "swap-no", inSwapUi: true }));
  // swap button (name "Swap Vidar", its spinner), RMB menu row, and bare class tokens
  assert.ok(matchNoPress({ role: "button", name: "Swap Vidar", cls: "" }));
  assert.ok(matchNoPress({ role: "span", name: "", cls: "swap-spin", inSwapUi: true }));
  assert.ok(matchNoPress({ role: "menuitemcheckbox", name: "Confirmation Panel", cls: "on", inSwapUi: true }));
  for (const cls of ["swap", "restart", "quit", "x quit"]) assert.ok(matchNoPress({ role: "button", name: "X", cls }), cls);
});

test("no-press matchers refuse each protected control", async () => {
  const cases = [
    { role: "button", name: "Close", inCaption: true }, { role: "button", name: "Minimize", inCaption: true }, { role: "button", name: "Maximise", inCaption: true },
    { role: "button", name: "Close window" }, { role: "button", name: "Quit" }, { role: "menuitem", name: "Restart Vidar" },
    { role: "button", name: "Swap to new build" }, { role: "button", name: "Approve", cls: "relay-approve" },
    { role: "button", name: "Deny", cls: "relay-deny" }, { role: "button", name: "Approve", inRelay: true },
  ];
  for (const d of cases) assert.ok(matchNoPress(d), JSON.stringify(d));
  assert.ok(NO_PRESS.length >= 6);
  assert.equal(matchNoPress({ role: "button", name: "Close", inCaption: false }), null); // a dialog's Close is fine
  assert.equal(matchNoPress({ role: "button", name: "Approve", inRelay: false, cls: "card-btn" }), null);
  const ctx = fakeCtx(found({ name: "Quit" }));
  await assert.rejects(pressTarget(ctx, "#q"), (e) => e.exitCode === 2 && /no-press/.test(e.message));
  assert.equal(ctx.sent.length, 0);
});

test("key combos parse and a focused no-press control blocks Enter", async () => {
  assert.deepEqual(parseCombo("Enter"), { key: "Enter", code: "Enter", vk: 13, modifiers: 0, text: "\r" });
  assert.equal(parseCombo("Ctrl+K").modifiers, 2);
  assert.equal(parseCombo("Ctrl+K").text, undefined);
  assert.equal(parseCombo("Ctrl+K").code, "KeyK");
  assert.deepEqual([parseCombo("Shift+Tab").modifiers, parseCombo("Shift+Tab").key], [8, "Tab"]);
  assert.deepEqual([parseCombo("Alt+ArrowDown").modifiers, parseCombo("Alt+ArrowDown").vk], [1, 40]);
  assert.equal(parseCombo("Ctrl+Shift+p").modifiers, 10);
  assert.throws(() => parseCombo("Hyper+K"), /unknown modifier/);
  assert.throws(() => parseCombo("Ctrl+Bogus"), /unknown key/);
  const ctx = fakeCtx({ role: "button", name: "Quit", cls: "" });
  await assert.rejects(pressKey(ctx, "Enter"), (e) => e.exitCode === 2);
  const ok = fakeCtx({ role: "textbox", name: "Search", cls: "" });
  const r = await pressKey(ok, "Ctrl+K");
  assert.deepEqual(r.focus, { role: "textbox", name: "Search" });
  assert.deepEqual(ok.sent.map(([, p]) => p.type), ["rawKeyDown", "keyUp"]);
});

test("hit report on a miss: ok false, nothing dispatched", async () => {
  const ctx = fakeCtx(found({ hit: { ok: false, at: { x: 10, y: 20 }, got: { role: "dialog", name: "Overlay", cls: "" } } }));
  const r = await pressTarget(ctx, "#open");
  assert.equal(r.hit.ok, false);
  assert.deepEqual(r.hit.got, { role: "dialog", name: "Overlay" });
  assert.equal(r.pressed, false);
  assert.equal(ctx.sent.length, 0);
});

test("a stale ref exits 2", async () => {
  await assert.rejects(pressTarget(fakeCtx({ found: false, stale: true }), "e7"), (e) => e.exitCode === 2 && /stale ref/.test(e.message));
});

test("explorer mode allowlist refuses eval and passes the listed verbs", () => {
  const env = { VIDAR_DRIVE_EXPLORER: "1" };
  for (const v of ["eval", "click", "invoke", "card", "answer", "text"]) assert.equal(explorerRefusal(v, env, "9333"), `refused in explorer mode: ${v}`);
  for (const v of ["state", "snapshot", "read", "act", "press", "key", "paste", "shot", "look", "console"]) assert.equal(explorerRefusal(v, env, "9333"), null);
  assert.equal(explorerRefusal("eval", {}, "9333"), null);
});

test("run log: valid line written, none without the env var", () => {
  const dir = tmp();
  const env = { VIDAR_EXPLORER_RUN: dir, VIDAR_EXPLORER_EPISODE: "ep3" };
  logVerb(env, "press", "9333", ["e4"], { target: { ref: "e4", locator: { role: "button", name: "Open", nth: 0 } }, hit: { ok: true, got: { role: "button", name: "Open" } } }, 0);
  logVerb(env, "eval", "9333", ["1"], undefined, 0); // not an input verb
  const lines = fs.readFileSync(path.join(dir, "run-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].verb, lines[0].episode, lines[0].exit, lines[0].hit], ["press", "ep3", 0, { ok: true, tag: "button" }]);
  assert.throws(() => appendRunLog(env, { port: "9333", verb: "press", target: { ref: "bad", locator: {} } }), /invalid/);
  const off = tmp();
  assert.equal(appendRunLog({}, { port: "9333", verb: "press" }), null);
  logVerb({}, "press", "9333", ["e4"], {}, 0);
  assert.equal(fs.existsSync(path.join(off, "run-log.jsonl")), false);
});

test("turn cap refuses the send past N, per port", () => {
  const dir = tmp();
  const env = { VIDAR_DRIVE_TURNS: "2", VIDAR_EXPLORER_RUN: dir };
  assert.equal(explorerRefusal("send", env, "9333"), null);
  assert.equal(takeTurn(env, "9333"), null);
  assert.equal(explorerRefusal("send", env, "9333"), "refused: turn cap 2 reached");
  assert.equal(takeTurn(env, "9444"), null); // another port has its own count
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state", "turns-9333.json"), "utf8")).sends, 2);
  assert.equal(explorerRefusal("send", {}, "9333"), null); // cap unset
});

test("act press returns hit, delta and only new console errors", async () => {
  const dir = tmp();
  const env = { VIDAR_EXPLORER_RUN: dir };
  const js = [];
  const ctx = { ...fakeCtx(null), env, flags: {}, a1: "press", a2: "#open", events: [],
    evalJs: async (src) => { js.push(src); return /found/.test(src) && /elementFromPoint/.test(src) ? found() : true; },
    snapshotFn: async () => ({ v: 1, full: false, nodes: [] }),
    consoleVerb: async () => ({ messages: [{ level: "error", text: "old" }, { level: "warning", text: "w" }, { level: "error", text: "new" }] }) };
  const first = await act(ctx);
  assert.equal(first.hit.ok, true);
  assert.deepEqual(first.delta, { v: 1, full: false, nodes: [] });
  assert.equal(first.console.length, 2);
  const second = await act({ ...ctx, consoleVerb: async () => ({ messages: [{ level: "error", text: "old" }, { level: "error", text: "new" }, { level: "error", text: "newer" }] }) });
  assert.deepEqual(second.console.map((m) => m.text), ["newer"]);
});

test("act send counts against the turn cap", async () => {
  const dir = tmp();
  const env = { VIDAR_EXPLORER_RUN: dir, VIDAR_DRIVE_TURNS: "1" };
  const ctx = { ...fakeCtx(null), env, flags: {}, a1: "send", a2: "tab1", cardOpts: "hi", events: [], q: JSON.stringify,
    evalJs: async () => true, snapshotFn: async () => ({}), consoleVerb: async () => ({ messages: [] }) };
  await act(ctx);
  await assert.rejects(act(ctx), (e) => e.exitCode === 2 && /turn cap 1 reached/.test(e.message));
});
