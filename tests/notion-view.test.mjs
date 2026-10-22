// Notion bench tab view contract (panels/notion.ts, notion/view.ts; plan § Views): the unset notice and Hide,
// the Connect form and the token's life, the top bands and their tooltips, the empty states, the cap and
// partial notes, drill-in and Back (button and Esc) with focus back on the row, error kinds, remote text as
// text, refresh on show only when stale and not attempted in 10 min, the busy guard on a repeat show, and
// Disconnect (a reject keeps the list; success then Connect leaves no old card or Fullscreen).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    prefs: `export function getPref(k) { return globalThis.__nt.prefs[k]; }
      export function setPref(k, v) { globalThis.__nt.prefs[k] = v; return true; }`,
    "panels/sessions": `export async function writeToSession(id, text) { globalThis.__nt.written.push([id, text]); return true; }`,
    "panels/sessions/lookup": `export function getFocusedSession() { return globalThis.__nt.focused; }`,
  },
});
globalThis.__nt = { prefs: {}, written: [], focused: { id: "t1" } };
const { mountNotionView, onNotionShown, onNotionHidden, disposeNotionView } = await import("../src/panels/notion.ts");
const { TOP_CAP_NOTE, ROW_CAP_NOTE, SEND_TIP, DATABASE_TIP } = await import("../src/notion/model.ts");

const answers = dom.ipc.answers;
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const DS = id(0xd01);
const UNSET = { tokenSaved: false, workspace: null, kind: null };
const SAVED = { tokenSaved: true, workspace: "Example Workspace", kind: "connection" };
const DB_HIT = { id: DS, kind: "source", title: "Tasks", url: "https://www.notion.so/tasks", lastEdited: "2026-10-16T12:00:00Z" };
const PAGE_HIT = { id: id(1), kind: "page", title: "<img src=x onerror=alert(1)> Home", url: "https://www.notion.so/home", lastEdited: "2026-10-15T12:00:00Z" };
const SOURCE = { id: DS, title: "Tasks", url: "https://www.notion.so/tasks", props: [
  { id: "title", name: "Name", type: "title", options: [], groups: [] },
  { id: "st", name: "Status", type: "status", options: [{ name: "Done", color: "green" }], groups: [{ name: "Complete", options: ["Done"] }] },
] };
const ROW = (n) => ({ id: id(0x100 + n), title: `Row ${n}`, url: `https://www.notion.so/r${n}`, lastEdited: "2026-10-16T12:00:00Z", values: { st: ["Done"] } });
const searchOf = (sources, pages) => ({ kind }) => ({ hits: kind === "source" ? sources : pages, next: null });
let root;

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await dom.flush(); };
async function open(status, search = searchOf([DB_HIT], [PAGE_HIT])) {
  disposeNotionView();
  dom.ipc.invoked.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  answers.notion_status = status;
  answers.notion_search = search;
  answers.open_url = undefined;
  root = mountNotionView(document.body);
  onNotionShown();
  await settle();
}
const text = (sel, at = root) => [...at.querySelectorAll(sel)].map((n) => n.textContent);
const btn = (label, at = root) => [...at.querySelectorAll("button")].find((b) => !b.closest("[hidden]") && (b.textContent === label || b.getAttribute("aria-label") === label));
const tokenField = () => root.querySelector('input[aria-label="Token"]');
const browsers = () => [...root.querySelectorAll(":scope > .br-root")];
const rowOf = (rid, at = root) => at.querySelector(`.br-row[data-id="${rid}"]`);
async function submit(value) {
  tokenField().value = value;
  root.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await settle();
}
async function drillIn(source = SOURCE, query = () => ({ rows: [ROW(1)], next: null, propsRefused: false })) {
  answers.notion_source = { source };
  answers.notion_query = query;
  rowOf(DS).click();
  await settle();
  return browsers()[1];
}

test("unset shows the notice with Connect and Hide; Hide writes bench:notion", async () => {
  await open(UNSET);
  assert.equal(root.querySelector(".nt-notice").hidden, false);
  assert.deepEqual(text(".nt-notice .es-title"), ["Notion Not Connected"]);
  assert.equal(root.querySelector("form").hidden, true);
  assert.ok(!dom.ipc.invoked.includes("notion_search"), "no request while unset");
  let changed = 0;
  document.addEventListener("vidar-modules-change", () => changed++, { once: true });
  btn("Hide").click();
  assert.deepEqual(globalThis.__nt.prefs["modules.hidden"], ["bench:notion"]);
  assert.equal(changed, 1);
  globalThis.__nt.prefs = {};
});

test("the form: the token is emptied on submit, never left in the DOM, and errors title by kind", async () => {
  await open(UNSET);
  btn("Connect").click();
  assert.equal(root.querySelector("form").hidden, false);
  assert.deepEqual([...root.querySelectorAll("form .nt-link")].map((b) => b.textContent), ["Create a Personal Token", "Use a Connection Instead"], "the personal token leads");
  assert.ok(btn("Cancel"));
  assert.equal(tokenField().type, "password");
  const titles = [];
  for (const kind of ["auth", "network", "endpoint"]) {
    answers.notion_connect = { error: { kind, message: "detail" } };
    await submit("ntn_secret_000");
    titles.push(root.querySelector(".cx-note-msg").textContent);
    assert.equal(tokenField().value, "");
    assert.ok(!root.outerHTML.includes("ntn_secret_000"), "the token is not in the DOM");
  }
  assert.deepEqual(titles, ["Notion Refused the Token", "Notion Did Not Answer", "Notion Couldn't Connect"]);
  btn("Create a Personal Token").click();
  btn("Use a Connection Instead").click();
  await dom.flush();
  answers.notion_connect = { workspace: "Example Workspace", kind: "connection" };
  await submit("ntn_secret_000");
  assert.equal(root.querySelector("form").hidden, true);
  assert.deepEqual(text(".nt-head .nt-head-title"), ["Example Workspace"]);
  assert.ok(!root.outerHTML.includes("ntn_secret_000"));
});

test("Cancel goes back to the notice", async () => {
  await open(UNSET);
  btn("Connect").click();
  btn("Cancel").click();
  assert.equal(root.querySelector(".nt-notice").hidden, false);
});

// The band card once reused .br-sec, the fullscreen section head's class (browser-full.css: 24px tall, centred,
// dim): every card clamped to its head and clipped its rows, so nothing in the list could be clicked. The card's
// classes belong to notion.css alone.
test("no stylesheet but notion.css styles the band card's classes", async () => {
  await open(SAVED);
  const card = rowOf(DS).parentElement;
  const dir = new URL("../src/styles/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css") && f !== "notion.css")) {
    const css = readFileSync(new URL(file, dir), "utf8");
    for (const cls of card.classList) {
      assert.ok(!new RegExp(`\\.${cls}(?![\\w-])`).test(css), `.${cls} is also styled in ${file}`);
    }
  }
});

test("the top level bands Databases then Pages; rows carry the database and Send tooltips; titles are text", async () => {
  await open(SAVED);
  assert.deepEqual(text(".br-band-label"), ["Databases", "Pages"]);
  assert.deepEqual([...root.querySelectorAll(".br-group")].map((s) => s.dataset.band), ["databases", "pages"]);
  assert.equal(rowOf(DS).parentElement.dataset.band, "databases", "a row sits inside its band's card");
  assert.equal(rowOf(DS).title, DATABASE_TIP);
  assert.equal(rowOf(id(1)).title, "");
  assert.equal(rowOf(id(1)).querySelector(".br-send").title, SEND_TIP);
  assert.equal(rowOf(id(1)).querySelector(".br-title").textContent, PAGE_HIT.title);
  assert.equal(root.querySelector("img[src=x]"), null, "markup in a title stays text");
  assert.ok(btn("Refresh") && btn("Disconnect"));
  rowOf(id(1)).querySelector(".br-send").click();
  await settle(2);
  assert.equal(globalThis.__nt.written.at(-1)[0], "t1");
  assert.match(globalThis.__nt.written.at(-1)[1], /Home https:\/\/www\.notion\.so\/home$/);
});

test("empty states: a connection shares nothing yet, a personal token finds nothing", async () => {
  await open(SAVED, searchOf([], []));
  assert.deepEqual(text(".nt-state:not([hidden]) .nt-state-title"), ["Nothing Shared Yet"]);
  assert.match(text(".nt-state:not([hidden]) .nt-sub")[0], /Add Connections/);
  await open({ ...SAVED, kind: "personal" }, searchOf([], []));
  assert.deepEqual(text(".nt-state:not([hidden]) .nt-state-title"), ["No Pages Found"]);
});

test("a capped top level shows the cap note", async () => {
  let n = 0;
  await open(SAVED, ({ kind }) => ({ hits: [{ ...PAGE_HIT, kind, id: id(0x500 + n++) }], next: `c${n}` }));
  assert.equal(root.querySelector(".br-note").textContent, TOP_CAP_NOTE);
});

test("error kinds: forbidden shows its sentence, network puts the text in the tooltip", async () => {
  await open(SAVED, () => ({ error: { kind: "forbidden", message: "raw" } }));
  const block = () => root.querySelector(".nt-state:not([hidden]):not(.nt-notice)");
  assert.deepEqual([block().querySelector(".nt-state-title").textContent, text(".nt-sub", block())[0]],
    ["Notion Needs Read Content", "Turn on Read Content for the connection in Notion."]);
  await open(SAVED, () => ({ error: { kind: "network", message: "<b>socket</b> closed" } }));
  assert.equal(block().querySelector(".nt-state-title").textContent, "Notion Did Not Answer");
  assert.equal(block().title, "<b>socket</b> closed");
  assert.equal(block().querySelector("b"), null);
});

test("drill-in keeps the top browser mounted but hidden; Back disposes the source browser and focuses the row", async () => {
  await open(SAVED);
  const top = browsers()[0];
  const src = await drillIn();
  assert.equal(browsers().length, 2);
  assert.equal(top.hidden, true);
  assert.ok(top.isConnected);
  assert.deepEqual(text(".nt-head-title", src), ["Tasks"]);
  assert.deepEqual(text(".br-title", src), ["Row 1"]);
  assert.equal(document.activeElement, src);
  btn("Back to Notion", src).click();
  await settle();
  assert.equal(browsers().length, 1);
  assert.equal(top.hidden, false);
  assert.equal(document.activeElement, rowOf(DS));
});

test("Esc at rest on the data source goes back", async () => {
  await open(SAVED);
  const src = await drillIn();
  src.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await settle();
  assert.equal(browsers().length, 1);
  assert.equal(document.activeElement, rowOf(DS));
});

test("a data source shows the partial note on a mid-load error, the cap note at 20 pages, and No Pages Found when empty", async () => {
  await open(SAVED);
  let src = await drillIn(SOURCE, ({ cursor }) => cursor ? { error: { kind: "network", message: "x" } } : { rows: [ROW(1)], next: "c", propsRefused: false });
  assert.equal(src.querySelector(".br-note").textContent, "Only 1 row loaded. Refresh to try again.");
  btn("Back to Notion", src).click();
  await settle();
  let n = 0;
  src = await drillIn(SOURCE, () => ({ rows: [ROW(n++)], next: `c${n}`, propsRefused: false }));
  assert.equal(src.querySelector(".br-note").textContent, ROW_CAP_NOTE);
  btn("Back to Notion", src).click();
  await settle();
  src = await drillIn(SOURCE, () => ({ rows: [], next: null, propsRefused: false }));
  assert.deepEqual(text(".nt-state:not([hidden]) .nt-state-title", src), ["No Pages Found"]);
});

test("show refreshes only when the level is stale (10 min)", async () => {
  await open(SAVED);
  dom.ipc.invoked.length = 0;
  onNotionHidden();
  onNotionShown();
  await settle();
  assert.deepEqual(dom.ipc.invoked, [], "fresh: no reads on show");
  const real = Date.now;
  Date.now = () => real() + 10 * 60_000 + 1000;
  try {
    onNotionShown();
    await settle();
  } finally {
    Date.now = real;
  }
  assert.deepEqual(dom.ipc.invoked, ["notion_status", "notion_search", "notion_search"]);
});

test("a repeat show mid-load sends nothing new; once the first load lands busy is false and the items render", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await open(SAVED, ({ kind }) => kind === "source" ? gate.then(() => ({ hits: [DB_HIT], next: null })) : { hits: [PAGE_HIT], next: null });
  assert.deepEqual(dom.ipc.invoked, ["notion_status", "notion_search"]);
  onNotionShown();
  onNotionShown();
  await settle();
  assert.deepEqual(dom.ipc.invoked, ["notion_status", "notion_search"], "no second status read or search");
  release();
  await settle();
  assert.deepEqual(dom.ipc.invoked, ["notion_status", "notion_search", "notion_search"]);
  assert.equal(browsers()[0].getAttribute("aria-busy"), "false");
  assert.equal(btn("Refresh").disabled, false);
  assert.ok(rowOf(DS) && rowOf(id(1)), "the items rendered");
});

test("a failed load is stamped: a repeat show sends no call, a manual Refresh still does", async () => {
  await open(SAVED, () => ({ error: { kind: "network", message: "down" } }));
  dom.ipc.invoked.length = 0;
  onNotionHidden();
  onNotionShown();
  onNotionShown();
  await settle();
  assert.deepEqual(dom.ipc.invoked, []);
  btn("Refresh").click();
  await settle();
  assert.deepEqual(dom.ipc.invoked, ["notion_status", "notion_search"]);
});

test("a rejected Disconnect keeps the list, its links and its data sources", async () => {
  await open(SAVED);
  answers.notion_disconnect = () => Promise.reject(new Error("Credential Manager refused"));
  btn("Disconnect").click();
  await settle();
  assert.equal(root.querySelector("form").hidden, true);
  assert.equal(browsers()[0].hidden, false);
  assert.equal(root.querySelector(".br-note").textContent, "Credential Manager refused");
  const src = await drillIn();
  assert.ok(dom.ipc.invoked.includes("notion_source"), "a database row still drills in");
  assert.deepEqual(text(".br-title", src), ["Row 1"]);
});

test("no old card or Fullscreen survives a Disconnect and Connect", async () => {
  await open(SAVED);
  answers.notion_page = ({ id: pid }) => ({ page: { id: pid, title: "Home", url: PAGE_HIT.url, lastEdited: "", created: "", fields: [] } });
  answers.notion_blocks = () => ({ blocks: [{ object: "block", id: id(9), type: "paragraph", has_children: false,
    paragraph: { rich_text: [{ type: "text", text: { content: "Old body", link: null }, plain_text: "Old body", href: null, annotations: {} }] } }], next: null });
  rowOf(id(1)).click();
  await settle();
  root.querySelector('.br-card button[aria-label="Fullscreen"]').click();
  await settle();
  assert.ok(root.querySelector(".br-full-host").textContent.includes("Old body"));
  answers.notion_disconnect = undefined;
  btn("Disconnect").click();
  await settle();
  assert.equal(root.querySelector(".br-full-host").hidden, true, "Fullscreen closed");
  assert.equal(root.querySelector(".br-full-host").textContent, "");
  answers.notion_connect = { workspace: "Example Workspace", kind: "connection" };
  await submit("ntn_secret_000");
  assert.equal(root.querySelector("form").hidden, true);
  assert.ok(rowOf(id(1)), "the new list is up");
  assert.equal(root.querySelector(".br-card"), null, "no card is open");
  assert.ok(!root.textContent.includes("Old body"));
});

test("Disconnect forgets the connection and shows the form", async () => {
  await open(SAVED);
  answers.notion_disconnect = undefined;
  btn("Disconnect").click();
  await settle();
  assert.ok(dom.ipc.invoked.includes("notion_disconnect"));
  assert.equal(root.querySelector("form").hidden, false);
  assert.equal(browsers()[0].hidden, true);
});

test("dispose removes the view", async () => {
  await open(SAVED);
  disposeNotionView();
  assert.equal(root.isConnected, false);
});
