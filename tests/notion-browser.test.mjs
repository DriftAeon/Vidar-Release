// Notion paging and adapter (src/notion/fetch.ts, adapter.ts; plan D1, § Adapter rules): the four paging stops,
// propsRefused, the generation drop, the stale stamp after the last page, the two-call card load and its
// cache, the send text, http(s)-only links, and drill-in on data sources only.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom();
const fetchMod = await import("../src/notion/fetch.ts");
const { MAX_PAGES, TOP, pageAll, loadTop, loadSource, isStale, dueOnShow, bumpGen, clearStamps, clearRefused, propsRefused } = fetchMod;
const adapterMod = await import("../src/notion/adapter.ts");
const { MAX_DETAILS, SEND_BYTES, makeAdapter, loadDetail, detailCount, clearAdapterState, rememberLinks, linkFor } = adapterMod;
const { cleanSend } = await import("../src/browser/send.ts");

const answers = dom.ipc.answers;
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const alive = () => true;
const page = (ids, next) => ({ ok: { items: ids.map((i) => ({ id: id(i) })), next } });

function reset() {
  bumpGen();
  clearStamps();
  clearRefused();
  clearAdapterState();
  dom.ipc.invoked.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
}

test("paging stops on a null or absent cursor and dedupes ids", async () => {
  const pages = [page([1, 2], "c1"), page([2, 3], null)];
  let n = 0;
  const r = await pageAll(async () => pages[n++], alive);
  assert.deepEqual([r.items.map((i) => i.id), r.capped, r.error, n], [[id(1), id(2), id(3)], false, null, 2]);
  n = 0;
  const absent = await pageAll(async () => (n++, { ok: { items: [{ id: id(9) }] } }), alive);
  assert.deepEqual([absent.items.length, n], [1, 1]);
});

test("paging stops at MAX_PAGES as capped, and on an empty page that still has a cursor", async () => {
  let n = 0;
  const r = await pageAll(async () => page([++n], `c${n}`), alive);
  assert.equal(MAX_PAGES, 20);
  assert.deepEqual([n, r.items.length, r.capped], [20, 20, true]);
  n = 0;
  const empty = await pageAll(async () => (n++, page([], "more")), alive);
  assert.deepEqual([n, empty.items.length, empty.capped], [1, 0, false]);
});

test("paging stops on its first error and keeps what landed", async () => {
  let n = 0;
  const err = { kind: "rate", message: "slow", retryAfter: 2 };
  const r = await pageAll(async () => (n++ === 0 ? page([1], "c") : { error: err }), alive);
  assert.deepEqual([n, r.items.length, r.error], [2, 1, err]);
});

test("a generation bump or a dead caller mid-loop returns null", async () => {
  let n = 0;
  const r = await pageAll(async () => { if (n++ === 1) bumpGen(); return page([n], "c"); }, alive);
  assert.equal(r, null);
  assert.equal(n, 2);
  let live = true;
  const gone = await pageAll(async () => { live = false; return page([1], "c"); }, () => live);
  assert.equal(gone, null);
});

test("the top level reads sources then pages, and stamps only after the last page", async () => {
  reset();
  const kinds = [];
  answers.notion_search = ({ kind, cursor }) => {
    kinds.push([kind, cursor]);
    if (kind === "source") return { hits: [{ id: id(0xd01), kind: "source", title: "Tasks", url: "https://www.notion.so/t", lastEdited: "" }], next: null };
    return cursor ? { hits: [], next: null } : { hits: [{ id: id(1), kind: "page", title: "Home", url: "https://www.notion.so/h", lastEdited: "" }], next: "p2" };
  };
  assert.equal(isStale(TOP), true);
  const r = await loadTop(alive);
  assert.deepEqual(kinds, [["source", null], ["page", null], ["page", "p2"]]);
  assert.deepEqual(r.hits.map((h) => h.kind), ["source", "page"]);
  assert.equal(isStale(TOP), false);
  assert.equal(isStale(TOP, Date.now() + 10 * 60_000 + 1), true, "stale after 10 min");
});

test("a top-level error ends the level without the page search or a stamp; a thrown invoke is a network error", async () => {
  reset();
  answers.notion_search = () => ({ error: { kind: "forbidden", message: "no" } });
  assert.equal(dueOnShow(TOP), true);
  const r = await loadTop(alive);
  assert.equal(r.error.kind, "forbidden");
  assert.deepEqual(dom.ipc.invoked, ["notion_search"]);
  assert.equal(isStale(TOP), true);
  assert.equal(dueOnShow(TOP), false, "the failed attempt is stamped");
  assert.equal(dueOnShow(TOP, Date.now() + 10 * 60_000), true, "due again at 10 min");
  reset();
  const net = await loadTop(alive);
  assert.equal(net.error.kind, "network");
});

test("a data source sends title and chip props until a reply refuses them, then sends none", async () => {
  reset();
  const ds = id(0xd01);
  const sent = [];
  answers.notion_source = () => ({ source: { id: ds, title: "Tasks", url: "u", props: [
    { id: "title", name: "Name", type: "title", options: [], groups: [] },
    { id: "s1", name: "Stage", type: "select", options: [{ name: "A", color: "default" }], groups: [] },
  ] } });
  answers.notion_query = ({ cursor, props }) => {
    sent.push(props);
    if (!cursor) return { rows: [{ id: id(1), title: "R1", url: "u", lastEdited: "", values: {} }], next: "c2", propsRefused: true };
    return { rows: [{ id: id(2), title: "R2", url: "u", lastEdited: "", values: {} }], next: null, propsRefused: false };
  };
  const r = await loadSource(ds, alive);
  assert.deepEqual(sent, [["title", "s1"], []]);
  assert.equal(propsRefused(ds), true);
  assert.deepEqual(r.rows.map((x) => x.title), ["R1", "R2"]);
  assert.equal(isStale(ds), false);
  await loadSource(ds, alive);
  assert.deepEqual(sent.at(-1), [], "refusal sticks for the source");
});

test("a data-source error mid-loop keeps the rows and leaves the level stale", async () => {
  reset();
  const ds = id(0xd02);
  answers.notion_source = () => ({ source: { id: ds, title: "T", url: "u", props: [] } });
  answers.notion_query = ({ cursor }) => cursor
    ? { error: { kind: "network", message: "down" } }
    : { rows: [{ id: id(1), title: "R1", url: "u", lastEdited: "", values: {} }], next: "c2", propsRefused: false };
  const r = await loadSource(ds, alive);
  assert.deepEqual([r.rows.length, r.error.kind, isStale(ds)], [1, "network", true]);
});

const ITEM = { id: id(1), key: "", title: "Plan", status: "", updated: "2026-10-16T12:00:00Z", facets: {}, fields: [] };
function detailAnswers() {
  answers.notion_page = ({ id: pid }) => ({ page: { id: pid, title: "Plan", url: `https://www.notion.so/${pid.slice(-4)}`, lastEdited: "", created: "2026-09-01T00:00:00Z", fields: [] } });
  answers.notion_blocks = () => ({ blocks: [
    { object: "block", id: id(5), type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: "Hello there", text: { content: "Hello there" }, annotations: {} }] } },
    { object: "block", id: id(6), type: "child_page", child_page: { title: "Child" } },
  ], next: "b2" });
}

test("a card load is two calls: notion_page then the first notion_blocks page", async () => {
  reset();
  detailAnswers();
  const r = await loadDetail(ITEM);
  assert.deepEqual(dom.ipc.invoked, ["notion_page", "notion_blocks"]);
  assert.deepEqual(Object.keys(r.ok.body), ["pageId", "blocks", "next"]);
  assert.deepEqual([r.ok.body.pageId, r.ok.body.blocks.length, r.ok.body.next], [id(1), 2, "b2"]);
  assert.match(r.ok.excerpt, /Hello there/);
  assert.deepEqual(r.ok.sections.map((s) => [s.title, s.rows.length]), [["Subpages", 1]]);
  assert.deepEqual(r.ok.comments, { total: 0, items: [], more: false });
  assert.equal(linkFor(id(1)), "https://www.notion.so/0001", "the page reply's url is remembered");
});

test("the detail cache shares one promise per key, holds 100, and is not refilled after a generation bump", async () => {
  reset();
  detailAnswers();
  const a = loadDetail(ITEM);
  assert.equal(loadDetail(ITEM), a, "one promise in flight per key");
  await a;
  assert.equal(dom.ipc.invoked.length, 2);
  assert.equal(loadDetail({ ...ITEM, updated: "later" }) === a, false, "a new lastEdited is a new key");
  for (let i = 0; i < MAX_DETAILS + 5; i++) void loadDetail({ ...ITEM, id: id(100 + i) });
  assert.equal(detailCount(), MAX_DETAILS);
  for (let i = 0; i < 10; i++) await dom.flush();

  reset();
  detailAnswers();
  const late = loadDetail(ITEM);
  bumpGen();
  await late;
  assert.equal(detailCount(), 0, "a reply after the generation moved is not kept");
  dom.ipc.invoked.length = 0;
  await loadDetail(ITEM);
  assert.deepEqual(dom.ipc.invoked, ["notion_page", "notion_blocks"], "an older generation's entry is a miss");
});

test("an error reply is returned with its copy and not cached", async () => {
  reset();
  answers.notion_page = () => ({ error: { kind: "missing", message: "x" } });
  const r = await loadDetail(ITEM);
  assert.equal(r.error.title, "Page Not Shared");
  assert.equal(detailCount(), 0);
});

test("send types title and link through cleanSend; open and openUrl take http(s) only", async () => {
  reset();
  const typed = [];
  const a = makeAdapter("notion", { drill() {}, type: (t) => typed.push(t) });
  rememberLinks([{ id: id(1), url: "https://www.notion.so/plan-1" }]);
  a.send({ ...ITEM, title: "Plan\u0007 one" });
  assert.deepEqual(typed, [cleanSend(`Plan\u0007 one https://www.notion.so/plan-1`, SEND_BYTES)]);
  assert.equal(a.sendTip, "Types the title and link into the focused tab without sending it.");
  const urls = [];
  answers.open_url = ({ url }) => { urls.push(url); };
  a.open(ITEM);
  a.openUrl("javascript:alert(1)");
  a.openUrl("file:///C:/x");
  a.openUrl("http://example.com/a");
  await dom.flush();
  assert.deepEqual(urls, ["https://www.notion.so/plan-1", "http://example.com/a"]);
});

test("send cuts a long title, never the url, to fit 1024 bytes", () => {
  reset();
  const typed = [];
  const a = makeAdapter("notion", { drill() {}, type: (t) => typed.push(t) });
  const url = "https://www.notion.so/plan-1";
  rememberLinks([{ id: id(1), url }]);
  a.send({ ...ITEM, title: "é".repeat(2000) });
  const out = typed[0];
  assert.ok(out.endsWith(` ${url}`), "the url is intact");
  assert.ok(new TextEncoder().encode(out).length <= SEND_BYTES);
  assert.ok(new TextEncoder().encode(out).length >= SEND_BYTES - 1, "the title takes the room left");
  assert.ok(!out.includes("�"));
});

test("activate drills in on data sources only; back exists only when given", () => {
  reset();
  const drilled = [];
  const top = makeAdapter("notion", { drill: (i) => drilled.push(i.id), type() {} });
  rememberLinks([{ id: id(0xd01), url: "u", source: true }, { id: id(1), url: "u" }]);
  assert.equal(top.activate({ ...ITEM, id: id(1) }), false);
  assert.equal(top.activate({ ...ITEM, id: id(0xd01) }), true);
  assert.deepEqual(drilled, [id(0xd01)]);
  assert.equal(top.back, undefined);
  let backs = 0;
  const src = makeAdapter("notion:x", { drill() {}, back: () => backs++, type() {} });
  src.back();
  assert.equal(backs, 1);
});

test("loadChildren pages notion_blocks and maps errors to copy", async () => {
  reset();
  answers.notion_blocks = ({ cursor }) => cursor === "c" ? { error: { kind: "rate", message: "", retryAfter: 5 } } : { blocks: [], next: "c" };
  const a = makeAdapter("notion", { drill() {}, type() {} });
  assert.deepEqual(await a.loadChildren(id(1), null), { ok: { blocks: [], next: "c" } });
  assert.deepEqual(await a.loadChildren(id(1), "c"), { error: { title: "Notion Is Busy", message: "Try again in 5 s." } });
});
