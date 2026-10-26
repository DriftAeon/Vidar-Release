// Jira bench filter bar (jira/filters.ts, jira/model.ts, panels/jira.ts): the Filters payload, the caps, which
// controls show per scope, option lists failing apart, the search debounce, Clear Filters and stale replies (plan D6).
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
const model = await import("../src/jira/model.ts");
const { mountJiraView, onJiraShown, disposeJiraView } = await import("../src/panels/jira.ts");

const answers = dom.ipc.answers;
const SAVED = { site: "https://acme.atlassian.net", email: "me@acme.test", jql: null, tokenSaved: true };
const CUSTOM = { ...SAVED, jql: "project = DEMO ORDER BY created DESC" };
const mk = (key) => ({ key, summary: `Summary ${key}`, status: "To Do", statusCategory: "new", type: "Task", priority: "", updated: "", url: `https://acme.atlassian.net/browse/${key}`, typeLevel: 0, parent: "" });
const TYPES = { types: [{ name: "Epic", level: 1 }, { name: "Bug", level: 0 }, { name: "Task", level: 0 }] };
const PROJECTS = { projects: [{ key: "DEMO", name: "Demo" }, { key: "OPS", name: "Operations" }] };
let root;
let issueCalls;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 8; i++) await dom.flush(); }
async function open({ saved = SAVED, scope = "mine", types = TYPES, projects = PROJECTS, issues } = {}) {
  disposeJiraView();
  issueCalls = [];
  answers.jira_status = saved;
  answers.jira_issues = issues ?? ((args) => { issueCalls.push(args); return { issues: [mk("A-1")], nextPageToken: null }; });
  answers.jira_types = types;
  answers.jira_projects = projects;
  root = mountJiraView(document.body);
  onJiraShown();
  await settle();
  if (scope === "all") { scopeBtn("All").click(); await settle(); }
}
const scopeBtn = (label) => [...root.querySelectorAll(".jx-scope button")].find((b) => b.getAttribute("aria-label") === label);
const pick = (label) => [...root.querySelectorAll(".jx-pick")].find((b) => b.querySelector(".jx-pick-label").textContent === label);
const visible = () => [...root.querySelectorAll(".jx-pick")].filter((b) => !b.hidden).map((b) => b.querySelector(".jx-pick-label").textContent);
const pop = () => document.querySelector(".jx-pop");
const opt = (label) => [...pop().querySelectorAll(".jx-opt")].find((b) => b.querySelector(".jx-opt-label").textContent === label);
const clearBtn = () => root.querySelector(".jx-filters .jx-clear");
const input = () => root.querySelector(".jx-search-in");
const lastFilters = () => issueCalls.at(-1).filters;
function type(text) {
  input().value = text;
  input().dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("filter state becomes the Filters payload, null when nothing applies", () => {
  const f = { ...model.blankFilters(), projects: ["DEMO"], types: ["Bug"], categories: [2, 4], assignee: "me", text: "login" };
  assert.deepEqual(model.toFilters(f, "all", true), f);
  assert.equal(model.toFilters(model.blankFilters(), "all", false), null);
  assert.equal(model.toFilters({ ...model.blankFilters(), text: "   " }, "all", false), null, "blank text is no filter");
  assert.deepEqual(model.toFilters(f, "mine", true), { ...f, projects: [], assignee: "any" }, "Project and Assignee drop on Mine with a blank JQL");
  assert.deepEqual(model.toFilters(f, "mine", false), { ...f, projects: [] }, "a custom JQL keeps Assignee");
  assert.equal(model.toFilters({ ...model.blankFilters(), text: "x".repeat(300) }, "all", false).text.length, 200);
});

test("the picks are capped at 20 and a 21st is refused", () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `P${i}`);
  assert.deepEqual(model.togglePick(twenty, "P20"), twenty);
  assert.deepEqual(model.togglePick(twenty, "P3").length, 19, "a pick can still be removed at the cap");
  assert.deepEqual(model.sortTypes([{ name: "Task", level: 0 }, { name: "Epic", level: 1 }, { name: "Bug", level: 0 }, { name: "Bug", level: 0 }]).map((t) => t.name), ["Epic", "Bug", "Task"]);
});

test("the bar stops the 21st pick and caps the search text at 200", async () => {
  const many = { types: Array.from({ length: 21 }, (_, i) => ({ name: `Type ${String(i).padStart(2, "0")}`, level: 0 })) };
  await open({ types: many });
  pick("Type").click();
  for (let i = 0; i < 20; i++) { opt(`Type ${String(i).padStart(2, "0")}`).click(); await settle(); }
  assert.equal(opt("Type 20").disabled, true, "no 21st pick");
  assert.equal(opt("Type 00").disabled, false, "a made pick can be unmade");
  assert.equal(lastFilters().types.length, 20);
  assert.equal(input().maxLength, 200);
  type("y".repeat(300));
  await sleep(450);
  await settle();
  assert.ok(lastFilters().text.length <= 200);
});

test("Project shows on All only, Assignee is hidden on Mine with a blank saved JQL", async () => {
  await open();
  assert.deepEqual(visible(), ["Type", "Status"], "Mine, blank JQL: Type, Status (and Search)");
  assert.ok(root.querySelector(".jx-search-in"));
  scopeBtn("All").click();
  await settle();
  assert.deepEqual(visible(), ["Project", "Type", "Status", "Assignee"]);
  await open({ saved: CUSTOM });
  assert.deepEqual(visible(), ["Type", "Status", "Assignee"], "Mine with a custom JQL keeps Assignee");
  assert.equal(pick("Status").title, "Narrows your saved query; it can't add statuses the query leaves out.");
  scopeBtn("All").click();
  await settle();
  assert.equal(pick("Status").title, "", "the tooltip belongs to the saved query only");
});

test("a scope change keeps the filters that apply and drops Project on Mine", async () => {
  await open({ saved: CUSTOM, scope: "all" });
  pick("Project").click();
  opt("Demo").click();
  await settle();
  pick("Status").click();
  opt("Done").click();
  await settle();
  assert.deepEqual(lastFilters().projects, ["DEMO"]);
  scopeBtn("Mine").click();
  await settle();
  assert.deepEqual(lastFilters(), { ...model.blankFilters(), categories: [3] });
});

test("a failed list disables only its own picker and leaves the issue list alone", async () => {
  await open({ scope: "all", types: { error: { kind: "endpoint", message: "no" } } });
  assert.equal(pick("Type").disabled, true);
  assert.equal(pick("Type").title, "Couldn't load this list from Jira.");
  assert.equal(pick("Project").disabled, false);
  assert.equal(pick("Status").disabled, false);
  assert.equal(root.querySelectorAll(".jx-key").length, 1, "the list is untouched");
  assert.equal(root.querySelector(".cx-empty").hidden, true, "and shows no error");

  await open({ scope: "all", projects: () => { throw new Error("bad payload"); } }); // a rejected invoke
  assert.equal(pick("Project").disabled, true);
  assert.equal(pick("Project").title, "Couldn't load this list from Jira.");
  assert.equal(pick("Type").disabled, false);
  assert.equal(root.querySelectorAll(".jx-key").length, 1);
});

test("a pick reloads page 1 with the filters", async () => {
  await open({ scope: "all" });
  const before = issueCalls.length;
  pick("Status").click();
  opt("In Progress").click();
  await settle();
  assert.equal(issueCalls.length, before + 1);
  assert.deepEqual(lastFilters().categories, [4]);
  assert.equal(pick("Status").querySelector(".jx-n").hidden, true, "no count after the label");
  assert.ok(pick("Status").classList.contains("set"), "the accent edge marks the set pick");
});

test("Search fires 400 ms after typing stops, and at once on Enter", async () => {
  await open();
  const before = issueCalls.length;
  type("lo");
  type("login");
  await sleep(150);
  assert.equal(issueCalls.length, before, "nothing fires while typing");
  await sleep(350);
  await settle();
  assert.equal(issueCalls.length, before + 1, "one reload for the burst");
  assert.equal(lastFilters().text, "login");
  type("logout");
  input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.equal(issueCalls.length, before + 2);
  assert.equal(lastFilters().text, "logout");
  await sleep(450);
  await settle();
  assert.equal(issueCalls.length, before + 2, "the debounce was cancelled by Enter");
});

test("Clear Filters is disabled when nothing is set, then resets every filter and reloads", async () => {
  await open({ scope: "all" });
  assert.equal(clearBtn().textContent, "Clear Filters");
  assert.equal(clearBtn().disabled, true);
  pick("Type").click();
  opt("Bug").click();
  await settle();
  type("abc");
  input().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  assert.equal(clearBtn().disabled, false);
  const before = issueCalls.length;
  clearBtn().click();
  await settle();
  assert.equal(issueCalls.length, before + 1);
  assert.equal(lastFilters(), null, "nothing set sends no filters");
  assert.equal(input().value, "");
  assert.equal(pick("Type").querySelector(".jx-n").hidden, true);
  assert.equal(clearBtn().disabled, true);
  assert.equal(pop(), null, "the popover closes");
});

test("a filter change drops the stale page reply", async () => {
  const slow = deferred();
  await open({ scope: "all", issues: (args) => (args.filters ? { issues: [mk("NEW-1")], nextPageToken: null } : slow.promise) });
  pick("Status").click();
  opt("Done").click();
  await settle();
  assert.deepEqual([...root.querySelectorAll(".jx-key")].map((n) => n.textContent), ["NEW-1"]);
  slow.resolve({ issues: [mk("OLD-1")], nextPageToken: null });
  await settle();
  assert.deepEqual([...root.querySelectorAll(".jx-key")].map((n) => n.textContent), ["NEW-1"]);
});

test("the popover sits fixed on body and closes on Escape", async () => {
  await open({ scope: "all" });
  pick("Assignee").click();
  assert.equal(pop().parentElement, document.body);
  assert.deepEqual([...pop().querySelectorAll(".jx-opt-label")].map((n) => n.textContent), ["Anyone", "Me", "Unassigned"]);
  opt("Me").click();
  await settle();
  assert.equal(pop(), null, "a single select closes on pick");
  assert.equal(lastFilters().assignee, "me");
  pick("Type").click();
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(pop(), null);
});
