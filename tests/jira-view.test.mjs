// Jira bench tab view contract (panels/jira.ts, jira/view.ts): the unset notice and the Connect form, the
// Hide write, remote text as text, and the token's life (never in the DOM after submit, never kept).
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    prefs: `export function getPref(k) { return globalThis.__jira.prefs[k]; }
      export function setPref(k, v) { globalThis.__jira.prefs[k] = v; return true; }`,
    "panels/sessions": `export async function writeToSession(id, text) { globalThis.__jira.written.push([id, text]); return true; }`,
    "panels/sessions/lookup": `export function getFocusedSession() { return globalThis.__jira.focused; }`,
  },
});
globalThis.__jira = { prefs: {}, written: [], focused: { id: "t1" } };
const { mountJiraView, onJiraShown, disposeJiraView } = await import("../src/panels/jira.ts");

const answers = dom.ipc.answers;
const UNSET = { site: null, email: null, jql: null, tokenSaved: false };
const SAVED = { site: "https://acme.atlassian.net", email: "me@acme.test", jql: null, tokenSaved: true };
const ISSUE = { key: "ABC-1", summary: "<img src=x onerror=alert(1)> broken", status: "To Do", statusCategory: "new", type: "Bug", priority: "High", updated: "2026-10-16T00:00:00Z", url: "https://acme.atlassian.net/browse/ABC-1", typeLevel: 0, parent: "" };
const calls = () => dom.ipc.invoked;
let root;

async function open(status, issues = { issues: [] }) {
  disposeJiraView();
  dom.ipc.invoked.length = 0;
  answers.jira_status = status;
  answers.jira_issues = issues;
  answers.patch_settings = undefined;
  answers.jira_connect = undefined;
  answers.jira_disconnect = undefined;
  answers.open_url = undefined;
  root = mountJiraView(document.body);
  onJiraShown();
  for (let i = 0; i < 6; i++) await dom.flush();
}
const text = (sel) => [...root.querySelectorAll(sel)].map((n) => n.textContent);
const btn = (label) => [...root.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
const field = (label) => root.querySelector(`input[aria-label="${label}"]`);
async function submitForm(values) {
  for (const [label, value] of Object.entries(values)) field(label).value = value;
  root.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  for (let i = 0; i < 8; i++) await dom.flush();
}
const formVisible = () => !root.querySelector("form").hidden;

test("unset status shows the notice with Connect and Hide, not the form", async () => {
  await open(UNSET);
  assert.deepEqual(text(".es-title"), ["Jira Not Connected"]);
  assert.ok(btn("Connect") && btn("Hide"));
  assert.equal(btn("Hide").title, "Hide", "Hide is the icon button with a tooltip");
  assert.ok(btn("Connect").classList.contains("ws-add"), "Connect wears the green approve look");
  assert.equal(formVisible(), false);
  assert.ok(!calls().includes("jira_issues"), "no request while unset");
});

test("a saved token for another site reads as unset", async () => {
  await open({ ...SAVED, tokenSaved: false });
  assert.deepEqual(text(".es-title"), ["Jira Not Connected"]);
});

test("Connect opens the form with four fields and Cancel returns to the notice", async () => {
  await open(UNSET);
  btn("Connect").click();
  assert.equal(formVisible(), true);
  assert.deepEqual(text(".jx-form-title"), ["Connect Jira"]);
  assert.deepEqual([...root.querySelectorAll("form input")].map((i) => i.getAttribute("aria-label")), ["Site", "Email", "API Token", "JQL"]);
  assert.equal(field("API Token").type, "password");
  assert.equal(root.querySelector(".cx-empty").hidden, true);
  btn("Cancel").click();
  assert.equal(formVisible(), false);
  assert.deepEqual(text(".es-title"), ["Jira Not Connected"]);
});

test("Hide writes bench:jira to modules.hidden", async () => {
  await open(UNSET);
  globalThis.__jira.prefs["modules.hidden"] = ["bench:unreal"];
  let fired = 0;
  document.addEventListener("vidar-modules-change", () => fired++);
  btn("Hide").click();
  assert.deepEqual(globalThis.__jira.prefs["modules.hidden"], ["bench:unreal", "bench:jira"]);
  assert.equal(fired, 1);
});

test("issue summary markup renders as text", async () => {
  await open(SAVED, { issues: [ISSUE] });
  const summary = root.querySelector(".jx-summary");
  assert.equal(summary.textContent, ISSUE.summary);
  assert.equal(root.querySelector(".cx-list img:not(.icn)"), null, "only the app's own icon images");
  assert.equal(summary.children.length, 0);
});

test("a failed load shows the D9 title for its kind", async () => {
  const titles = { jql: "Jira Rejected the JQL", network: "Jira Is Unreachable", rate: "Jira Is Rate Limiting", endpoint: "Jira Couldn't Load the Issues", auth: "Jira Rejected the Token" };
  for (const [kind, title] of Object.entries(titles)) {
    await open(SAVED, { error: { kind, message: "<b>x</b>" } });
    assert.deepEqual(text(".cx-empty-title"), [title], kind);
  }
  await open(SAVED, { issues: [] });
  assert.deepEqual(text(".cx-empty-title"), ["No Issues Match"]);
});

test("an auth failure on connect disconnects and keeps the form", async () => {
  await open(UNSET);
  btn("Connect").click();
  answers.patch_settings = undefined;
  answers.jira_connect = undefined;
  answers.jira_disconnect = undefined;
  answers.jira_issues = { error: { kind: "auth", message: "HTTP 401" } };
  await submitForm({ Site: "acme", Email: "me@acme.test", "API Token": "tok-secret", JQL: "project = ABC" });
  assert.deepEqual(calls().filter((c) => c.startsWith("jira_") || c === "patch_settings"), ["jira_status", "patch_settings", "jira_connect", "jira_issues", "jira_disconnect"]);
  assert.equal(formVisible(), true);
  assert.equal(root.querySelector(".cx-note-msg").textContent, "Jira Rejected the Token");
  assert.equal(field("Site").value, "acme", "typed values stay");
  assert.equal(field("JQL").value, "project = ABC");
});

test("the token field is empty after connect", async () => {
  await open(UNSET);
  btn("Connect").click();
  const sent = [];
  answers.jira_connect = (args) => { sent.push(args); };
  answers.jira_issues = { issues: [ISSUE] };
  await submitForm({ Site: "acme.atlassian.net", Email: "me@acme.test", "API Token": "tok-secret", JQL: "" });
  assert.equal(sent[0].token, "tok-secret", "the token went to jira_connect");
  assert.equal(field("API Token").value, "");
  assert.ok(!root.outerHTML.includes("tok-secret"), "no token text anywhere in the DOM");
  assert.equal(text(".jx-key")[0], "ABC-1", "connected view shows the issues");
  // and after a failure
  await open(UNSET);
  btn("Connect").click();
  answers.jira_issues = { error: { kind: "network", message: "down" } };
  await submitForm({ Site: "acme", Email: "me@acme.test", "API Token": "tok-secret", JQL: "" });
  assert.equal(field("API Token").value, "");
  assert.ok(!root.outerHTML.includes("tok-secret"));
});

test("a non-auth error after connect shows the connected view, not the form", async () => {
  for (const [kind, title] of [["jql", "Jira Rejected the JQL"], ["network", "Jira Is Unreachable"], ["rate", "Jira Is Rate Limiting"], ["endpoint", "Jira Couldn't Load the Issues"]]) {
    await open(UNSET);
    btn("Connect").click();
    answers.jira_issues = { error: { kind, message: "<b>x</b>" } };
    await submitForm({ Site: "acme", Email: "me@acme.test", "API Token": "tok-secret", JQL: "project = ABC" });
    assert.equal(formVisible(), false, kind);
    assert.equal(root.querySelector(".cx-head").hidden, false, kind);
    assert.deepEqual(text(".cx-empty-title"), [title], kind);
    assert.ok(btn("Refresh") && btn("Disconnect"), kind);
    assert.ok(!calls().includes("jira_disconnect"), `${kind} keeps the credential`);
  }
});

test("a site refusal shows the atlassian address note; a Rust site error the endpoint title", async () => {
  await open(UNSET);
  btn("Connect").click();
  await submitForm({ Site: "evil.example.com/x", Email: "me@acme.test", "API Token": "t", JQL: "" });
  assert.equal(root.querySelector(".cx-note-msg").textContent, "Use a name.atlassian.net address.");
  assert.ok(!calls().includes("jira_connect"), "refused before any write");
  await open(UNSET);
  btn("Connect").click();
  answers.jira_issues = { error: { kind: "site", message: "HTTP 404" } };
  await submitForm({ Site: "acme", Email: "me@acme.test", "API Token": "t", JQL: "" });
  assert.equal(formVisible(), false);
  assert.deepEqual(text(".cx-empty-title"), ["Jira Couldn't Load the Issues"]);
});

test("the default JQL is saved as an empty string", async () => {
  await open(UNSET);
  btn("Connect").click();
  const patched = [];
  answers.patch_settings = (args) => { patched.push(args); };
  answers.jira_issues = { issues: [] };
  const prefilled = field("JQL").value;
  assert.ok(prefilled.length > 0, "the form prefills the default");
  await submitForm({ Site: "acme", Email: "me@acme.test", "API Token": "t" });
  assert.deepEqual(patched, [{ key: "jira", value: { site: "https://acme.atlassian.net", jql: "" } }]);
});

test("loading draws the head with Refresh busy", async () => {
  await open(SAVED, () => new Promise(() => {}));
  const head = root.querySelector(".cx-head");
  assert.equal(head.hidden, false);
  assert.equal(btn("Refresh").getAttribute("aria-busy"), "true");
  assert.equal(root.querySelector(".cx-empty").hidden, true);
  assert.equal(formVisible(), false);
  await open(SAVED, { issues: [ISSUE] });
  assert.equal(btn("Refresh").hasAttribute("aria-busy"), false, "loaded clears busy");
});

test("Enter on a focused row opens the issue in the module", async () => {
  answers.jira_issue = { error: { kind: "endpoint", message: "x" } };
  await open(SAVED, { issues: [ISSUE] });
  const row = root.querySelector(".cx-row");
  assert.equal(row.tabIndex, 0);
  row.focus();
  dom.ipc.invoked.length = 0;
  btn("Send").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.ok(!calls().includes("jira_issue"), "Enter on Send does not open");
  row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await dom.flush();
  assert.deepEqual(calls(), ["jira_issue"]);
  assert.ok(!calls().includes("open_url"), "the browser opens only from Open in Browser");
});

test("status labels are Title Case, tones follow the category key, unknown keys are neutral", async () => {
  const { statusLabel, statusTone } = await import("../src/jira/model.ts");
  assert.equal(statusLabel("Ready-triage"), "Ready Triage");
  assert.equal(statusLabel("ready_for_QA"), "Ready for QA");
  assert.equal(statusLabel("IN PROGRESS"), "In Progress");
  assert.equal(statusLabel("  in   review "), "In Review");
  assert.equal(statusLabel("UAT Passed"), "UAT Passed");
  assert.equal(statusTone("new", "To Do"), "todo");
  assert.equal(statusTone("done", "Done"), "done");
  assert.equal(statusTone("indeterminate", "In Progress"), "progress");
  assert.equal(statusTone("indeterminate", "Code Review"), "review");
  assert.equal(statusTone("indeterminate", "Blocked"), "blocked");
  assert.equal(statusTone("undefined", "x"), "neutral");
  assert.equal(statusTone("future-key", "x"), "neutral");
  assert.equal(statusTone("", "x"), "neutral");
});

test("a row status is a toned pill with the label and the raw name as its tooltip", async () => {
  await open(SAVED, { issues: [{ ...ISSUE, status: "Ready-triage", statusCategory: "indeterminate" }, { ...ISSUE, key: "ABC-2", status: "Done", statusCategory: "done" }] });
  const pills = [...root.querySelectorAll(".cx-row .br-pill")];
  assert.deepEqual(pills.map((p) => [p.textContent, p.title, p.className]), [
    ["Ready Triage", "Ready-triage", "br-pill tone-progress"],
    ["Done", "Done", "br-pill tone-done"],
  ]);
  assert.equal(root.querySelector(".jx-status"), null);
});

test("the scope buttons and pickers wear the Sheen face; the head icons stay flat as Slack's do", async () => {
  await open(SAVED, { issues: [ISSUE] });
  for (const sel of [".jx-scope-btn", ".jx-pick"]) {
    assert.ok(root.querySelector(sel).classList.contains("wb-card-btn"), sel);
  }
  for (const sel of ['button[aria-label="Refresh"]', 'button[aria-label="Disconnect"]', ".cx-ra"]) {
    assert.ok(!root.querySelector(sel).classList.contains("wb-card-btn"), `${sel} stays flat`);
  }
});

test("Send types the key and summary into the focused tab, and says so when there is none", async () => {
  await open(SAVED, { issues: [ISSUE] });
  globalThis.__jira.written.length = 0;
  btn("Send").click();
  await dom.flush();
  assert.deepEqual(globalThis.__jira.written, [["t1", `ABC-1: ${ISSUE.summary}`]]);
  globalThis.__jira.focused = null;
  btn("Send").click();
  await dom.flush();
  assert.equal(root.querySelector(".jx-note").textContent, "No tab to type into.");
  globalThis.__jira.focused = { id: "t1" };
});
