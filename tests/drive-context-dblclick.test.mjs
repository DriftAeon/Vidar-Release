// context (right-click) and dblclick: CDP event sequences, registry, explorer allowlist, run log, usage errors.
// Fake CDP session objects only; no live port is opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verbs } from "../tools/drive/verbs/index.mjs";
import { context, dblclick } from "../tools/drive/verbs/press.mjs";
import { explorerRefusal } from "../tools/drive/drive-input.mjs";
import { logVerb, INPUT_VERBS } from "../tools/drive/run-log.mjs";

const okDevCards = { preConnect: () => ({ ok: true, appRoot: "C:\\sbx\\app" }), attest: async () => ({ ok: true }) };
const found = (over = {}) => ({ found: true, at: { x: 10, y: 20 }, role: "tab", name: "Claude", cls: "", inCaption: false, inRelay: false,
  hit: { ok: true, at: { x: 10, y: 20 }, got: { role: "tab", name: "Claude", cls: "" } }, ...over });

function ctxFor(a1, page = found()) {
  const sent = [];
  const evalJs = async (e) => (String(e).includes("__vidarExternalGuard") && String(e).includes("splice") ? [] : page);
  return { sent, a1, PORT: "9333", loadDevCards: async () => okDevCards, evalJs, send: async (m, p) => { sent.push([m, p]); return {}; } };
}
const mouse = (sent) => sent.map(([, p]) => [p.type, p.button, p.buttons, p.clickCount]);

test("context sends a right-button press and release at the centre", async () => {
  const ctx = ctxFor("#tab");
  const r = await context(ctx);
  assert.equal(r.pressed, true);
  assert.deepEqual(mouse(ctx.sent), [
    ["mouseMoved", undefined, undefined, undefined],
    ["mousePressed", "right", 2, 1],
    ["mouseReleased", "right", 0, 1],
  ]);
  assert.deepEqual([ctx.sent[1][1].x, ctx.sent[1][1].y], [10, 20]);
});

test("dblclick sends clickCount 1 then 2 press/release pairs on the left button", async () => {
  const ctx = ctxFor("#tab");
  const r = await dblclick(ctx);
  assert.equal(r.pressed, true);
  assert.deepEqual(mouse(ctx.sent), [
    ["mouseMoved", undefined, undefined, undefined],
    ["mousePressed", "left", 1, 1],
    ["mouseReleased", "left", 0, 1],
    ["mousePressed", "left", 1, 2],
    ["mouseReleased", "left", 0, 2],
  ]);
});

test("a covered target sends nothing", async () => {
  const miss = found({ hit: { ok: false, at: { x: 10, y: 20 }, got: { role: "div", name: "", cls: "" } } });
  for (const verb of [context, dblclick]) {
    const ctx = ctxFor("#tab", miss);
    const r = await verb(ctx);
    assert.equal(r.pressed, false);
    assert.equal(ctx.sent.length, 0);
  }
});

test("a missing target is a usage error and sends nothing", async () => {
  for (const [verb, name] of [[context, "context"], [dblclick, "dblclick"]]) {
    const ctx = ctxFor(undefined);
    await assert.rejects(verb(ctx), (e) => e.message === `usage: ${name} <ref|selector>`);
    assert.equal(ctx.sent.length, 0);
  }
});

test("a no-press target is refused for both", async () => {
  for (const verb of [context, dblclick]) {
    const ctx = ctxFor("#q", found({ role: "button", name: "Quit" }));
    await assert.rejects(verb(ctx), (e) => e.exitCode === 2 && /no-press/.test(e.message));
    assert.equal(ctx.sent.length, 0);
  }
});

test("both are registered, allowed in explorer mode and logged as input verbs", () => {
  for (const v of ["context", "dblclick"]) {
    assert.equal(typeof verbs[v], "function");
    assert.equal(explorerRefusal(v, { VIDAR_DRIVE_EXPLORER: "1" }, "9333"), null);
    assert.ok(INPUT_VERBS.includes(v));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-ctx-"));
  const env = { VIDAR_EXPLORER_RUN: dir, VIDAR_EXPLORER_EPISODE: "1" };
  const out = { hit: { ok: true, got: { role: "tab" } }, target: { ref: "e4", locator: { role: "tab", name: "Claude", nth: 0 } } };
  logVerb(env, "context", "9333", ["e4", undefined], out, 0);
  logVerb(env, "dblclick", "9333", ["e4", undefined], out, 0);
  const lines = fs.readFileSync(path.join(dir, "run-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.verb), ["context", "dblclick"]);
});
