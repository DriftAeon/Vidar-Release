// Jira bench tab paging contract (panels/jira.ts, jira/view.ts): sections, Load 50 More, the query counter,
// and the on-show refresh (plan D2-D5).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    prefs: `export function getPref() { return undefined; } export function setPref() { return true; }`,
    "panels/sessions": `export async function writeToSession() { return true; }`,
    "panels/sessions/lookup": `export function getFocusedSession() { return null; }`,
  },
});
const { mountJiraView, onJiraShown, disposeJiraView } = await import("../src/panels/jira.ts");

const answers = dom.ipc.answers;
const SAVED = { site: "https://acme.atlassian.net", email: "me@acme.test", jql: null, tokenSaved: true };
const mk = (key, type = "Task", typeLevel = 0, parent = "") => ({ key, summary: `Summary ${key}`, status: "To Do", statusCategory: "new", type, priority: "", updated: "", url: `https://acme.atlassian.net/browse/${key}`, typeLevel, parent });
const calls = (name) => dom.ipc.invoked.filter((c) => c === name).length;
let root;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 8; i++) await dom.flush(); }
async function open({ issues }) {
  disposeJiraView();
  dom.ipc.invoked.length = 0;
  answers.jira_status = SAVED;
  answers.jira_issues = issues;
  root = mountJiraView(document.body);
  onJiraShown();
  await settle();
}
const keys = () => [...root.querySelectorAll(".jx-key")].map((n) => n.textContent);
const more = () => root.querySelector(".jx-more");
const scopeBtn = (label) => [...root.querySelectorAll(".jx-scope button")].find((b) => b.textContent === label);

test("the head has the Mine and All pair with the verbatim tooltips, Mine on", async () => {
  await open({ issues: { issues: [mk("A-1")], nextPageToken: null } });
  assert.deepEqual([...root.querySelectorAll(".jx-scope button")].map((b) => [b.textContent, b.title, b.getAttribute("aria-pressed")]), [
    ["Mine", "Your saved query, or your open items when none is saved.", "true"],
    ["All", "Every open item you can see, 50 at a time.", "false"],
  ]);
});

test("rows sit in type sections with the icon, the type tooltip and the parent key", async () => {
  await open({ issues: { issues: [mk("A-1", "Bug", 0, "A-9"), mk("A-9", "Epic", 1), mk("A-2", "Bug"), mk("A-3", "")], nextPageToken: null } });
  assert.deepEqual([...root.querySelectorAll(".br-band-label")].map((n) => n.textContent), ["Epic", "Bug", "Other"]);
  assert.deepEqual([...root.querySelectorAll(".br-band-n")].map((n) => n.textContent), ["1", "2", "1"]);
  const parent = root.querySelector(".jx-parent");
  assert.equal(parent.textContent, "A-9");
  assert.equal(parent.title, "Parent: A-9");
  assert.equal(root.querySelectorAll(".jx-parent").length, 1, "only a row with a parent shows one");
  assert.equal(root.querySelector(".cx-rows .ty").title, "Epic");
  assert.ok(root.querySelector(".br-band .ty svg"), "the head carries the type icon in its slot");
  assert.ok(root.querySelector(".br-band.tone-neutral"), "the band tone stays neutral: type colour is the card edge, status colour the pills");
  assert.deepEqual([...root.querySelectorAll(".jx-sec")].map((s) => s.dataset.kind), ["epic", "bug", "other"]);
});

test("clicking a head collapses its rows, keyed by name plus level, and the head stays", async () => {
  await open({ issues: { issues: [mk("A-1", "Bug"), mk("A-2", "Task")], nextPageToken: null } });
  const bug = [...root.querySelectorAll(".br-band")].find((s) => s.querySelector(".br-band-label").textContent === "Bug");
  bug.click();
  assert.deepEqual(keys(), ["A-2"]);
  assert.equal(root.querySelectorAll(".br-band").length, 2);
  [...root.querySelectorAll(".br-band")].find((s) => s.querySelector(".br-band-label").textContent === "Bug").click();
  assert.deepEqual(keys(), ["A-1", "A-2"]);
});

test("Load 50 More shows only with a next page token", async () => {
  await open({ issues: { issues: [mk("A-1")], nextPageToken: null } });
  assert.equal(more(), null);
  await open({ issues: { issues: [mk("A-1")], nextPageToken: "t2" } });
  assert.equal(more().textContent, "Load 50 More");
});

test("Load 50 More merges the page into its sections and dedupes by key", async () => {
  const sent = [];
  await open({
    issues: (args) => {
      sent.push(args);
      return args.pageToken ? { issues: [mk("A-2"), mk("A-1"), mk("B-1", "Bug")], nextPageToken: null } : { issues: [mk("A-1")], nextPageToken: "t2" };
    },
  });
  more().click();
  await settle();
  assert.deepEqual(sent.map((a) => [a.scope, a.pageToken]), [["mine", null], ["mine", "t2"]]);
  assert.deepEqual(keys().sort(), ["A-1", "A-2", "B-1"]);
  assert.equal(more(), null, "no token left");
  assert.equal(root.querySelectorAll(".br-band").length, 2);
});

test("paging stops on a repeated token", async () => {
  await open({ issues: (args) => ({ issues: [mk(args.pageToken ? "A-2" : "A-1")], nextPageToken: "t2" }) });
  more().click();
  await settle();
  assert.equal(more(), null);
});

test("a stale page 1 reply is dropped after a scope change", async () => {
  const slow = deferred();
  await open({ issues: (args) => (args.scope === "mine" ? slow.promise : { issues: [mk("ALL-1")], nextPageToken: null }) });
  scopeBtn("All").click();
  await settle();
  assert.deepEqual(keys(), ["ALL-1"]);
  slow.resolve({ issues: [mk("MINE-1")], nextPageToken: null });
  await settle();
  assert.deepEqual(keys(), ["ALL-1"], "the older query's reply never lands");
  assert.equal(scopeBtn("All").getAttribute("aria-pressed"), "true");
});

test("a stale Load 50 More reply is dropped after a scope change", async () => {
  const slow = deferred();
  await open({
    issues: (args) => (args.pageToken ? slow.promise : { issues: [mk(args.scope === "all" ? "ALL-1" : "MINE-1")], nextPageToken: "t2" }),
  });
  more().click();
  await settle();
  scopeBtn("All").click();
  await settle();
  slow.resolve({ issues: [mk("MINE-2")], nextPageToken: null });
  await settle();
  assert.deepEqual(keys(), ["ALL-1"]);
});

test("Load 50 More is removed the moment the counter bumps", async () => {
  await open({ issues: { issues: [mk("A-1")], nextPageToken: "t2" } });
  assert.ok(more());
  answers.jira_issues = () => new Promise(() => {});
  root.querySelector('button[aria-label="Refresh"]').click();
  await dom.flush();
  assert.equal(more(), null, "an old token never runs under the new query");
  assert.deepEqual(keys(), ["A-1"], "the loaded rows stay until page 1 lands");
});

test("the head draws no count and none is requested", async () => {
  await open({ issues: { issues: [mk("A-1"), mk("A-2")], nextPageToken: "t2" } });
  assert.equal(root.querySelector(".jx-count"), null);
  assert.ok(!dom.ipc.invoked.includes("jira_count"));
});

test("the on-show refresh is skipped once a second page is loaded", async () => {
  const realNow = Date.now;
  try {
    await open({ issues: (args) => ({ issues: [mk(args.pageToken ? "A-2" : "A-1")], nextPageToken: args.pageToken ? null : "t2" }) });
    Date.now = () => realNow() + 120_000;
    onJiraShown();
    await settle();
    assert.equal(calls("jira_status"), 2, "one page loaded: a stale tab refreshes");
    more().click();
    await settle();
    assert.deepEqual(keys().sort(), ["A-1", "A-2"]);
    const before = calls("jira_status");
    Date.now = () => realNow() + 300_000;
    onJiraShown();
    await settle();
    assert.equal(calls("jira_status"), before, "past page 1 the loaded pages survive");
    assert.deepEqual(keys().sort(), ["A-1", "A-2"]);
  } finally {
    Date.now = realNow;
  }
});

test("remote type, parent and summary text is text only", async () => {
  const hostile = mk("A-1", "<b>Type</b>", 0, "<i>P-1</i>");
  hostile.summary = "<img src=x onerror=alert(1)>";
  await open({ issues: { issues: [hostile], nextPageToken: null } });
  assert.equal(root.querySelector(".br-band-label").textContent, "<b>Type</b>");
  assert.equal(root.querySelector(".jx-parent").textContent, "<i>P-1</i>");
  assert.equal(root.querySelector(".jx-parent").title, "Parent: <i>P-1</i>");
  assert.equal(root.querySelector(".cx-rows .ty").title, "<b>Type</b>");
  assert.equal(root.querySelector(".cx-list img:not(.icn)"), null, "only the app's own icon images");
  assert.equal(root.querySelector(".cx-list b"), null);
  assert.equal(root.querySelector(".cx-list i"), null);
});
