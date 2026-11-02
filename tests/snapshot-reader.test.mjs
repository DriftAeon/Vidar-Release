import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { validateSnapshot } from "../tools/drive/explorer-contracts.mjs";
import { snapshot, snapshotVerb } from "../tools/drive/verbs/snapshot.mjs";
import { resolveJs } from "../tools/drive/drive-input.mjs";
import {
  zeroSize, offViewport, clippedText, occluded, overlap, lowContrast, brokenImage, fgEqualsBg,
} from "../tools/drive/snapshot-reader.mjs";

function page(html = "<button>A</button><button>B</button>") {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: "outside-only" });
  dom.window.WeakRef = WeakRef;
  dom.window.document.elementFromPoint = () => null;
  dom.window.Element.prototype.scrollIntoView = () => {};
  // CDP returnByValue serializes page objects into the caller's realm.
  const ctx = { PORT: 9222, evalJs: async (expression) => JSON.parse(JSON.stringify(dom.window.eval(expression))) };
  return { dom, ctx, doc: dom.window.document };
}

test("snapshot: refs survive insertion before an existing node and locators update", async () => {
  const { ctx, doc } = page("<button>A</button><button>A</button>");
  const first = await snapshot(ctx);
  assert.deepEqual(validateSnapshot(first), []);
  const existing = doc.querySelectorAll("button")[1];
  const priorRef = first.nodes[1].ref;
  existing.before(doc.createElement("button"));
  existing.previousSibling.textContent = "A";
  const next = await snapshot(ctx);
  assert.equal(next.nodes.find((n) => n.ref === priorRef).locator.nth, 2);
  assert.equal(ctx.PORT, next.port);
  assert.equal(doc.defaultView.__vidarExplorer.byRef.get(priorRef).deref(), existing);
});

test("snapshot: names a control by its text before its title, title only when nothing else", async () => {
  const { ctx } = page(`<button title="Library">Extend Set</button><button title="Close"></button>`);
  const snap = await snapshot(ctx);
  assert.equal(snap.nodes[0].name, "Extend Set");
  assert.equal(snap.nodes[0].tip, "Library");
  assert.equal(snap.nodes[1].name, "Close");
  assert.equal(snap.nodes[1].tip, undefined);
});

test("snapshot: delta reports changes and removals", async () => {
  const { ctx, doc } = page();
  const first = await snapshot(ctx);
  doc.querySelector("button").textContent = "Changed";
  const change = await snapshot(ctx);
  assert.equal(change.full, true); // one of two nodes crosses the 40% threshold
  assert.equal(change.reason, "large");
  doc.querySelector("button").remove();
  const removal = await snapshot(ctx);
  assert.equal(removal.full, true);
  assert.equal(removal.reason, "large");
  assert.ok(first.nodes[0].ref !== removal.nodes[0].ref);
});

test("snapshot: small delta has changed nodes and removed refs", async () => {
  const { ctx, doc } = page("<button>A</button><button>B</button><button>C</button><button>D</button><button>E</button><button>F</button>");
  const first = await snapshot(ctx);
  doc.querySelectorAll("button")[0].textContent = "Changed";
  const changed = await snapshot(ctx);
  assert.equal(changed.full, false);
  assert.deepEqual(changed.nodes.map((n) => n.ref), [first.nodes[0].ref]);
  assert.deepEqual(changed.removed, []);
  doc.querySelectorAll("button")[1].remove();
  const removed = await snapshot(ctx);
  assert.equal(removed.full, false);
  assert.deepEqual(removed.removed, [first.nodes[1].ref]);
  assert.deepEqual(validateSnapshot(removed), []);
});

test("snapshot: asked full and reload carry reasons", async () => {
  const { ctx, dom } = page();
  await snapshot(ctx);
  assert.equal((await snapshotVerb({ ...ctx, a1: "--full" })).reason, "asked");
  dom.window.__vidarExplorer.timeOrigin = -1;
  assert.equal((await snapshot(ctx)).reason, "reload");
});

test("snapshot: off-viewport skips nodes a scroll container can reach", async () => {
  const { ctx, doc, dom } = page('<div id="list" style="overflow-y: auto"><button>Below Fold</button></div><button>Stranded</button>');
  const list = doc.getElementById("list");
  Object.defineProperty(list, "scrollHeight", { value: 500 });
  Object.defineProperty(list, "clientHeight", { value: 100 });
  const rect = { x: 10, y: 5000, w: 50, h: 20, width: 50, height: 20, left: 10, top: 5000 };
  dom.window.Element.prototype.getBoundingClientRect = function () { return rect; };
  const snap = await snapshot(ctx);
  const flags = (name) => snap.nodes.find((n) => n.name === name).flags;
  assert.ok(!flags("Below Fold").includes("off-viewport"));
  assert.ok(flags("Stranded").includes("off-viewport"));
});

test("snapshot: a control inside a closed details is absent, its summary stays, open shows it", async () => {
  const html = '<details id="g"><summary>Stock</summary><div><button>State</button></div></details>';
  const { ctx, doc } = page(html);
  const names = async () => (await snapshot(ctx)).nodes.map((n) => n.name);
  const closed = await names();
  assert.ok(closed.includes("Stock"));
  assert.ok(!closed.includes("State"));
  doc.getElementById("g").open = true;
  assert.ok((await names()).includes("State"));
});

const rebuild = (doc, html) => { doc.body.innerHTML = html; };

test("refs: a rebuilt control with data-keep keeps its ref, marked rebound, listed as changed", async () => {
  const { ctx, doc } = page('<div data-keep="vault:a"><button>Open</button></div><button>X1</button><button>X2</button><button>X3</button><button>X4</button><button>X5</button>');
  const first = await snapshot(ctx);
  const ref = first.nodes.find((n) => n.name === "Open").ref;
  doc.querySelector("[data-keep]").innerHTML = "<button>Open Now</button>";
  const next = await snapshot(ctx);
  const node = next.nodes.find((n) => n.ref === ref);
  assert.ok(node, "old ref reused");
  assert.equal(node.rebound, true);
  assert.equal(node.name, "Open Now");
  assert.ok(!(next.removed ?? []).includes(ref));
});

test("refs: a control replaced after the snapshot resolves through relocate with rebound", async () => {
  const { ctx, doc } = page('<div data-keep="lib:x"><button>Pick</button></div>');
  const ref = (await snapshot(ctx)).nodes[0].ref;
  doc.querySelector("[data-keep]").innerHTML = "<button>Pick</button>";
  const r = await ctx.evalJs(resolveJs(ref));
  assert.equal(r.found, true);
  assert.equal(r.hit.rebound, true);
  assert.equal(doc.defaultView.__vidarExplorer.byRef.get(ref).deref(), doc.querySelector("button"));
});

test("refs: a removed control stays stale", async () => {
  const { ctx, doc } = page('<div data-keep="lib:x"><button>Pick</button></div>');
  const ref = (await snapshot(ctx)).nodes[0].ref;
  doc.querySelector("[data-keep]").innerHTML = "";
  const r = await ctx.evalJs(resolveJs(ref));
  assert.deepEqual(r, { found: false, stale: true });
});

test("refs: state-named checkboxes without data-keep never land on another box", async () => {
  const box = '<input type="checkbox" aria-label="State: Off">';
  const { ctx, doc } = page(`${box}${box}`);
  const refs = (await snapshot(ctx)).nodes.map((n) => n.ref);
  rebuild(doc, `<input type="checkbox" aria-label="State: On">${box}`);
  for (const ref of refs) assert.deepEqual(await ctx.evalJs(resolveJs(ref)), { found: false, stale: true });
  const next = await snapshot(ctx);
  assert.ok(next.nodes.every((n) => !refs.includes(n.ref) && !n.rebound));
});

test("refs: state-named checkboxes with data-keep each rebind to their own box", async () => {
  const box = (k, s) => `<div data-keep="vault:${k}"><input type="checkbox" aria-label="State: ${s}"></div>`;
  const { ctx, doc } = page(`${box("a", "Off")}${box("b", "Off")}`);
  const [a, b] = (await snapshot(ctx)).nodes.map((n) => n.ref);
  rebuild(doc, `${box("a", "On")}${box("b", "Off")}`);
  const ra = await ctx.evalJs(resolveJs(a));
  const rb = await ctx.evalJs(resolveJs(b));
  assert.equal(ra.hit.rebound, true);
  assert.equal(rb.hit.rebound, true);
  const boxes = doc.querySelectorAll("input");
  const map = doc.defaultView.__vidarExplorer.byRef;
  assert.equal(map.get(a).deref(), boxes[0]);
  assert.equal(map.get(b).deref(), boxes[1]);
});

test("refs: a unique role+name button rebuilt without data-keep rebinds", async () => {
  const { ctx, doc } = page("<button>Done</button><button>Other</button>");
  const first = await snapshot(ctx);
  const ref = first.nodes.find((n) => n.name === "Done").ref;
  rebuild(doc, "<button>Done</button><button>Other</button>");
  const next = await snapshot(ctx);
  const done = next.nodes.find((n) => n.name === "Done");
  assert.equal(done.ref, ref);
  assert.equal(done.rebound, true);
});

test("snapshot: a pane head yields one heading node with its text, its button stays its own element", async () => {
  const { ctx, doc } = page('<div class="pane-head-card"><span class="runes-vault-name-text">Mixed Vault</span><button aria-label="Rename">Edit</button></div><button>A</button><button>B</button><button>C</button><button>D</button>');
  const snap = await snapshot(ctx);
  assert.deepEqual(validateSnapshot(snap), []);
  const heads = snap.nodes.filter((n) => n.role === "heading");
  assert.equal(heads.length, 1);
  assert.equal(heads[0].name, "Mixed Vault");
  assert.ok(snap.nodes.some((n) => n.role === "button" && n.name === "Rename"));
  doc.querySelector(".runes-vault-name-text").textContent = "Renamed Vault";
  const next = await snapshot(ctx);
  assert.equal(next.full, false);
  assert.deepEqual(next.nodes.map((n) => n.name), ["Renamed Vault"]);
});

test("flags: zero-size true and false", () => {
  assert.equal(zeroSize({ w: 0, h: 10 }), true);
  assert.equal(zeroSize({ w: 1, h: 1 }), false);
});
test("flags: off-viewport true and false", () => {
  assert.equal(offViewport({ x: 100, y: 0, w: 10, h: 10 }, { w: 100, h: 100 }), true);
  assert.equal(offViewport({ x: 99, y: 0, w: 10, h: 10 }, { w: 100, h: 100 }), false);
});
test("flags: clipped-text true and false", () => {
  assert.equal(clippedText(103, 100, "hidden"), true);
  assert.equal(clippedText(103, 100, "visible"), false);
});
test("flags: occluded true and false", () => {
  assert.equal(occluded(false), true);
  assert.equal(occluded(true), false);
});
function sized(dom, cover) {
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { x: 10.4, y: 10.6, left: 10.4, top: 10.6, width: 100.2, height: 20 };
  };
  dom.window.innerWidth = 800; dom.window.innerHeight = 600;
  dom.window.document.elementFromPoint = () => cover;
}

test("snapshot: an occluded node reports its cover", async () => {
  const { dom, ctx, doc } = page('<div id="bar" class="sticky-bar top-nav extra-long-class-name-extra-long-class-name-extra-long-class-name" role="toolbar" aria-label="Top" style="position: sticky"></div><button>Under</button>');
  sized(dom, doc.getElementById("bar"));
  const snap = await snapshot(ctx);
  assert.deepEqual(validateSnapshot(snap), []);
  const node = snap.nodes.find((n) => n.name === "Under");
  assert.ok(node.flags.includes("occluded"));
  assert.equal(node.cover.tag, "div");
  assert.equal(node.cover.role, "toolbar");
  assert.equal(node.cover.name, "Top");
  assert.ok(node.cover.cls.startsWith("sticky-bar top-nav") && node.cover.cls.length === 60);
  assert.deepEqual(node.cover.bbox, { x: 10, y: 11, w: 100, h: 20 });
  assert.equal(node.cover.relation, "ancestor-sibling");
});

test("snapshot: an unpositioned cover is relation other", async () => {
  const { dom, ctx, doc } = page('<div id="bar"></div><button>Under</button>');
  sized(dom, doc.getElementById("bar"));
  const snap = await snapshot(ctx);
  assert.equal(snap.nodes[0].cover.relation, "other");
});

test("snapshot: a non-occluded node has no cover", async () => {
  const { dom, ctx, doc } = page("<button>Free</button>");
  sized(dom, doc.querySelector("button"));
  const snap = await snapshot(ctx);
  assert.ok(!snap.nodes[0].flags.includes("occluded"));
  assert.ok(!("cover" in snap.nodes[0]));
});

function fold(dom, rects, hitFor) {
  dom.window.Element.prototype.getBoundingClientRect = function () {
    const r = rects[this.id] ?? rects[this.tagName.toLowerCase()] ?? { x: 0, y: 0, w: 0, h: 0 };
    return { x: r.x, y: r.y, left: r.x, top: r.y, width: r.w, height: r.h };
  };
  dom.window.innerWidth = 800; dom.window.innerHeight = 1000;
  dom.window.document.elementFromPoint = hitFor;
}

test("snapshot: a node below a scroll fold is not occluded by the backdrop behind", async () => {
  const { dom, ctx, doc } = page('<div id="backdrop" style="position: fixed"></div><div id="panel" style="overflow-y: auto"><button>Row</button></div>');
  const panel = doc.getElementById("panel");
  Object.defineProperty(panel, "scrollHeight", { value: 900 });
  Object.defineProperty(panel, "clientHeight", { value: 300 });
  fold(dom, { panel: { x: 0, y: 0, w: 400, h: 300 }, button: { x: 10, y: 600, w: 100, h: 20 } }, () => doc.getElementById("backdrop"));
  const node = (await snapshot(ctx)).nodes.find((n) => n.name === "Row");
  assert.ok(!node.flags.includes("occluded"));
  assert.ok(!("cover" in node));
});

test("snapshot: a node inside the container's visible rect is still occluded", async () => {
  const { dom, ctx, doc } = page('<div id="panel" style="overflow-y: auto"><div id="bar" style="position: absolute"></div><button>Row</button></div>');
  const panel = doc.getElementById("panel");
  Object.defineProperty(panel, "scrollHeight", { value: 900 });
  Object.defineProperty(panel, "clientHeight", { value: 300 });
  fold(dom, { panel: { x: 0, y: 0, w: 400, h: 300 }, bar: { x: 0, y: 0, w: 400, h: 50 }, button: { x: 10, y: 20, w: 100, h: 20 } }, () => doc.getElementById("bar"));
  const node = (await snapshot(ctx)).nodes.find((n) => n.name === "Row");
  assert.ok(node.flags.includes("occluded"));
  assert.equal(node.cover.relation, "ancestor-sibling");
});

test("snapshot: a node clipped by a non-scrolling ancestor stays flagged", async () => {
  const { dom, ctx, doc } = page('<div id="backdrop" style="position: fixed"></div><div id="panel" style="overflow: hidden"><button>Row</button></div>');
  const panel = doc.getElementById("panel");
  Object.defineProperty(panel, "scrollHeight", { value: 300 });
  Object.defineProperty(panel, "clientHeight", { value: 300 });
  fold(dom, { panel: { x: 0, y: 0, w: 400, h: 300 }, button: { x: 10, y: 600, w: 100, h: 20 } }, () => doc.getElementById("backdrop"));
  const node = (await snapshot(ctx)).nodes.find((n) => n.name === "Row");
  assert.ok(node.flags.includes("occluded"));
});

test("flags: overlap true and false", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(overlap(a, { x: 5, y: 0, w: 10, h: 10 }), true);
  assert.equal(overlap(a, { x: 9, y: 0, w: 10, h: 10 }), false);
});
test("flags: low-contrast true and false", () => {
  assert.equal(lowContrast("rgb(80, 80, 80)", "rgb(90, 90, 90)"), true);
  assert.equal(lowContrast("rgb(0, 0, 0)", "rgb(255, 255, 255)"), false);
});
test("flags: broken-image true and false", () => {
  assert.equal(brokenImage(true, 0), true);
  assert.equal(brokenImage(false, 0), false);
});
test("flags: fg-equals-bg true and false", () => {
  assert.equal(fgEqualsBg("#ffffff", "rgb(255, 255, 255)"), true);
  assert.equal(fgEqualsBg("#000000", "#ffffff"), false);
});
