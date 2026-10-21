// Jira issue opened inside the module (jira/detail.ts, panels/jira.ts): a row click opens the shared fullscreen,
// Back restores the list, a reply that lands after Back, Connect or Disconnect is dropped, and an IPC rejection
// is the view's visible error state.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    prefs: `export function getPref() { return undefined; } export function setPref() { return true; }`,
    "panels/sessions": `export async function writeToSession(id, text) { globalThis.__jd.written.push([id, text]); return true; }`,
    "panels/sessions/lookup": `export function getFocusedSession() { return { id: "t1" }; }`,
  },
});
globalThis.__jd = { written: [] };
const { mountJiraView, onJiraShown, disposeJiraView } = await import("../src/panels/jira.ts");
const { toComments, loadTitle, MAX_COMMENTS } = await import("../src/jira/detail.ts");

const answers = dom.ipc.answers;
const SAVED = { site: "https://acme.atlassian.net", email: "me@acme.test", jql: null, tokenSaved: true };
const mk = (key, extra = {}) => ({ key, summary: `Summary ${key}`, status: "Ready-triage", statusCategory: "indeterminate", type: "Bug", priority: "High", updated: "2026-10-16T00:00:00Z", url: `https://acme.atlassian.net/browse/${key}`, typeLevel: 0, parent: "", ...extra });
const ref = (key, status = "To Do", cat = "new") => ({ key, summary: `Ref ${key}`, status, statusCategory: cat, url: `https://acme.atlassian.net/browse/${key}` });
const cm = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ author: i % 2 ? "" : `Person ${start + i}`, created: "2026-10-15T09:30:00.000+0000", body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `Comment ${start + i}` }] }] } }));
const detailOf = (key, extra = {}) => ({
  issue: {
    key, url: `https://acme.atlassian.net/browse/${key}`, summary: `Summary ${key}`, status: "Ready-triage", statusCategory: "indeterminate", type: "Bug", priority: "High", updated: "2026-10-16T00:00:00Z",
    assignee: "Ada Example", description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Body text" }] }] },
    parent: ref("A-9"), subtasks: [ref("A-2", "Done", "done")], comments: { total: 2, startAt: 0, items: cm(2) }, ...extra,
  },
});
let root;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 8; i++) await dom.flush(); }
async function open(issues = { issues: [mk("A-1")], nextPageToken: null }) {
  disposeJiraView();
  dom.ipc.invoked.length = 0;
  globalThis.__jd.written.length = 0;
  answers.jira_status = SAVED;
  answers.jira_issues = issues;
  answers.jira_disconnect = undefined;
  answers.open_url = undefined;
  answers.jira_issue = detailOf("A-1");
  answers.jira_comments = { comments: { total: 2, startAt: 0, items: [] } };
  root = mountJiraView(document.body);
  onJiraShown();
  await settle();
}
const calls = (name) => dom.ipc.invoked.filter((c) => c === name).length;
const full = () => root.querySelector(".br-full");
const row = () => root.querySelector(".cx-row");
const btn = (label) => [...root.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
const fields = () => Object.fromEntries([...root.querySelectorAll(".br-full .br-fm")].map((f) => [f.querySelector(".br-fk").textContent, f.querySelector(".br-fv").textContent]));

test("a row click reads the issue and shows the fullscreen with fields, body, sections and comments", async () => {
  await open();
  const sent = [];
  answers.jira_issue = (args) => { sent.push(args); return detailOf("A-1"); };
  row().click();
  await settle();
  assert.deepEqual(sent, [{ key: "A-1" }]);
  assert.ok(full(), "the fullscreen is drawn");
  assert.ok(root.classList.contains("jx-detail-open"), "the list chrome is hidden");
  assert.equal(root.querySelector(".br-full-host").hidden, false);
  assert.equal(root.querySelector(".br-full-title").textContent, "Summary A-1");
  assert.equal(root.querySelector(".br-full-top .br-pill").textContent, "Ready Triage");
  assert.equal(root.querySelector(".br-full-top .br-pill").className, "br-pill tone-progress");
  assert.deepEqual(fields(), { Type: "Bug", Priority: "High", Updated: fields().Updated, Assignee: "Ada Example" });
  assert.equal(root.querySelector(".br-rich .ja-p").textContent, "Body text");
  assert.deepEqual([...root.querySelectorAll(".br-sec-title")].map((n) => n.textContent), ["Parent", "Subtasks", "Comments"]);
  assert.deepEqual([...root.querySelectorAll(".br-cm .br-who")].map((n) => n.textContent), ["Person 0", "Unknown"]);
  assert.ok(!calls("open_url"), "a row click no longer opens the browser");
});

test("Enter on a focused row opens the issue in the module, Enter on Send does not", async () => {
  await open();
  const sendBtn = btn("Send");
  sendBtn.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.equal(calls("jira_issue"), 0);
  row().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.equal(calls("jira_issue"), 1);
  assert.ok(full());
  assert.ok(!calls("open_url"));
});

test("Back restores the list and Esc does the same", async () => {
  await open();
  row().click();
  await settle();
  btn("Back to List").click();
  assert.equal(full(), null);
  assert.equal(root.querySelector(".br-full-host").hidden, true);
  assert.ok(!root.classList.contains("jx-detail-open"));
  assert.equal(root.querySelector(".jx-key").textContent, "A-1", "the list is still there");
  row().click();
  await settle();
  full().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(full(), null);
  assert.ok(!root.classList.contains("jx-detail-open"));
});

test("a reply that lands after Back is dropped", async () => {
  await open();
  const slow = deferred();
  answers.jira_issue = () => slow.promise;
  row().click();
  await settle();
  assert.ok(full().querySelector("[aria-busy]"), "loading while the reply is out");
  btn("Back to List").click();
  slow.resolve(detailOf("A-1"));
  await settle();
  assert.equal(full(), null);
  assert.equal(root.querySelector(".br-full-host").children.length, 0, "nothing drawn after Back");
});

test("a reply that lands after Disconnect or Connect is dropped", async () => {
  for (const how of ["disconnect", "connect"]) {
    await open();
    const slow = deferred();
    answers.jira_issue = () => slow.promise;
    row().click();
    await settle();
    if (how === "disconnect") {
      btn("Disconnect").click();
    } else {
      const form = root.querySelector("form");
      const set = (label, value) => { root.querySelector(`input[aria-label="${label}"]`).value = value; };
      set("Site", "acme"); set("Email", "me@acme.test"); set("API Token", "tok"); set("JQL", "");
      answers.patch_settings = undefined;
      answers.jira_connect = undefined;
      form.dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
    }
    await settle();
    assert.ok(!root.classList.contains("jx-detail-open"), `${how} closes the issue`);
    slow.resolve(detailOf("A-1"));
    await settle();
    assert.equal(root.querySelector(".br-full-host").children.length, 0, `${how}: late reply dropped`);
    assert.equal(root.querySelector(".br-full-host").hidden, true, how);
  }
});

test("an error reply and an IPC rejection both show the error state with the right title", async () => {
  await open();
  for (const [kind, title] of [["auth", "Jira Rejected the Token"], ["rate", "Jira Is Rate Limiting"], ["network", "Jira Is Unreachable"], ["endpoint", "Jira Couldn't Load the Issue"], ["site", "Jira Couldn't Load the Issue"], ["unset", "Jira Couldn't Load the Issue"]]) {
    answers.jira_issue = { error: { kind, message: `<b>${kind}</b>` } };
    row().click();
    await settle();
    assert.equal(full().querySelector(".br-err").textContent, title, kind);
    assert.equal(full().querySelector(".br-err b"), null);
    btn("Back to List").click();
  }
  answers.jira_issue = () => { throw new Error("ipc down"); };
  row().click();
  await settle();
  assert.equal(full().querySelector(".br-err").textContent, "Jira Couldn't Load the Issue");
  assert.equal(full().querySelector(".br-err").title, "ipc down");
  assert.equal(loadTitle("whatever"), "Jira Couldn't Load the Issue");
});

test("a section row opens that issue in place; Open in Browser and Send use the open issue", async () => {
  await open();
  const sent = [];
  answers.jira_issue = (args) => { sent.push(args.key); return args.key === "A-9" ? detailOf("A-9", { parent: null, subtasks: [], comments: { total: 0, startAt: 0, items: [] } }) : detailOf("A-1"); };
  row().click();
  await settle();
  const parentRow = [...full().querySelectorAll(".br-row")].find((r) => r.querySelector(".br-key").textContent === "A-9");
  parentRow.click();
  await settle();
  assert.deepEqual(sent, ["A-1", "A-9"]);
  assert.equal(full().dataset.id, "A-9");
  assert.equal(root.querySelectorAll(".br-full").length, 1);
  assert.deepEqual(fields().Type, "Bug", "a related issue takes its Type from the read");
  btn("Open in Browser").click();
  await settle();
  assert.equal(calls("open_url"), 1);
  full().querySelector(".br-act").click();
  await settle();
  assert.deepEqual(globalThis.__jd.written, [["t1", "A-9: Ref A-9"]]);
});

test("Show Older Comments pages by what is shown, maps authors and stops on an empty page", async () => {
  await open();
  const asked = [];
  answers.jira_issue = detailOf("A-1", { comments: { total: 45, startAt: 0, items: cm(20) } });
  answers.jira_comments = (args) => {
    asked.push(args);
    return { comments: { total: 45, startAt: args.startAt, items: args.startAt === 20 ? cm(20, 20) : [] } };
  };
  row().click();
  await settle();
  assert.equal(root.querySelectorAll(".br-cm").length, 20);
  const more = () => [...full().querySelectorAll("button")].find((b) => b.textContent === "Show Older Comments");
  more().click();
  await settle();
  assert.deepEqual(asked, [{ key: "A-1", startAt: 20 }]);
  assert.equal(root.querySelectorAll(".br-cm").length, 40);
  assert.ok(more(), "5 remain by the total");
  more().click();
  await settle();
  assert.deepEqual(asked.map((a) => a.startAt), [20, 40]);
  assert.equal(more(), undefined, "an empty page ends the paging");
});

test("toComments maps the shape, sets more by the total, and stops at an empty page or 200 shown", () => {
  const page = (startAt, n, total) => toComments({ startAt, total, items: cm(n, startAt) });
  const a = page(0, 20, 45);
  assert.equal(a.total, 45);
  assert.equal(a.more, true);
  assert.deepEqual(a.items[0], { author: "Person 0", when: "2026-10-15T09:30:00.000+0000", body: cm(1)[0].body });
  assert.equal(a.items[1].author, "Unknown");
  assert.equal(page(40, 5, 45).more, false, "everything shown");
  assert.equal(page(20, 0, 45).more, false, "an empty page stops");
  assert.equal(page(MAX_COMMENTS - 20, 20, 500).more, false, "200 shown stops");
  assert.equal(page(MAX_COMMENTS - 40, 20, 500).more, true);
  const over = page(180, 100, 500);
  assert.equal(over.items.length, 20, "a page arriving at 180 shown is cut to the 200 allowance");
  assert.equal(over.more, false);
});

test("the status title tooltip no longer tells the row it opens the browser", async () => {
  await open();
  assert.equal(row().title, "");
});
