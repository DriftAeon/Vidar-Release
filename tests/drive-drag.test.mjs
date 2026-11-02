// Explorer `drag` verb: registered, allowlisted, gated, refuses covered or no-press ends, and the CDP event sequence.
// jsdom page and fake ctx; no live port is ever opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { drag, DRAG_STEPS } from "../tools/drive/verbs/drag.mjs";
import { verbs } from "../tools/drive/verbs/index.mjs";
import { explorerRefusal } from "../tools/drive/drive-input.mjs";

const okDevCards = { preConnect: () => ({ ok: true, appRoot: "C:\\sbx\\app" }), attest: async () => ({ ok: true }) };
const badPre = { preConnect: () => ({ ok: false, reason: "port 9222 is a live-window port" }), attest: async () => ({ ok: true }) };

// jsdom has no layout: stub rects and elementFromPoint so centres are (10,20) and (110,60).
function page({ cover = false } = {}) {
  const dom = new JSDOM(`<body><button id="a">Out</button><button id="b">In</button><button id="q">Quit</button><div id="cv">x</div></body>`, { runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  const rect = { a: [0, 10, 20, 20], b: [100, 50, 20, 20], q: [200, 10, 20, 20] };
  for (const [id, [l, t, wd, h]] of Object.entries(rect)) {
    const el = d.getElementById(id);
    el.scrollIntoView = () => {};
    el.getBoundingClientRect = () => ({ left: l, top: t, width: wd, height: h });
  }
  d.elementFromPoint = (x) => (cover && x > 100 ? d.getElementById("cv") : d.getElementById(x < 50 ? "a" : x < 150 ? "b" : "q"));
  const sent = [];
  const ctx = (a1, a2, dc = okDevCards) => ({ a1, a2, PORT: "9333", loadDevCards: async () => dc,
    evalJs: async (src) => JSON.parse(JSON.stringify(w.eval(src) ?? null)),
    send: async (m, p) => { sent.push([m, p]); return {}; } });
  return { sent, ctx };
}

test("drag is registered and allowed in explorer mode", () => {
  assert.equal(typeof verbs.drag, "function");
  assert.equal(explorerRefusal("drag", { VIDAR_DRIVE_EXPLORER: "1" }, "9333"), null);
});

test("refuses without the sandbox gate and sends nothing", async () => {
  const { sent, ctx } = page();
  await assert.rejects(drag(ctx("#a", "#b", badPre)), (e) => e.exitCode === 2 && /attested sandbox/.test(e.message));
  assert.equal(sent.length, 0);
});

test("usage error without two targets", async () => {
  const { ctx } = page();
  await assert.rejects(drag(ctx("#a")), /usage: drag <from\|x,y> <to/);
});

test("builds press, stepped moves, release between the two centres", async () => {
  const { sent, ctx } = page();
  const out = await drag(ctx("#a", "#b"));
  assert.equal(out.dragged, true);
  const types = sent.map(([, p]) => p.type);
  assert.deepEqual(types, ["mouseMoved", "mousePressed", ...Array(DRAG_STEPS).fill("mouseMoved"), "mouseReleased"]);
  assert.ok(sent.every(([m]) => m === "Input.dispatchMouseEvent"));
  assert.deepEqual([sent[1][1].x, sent[1][1].y, sent[1][1].button], [10, 20, "left"]);
  const last = sent.at(-1)[1];
  assert.deepEqual([last.x, last.y, last.button], [110, 60, "left"]);
});

test("a covered end sends nothing", async () => {
  const { sent, ctx } = page({ cover: true });
  const out = await drag(ctx("#a", "#b"));
  assert.equal(out.dragged, false);
  assert.equal(out.to.ok, false);
  assert.equal(sent.length, 0);
});

test("a no-press end is refused", async () => {
  const { sent, ctx } = page();
  await assert.rejects(drag(ctx("#a", "#q")), (e) => e.exitCode === 2 && /no-press/.test(e.message));
  assert.equal(sent.length, 0);
});
