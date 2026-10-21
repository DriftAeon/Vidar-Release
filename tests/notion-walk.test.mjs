// Notion block walk (src/notion/walk.ts through blocks.ts renderDoc): alive() false stops requests, each cap
// (60 requests counting the first page, depth 6 below the page, 3000 blocks) stops the walk with the cut
// note, toggles load only when opened, a synced cycle terminates, and the first error stops the walk with
// its line (and a root note when work was still queued).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { renderDoc } = await import("../src/notion/blocks.ts");
const { MAX_REQUESTS, MAX_DEPTH, MAX_BLOCKS } = await import("../src/notion/walk.ts");

const CUT = "Part of this page is not shown. Open it in Notion to see the rest.";
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const PAGE = id(1);
const txt = (content) => ({ type: "text", text: { content, link: null }, plain_text: content, href: null, annotations: {} });
const block = (n, type, data, more = {}) => ({ object: "block", id: id(n), type, has_children: false, [type]: data, ...more });
const para = (n) => block(n, "paragraph", { rich_text: [txt(`p${n}`)] });
const quote = (n) => block(n, "quote", { rich_text: [txt(`q${n}`)] }, { has_children: true });
const page = (blocks, next = null) => ({ ok: { blocks, next } });

function makeCtx(answer) {
  const calls = [];
  const state = { alive: true };
  const ctx = {
    openUrl: () => {},
    loadChildren: async (bid, cursor) => {
      calls.push([bid, cursor]);
      return answer(bid, cursor, calls.length);
    },
    alive: () => state.alive,
  };
  return { ctx, calls, state };
}

async function settle(walk) {
  for (let i = 0; i < 8; i++) {
    await walk?.idle;
    await new Promise((r) => setTimeout(r, 0));
  }
}

const cutNotes = (root) => [...root.querySelectorAll(".nb-cut")].map((n) => n.textContent);

test("a detached target stops requests", async () => {
  const c = makeCtx(() => page([para(9)]));
  c.state.alive = false;
  const out = renderDoc({ pageId: PAGE, blocks: [quote(2)], next: "cursor-1" }, c.ctx);
  await settle(out.walk);
  assert.deepEqual(c.calls, []);

  const d = makeCtx((bid, cursor, n) => { if (n === 1) d.state.alive = false; return page([para(10 + n)], "more"); });
  const out2 = renderDoc({ pageId: PAGE, blocks: [para(2)], next: "cursor-1" }, d.ctx);
  await settle(out2.walk);
  assert.equal(d.calls.length, 1);
  assert.equal(out2.el.querySelectorAll("p.nb-p").length, 1, "a reply after detach is dropped");
  assert.deepEqual(cutNotes(out2.el), []);
});

test("the request cap stops the walk and shows the note", async () => {
  const c = makeCtx((bid, cursor, n) => page([para(1000 + n)], `cursor-${n + 1}`));
  const out = renderDoc({ pageId: PAGE, blocks: [para(2)], next: "cursor-1" }, c.ctx);
  await settle(out.walk);
  assert.equal(c.calls.length, MAX_REQUESTS - 1, "the first page (the adapter's load) is one of the 60");
  assert.equal(out.walk.requests, MAX_REQUESTS);
  assert.deepEqual(cutNotes(out.el), [CUT]);
});

test("the depth cap: the root's children are depth 1, 6 nested levels render, then the note", async () => {
  let n = 100;
  const c = makeCtx(() => page([quote(n++)]));
  const out = renderDoc({ pageId: PAGE, blocks: [quote(2)], next: null }, c.ctx);
  await settle(out.walk);
  assert.equal(MAX_DEPTH, 6);
  assert.equal(c.calls.length, MAX_DEPTH - 1);
  let levels = 0;
  for (let q = out.el.querySelector("blockquote"); q; q = q.querySelector(":scope > blockquote")) levels++;
  assert.equal(levels, MAX_DEPTH, "six levels below the page, not seven");
  assert.deepEqual(cutNotes(out.el), [CUT]);
});

test("a deep branch hitting depth 6 leaves its siblings loading", async () => {
  let n = 100;
  const toggle = block(4, "toggle", { rich_text: [txt("Later")] }, { has_children: true });
  const c = makeCtx((bid, cursor) => {
    if (bid === id(3)) return page([para(30)]);
    if (bid === id(4)) return page([para(40)]);
    if (bid === PAGE) return page([para(50)]);
    return page([quote(n++)]); // the deep branch under id(2) never ends
  });
  const out = renderDoc({ pageId: PAGE, blocks: [quote(2), quote(3), toggle], next: "cursor-1" }, c.ctx);
  await settle(out.walk);
  assert.equal(c.calls.filter(([bid]) => bid !== id(3) && bid !== PAGE).length, MAX_DEPTH - 1);
  assert.equal(out.el.querySelector(`blockquote`).nextElementSibling.textContent, "q3p30");
  assert.ok(out.el.textContent.includes("p50"), "the page's next cursor still loads");
  out.el.querySelector("details").open = true;
  out.el.querySelector("details").dispatchEvent(new window.Event("toggle"));
  await settle(out.walk);
  assert.ok(c.calls.some(([bid]) => bid === id(4)), "a toggle opened after the cap still loads");
  assert.equal(out.el.querySelector("details .nb-kids").textContent, "p40");
  assert.deepEqual(cutNotes(out.el), [CUT]);
  assert.equal(out.el.lastElementChild.className, "nb-cut", "the note stays last");
});

test("the block cap stops the walk and shows the note", async () => {
  let n = 10000;
  const hundred = () => Array.from({ length: 100 }, () => para(n++));
  const c = makeCtx((bid, cursor, k) => page(hundred(), `cursor-${k + 1}`));
  const out = renderDoc({ pageId: PAGE, blocks: hundred(), next: "cursor-1" }, c.ctx);
  await settle(out.walk);
  assert.equal(out.el.querySelectorAll("p.nb-p").length, MAX_BLOCKS);
  assert.equal(c.calls.length, MAX_BLOCKS / 100 - 1);
  assert.deepEqual(cutNotes(out.el), [CUT]);
});

test("toggles and toggleable headings stay lazy until opened", async () => {
  const c = makeCtx(() => page([para(50)]));
  const toggle = block(2, "toggle", { rich_text: [txt("More")] }, { has_children: true });
  const heading = block(3, "heading_2", { rich_text: [txt("Section")], is_toggleable: true }, { has_children: true });
  const out = renderDoc({ pageId: PAGE, blocks: [toggle, heading], next: null }, c.ctx);
  await settle(out.walk);
  assert.deepEqual(c.calls, []);
  const [first, second] = out.el.querySelectorAll("details");
  assert.equal(first.querySelector("summary").textContent, "More");
  assert.equal(second.querySelector("summary h4").textContent, "Section");
  first.open = true;
  first.dispatchEvent(new window.Event("toggle"));
  await settle(out.walk);
  assert.deepEqual(c.calls, [[id(2), null]]);
  assert.equal(first.querySelector(".nb-kids").textContent, "p50");
  first.dispatchEvent(new window.Event("toggle"));
  await settle(out.walk);
  assert.equal(c.calls.length, 1, "a second open does not refetch");
});

test("a synced cycle terminates", async () => {
  const synced = (n, from) => block(n, "synced_block", { synced_from: from ? { type: "block_id", block_id: from } : null }, { has_children: true });
  // the duplicate points at the original; the original holds a duplicate of the first block
  const c = makeCtx((bid) => (bid === id(20) ? page([synced(21, id(2))]) : page([synced(22, id(20))])));
  const out = renderDoc({ pageId: PAGE, blocks: [synced(2, id(20))], next: null }, c.ctx);
  await settle(out.walk);
  assert.deepEqual(c.calls.map((x) => x[0]), [id(20), id(2)]);
  assert.deepEqual(cutNotes(out.el), []);
});

test("the first error stops the walk; with work still queued the root says so too", async () => {
  const c = makeCtx((bid) => (bid === id(2) ? { error: { title: "Notion Is Busy", message: "" } } : page([para(9)])));
  const out = renderDoc({ pageId: PAGE, blocks: [quote(2), quote(3)], next: "cursor-1" }, c.ctx);
  await settle(out.walk);
  assert.deepEqual(c.calls, [[id(2), null]]);
  assert.equal(out.el.querySelector("blockquote .nb-error").textContent, "Couldn't Load This Part");
  const rootNotes = [...out.el.querySelectorAll(":scope > .nb-error")].map((n) => n.textContent);
  assert.deepEqual(rootNotes, ["Couldn't Load All of This Page."]);
});

test("a thrown fetch counts as the first error; nothing queued, no root note", async () => {
  const c = makeCtx(() => { throw new Error("boom"); });
  const out = renderDoc({ pageId: PAGE, blocks: [para(2)], next: "cursor-1" }, c.ctx);
  await settle(out.walk);
  assert.equal(c.calls.length, 1);
  assert.deepEqual([...out.el.querySelectorAll(".nb-error")].map((n) => n.textContent), ["Couldn't Load This Part"]);
});
