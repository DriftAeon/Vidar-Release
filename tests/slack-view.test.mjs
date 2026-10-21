// Slack bench tab view contract (panels/slack.ts, slack/view.ts): the token goes only to slack_connect and
// the field empties, remote text renders as text, Send types into the focused tab, and 50+ when truncated.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

const dom = setupDom({
  stubs: {
    prefs: `export function getPref(k) { return globalThis.__slack.prefs[k]; }
      export function setPref(k, v) { globalThis.__slack.prefs[k] = v; return true; }`,
    clipboard: `export async function copyText(t) { globalThis.__slack.copied.push(t); return true; }`,
    "panels/sessions": `export async function writeToSession(id, text) { globalThis.__slack.written.push([id, text]); return true; }`,
    "panels/sessions/lookup": `export function getFocusedSession() { return globalThis.__slack.focused; }`,
  },
});
globalThis.__slack = { prefs: {}, written: [], copied: [], focused: { id: "t1" } };
const { mountSlackView, onSlackShown, onSlackHidden, disposeSlackView } = await import("../src/panels/slack.ts");
const { SLACK_MANIFEST } = await import("../src/slack/manifest.ts");

const answers = dom.ipc.answers;
const UNSET = { host: null, tokenSaved: false };
const SAVED = { host: "acme.slack.com", tokenSaved: true };
const ITEM = { id: "C1:1760000000.000100", kind: "mention", sender: "Ana", channel: "#dev", text: "<b>ping</b> me", ts: "1760000000.000100", url: "https://acme.slack.com/archives/C1/p1760000000000100" };
const calls = () => dom.ipc.invoked;
let root;

async function open(status, inbox = { items: [], truncated: false }) {
  disposeSlackView();
  dom.ipc.invoked.length = 0;
  globalThis.__slack.written.length = 0;
  globalThis.__slack.copied.length = 0;
  answers.slack_status = status;
  answers.slack_inbox = inbox;
  answers.slack_connect = undefined;
  answers.slack_disconnect = undefined;
  answers.open_url = undefined;
  root = mountSlackView(document.body);
  onSlackShown();
  for (let i = 0; i < 6; i++) await dom.flush();
}
const text = (sel) => [...root.querySelectorAll(sel)].map((n) => n.textContent);
const btn = (label) => [...root.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
const tokenField = () => root.querySelector('input[aria-label="User OAuth Token"]');
async function submitToken(value) {
  tokenField().value = value;
  root.querySelector("form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  for (let i = 0; i < 8; i++) await dom.flush();
}
const formVisible = () => !root.querySelector("form").hidden;

test("unset status shows the notice with Connect and Hide, not the form", async () => {
  await open(UNSET);
  assert.deepEqual(text(".es-title"), ["Slack Not Connected"]);
  assert.ok(btn("Connect") && btn("Hide"));
  assert.equal(formVisible(), false);
  assert.ok(!calls().includes("slack_inbox"), "no request while unset");
});

test("Connect opens the form and Cancel returns to the notice", async () => {
  await open(UNSET);
  btn("Connect").click();
  assert.equal(formVisible(), true);
  assert.deepEqual(text(".jx-form-title"), ["Connect Slack"]);
  assert.equal(tokenField().type, "password");
  assert.equal(tokenField().placeholder, "Token");
  assert.ok(btn("Copy App Manifest") && btn("Open Slack Apps"));
  btn("Cancel").click();
  assert.equal(formVisible(), false);
});

test("Copy App Manifest copies the manifest and Open Slack Apps opens the apps page", async () => {
  await open(UNSET);
  btn("Connect").click();
  const opened = [];
  answers.open_url = (a) => { opened.push(a.url); };
  btn("Copy App Manifest").click();
  btn("Open Slack Apps").click();
  for (let i = 0; i < 4; i++) await dom.flush();
  assert.deepEqual(globalThis.__slack.copied, [SLACK_MANIFEST]);
  assert.deepEqual(text(".jx-form > .jx-note"), ["Manifest copied."]);
  assert.deepEqual(opened, ["https://api.slack.com/apps"]);
});

test("Hide writes bench:slack to modules.hidden", async () => {
  await open(UNSET);
  globalThis.__slack.prefs["modules.hidden"] = ["bench:jira"];
  btn("Hide").click();
  assert.deepEqual(globalThis.__slack.prefs["modules.hidden"], ["bench:jira", "bench:slack"]);
});

test("a token without the xoxp- prefix is refused before any request", async () => {
  await open(UNSET);
  btn("Connect").click();
  await submitToken("xoxb-nope");
  assert.ok(!calls().includes("slack_connect"));
  assert.equal(root.querySelector(".cx-note-msg").textContent, "Paste the User OAuth Token, which starts with xoxp-.");
  assert.equal(tokenField().value, "");
});

test("the token goes only to slack_connect and the field empties", async () => {
  await open(UNSET);
  btn("Connect").click();
  const sent = [];
  answers.slack_connect = (args) => { sent.push(args); return { host: "acme.slack.com" }; };
  answers.slack_inbox = { items: [ITEM], truncated: false };
  await submitToken("xoxp-secret");
  assert.deepEqual(sent, [{ token: "xoxp-secret" }]);
  assert.equal(tokenField().value, "");
  assert.ok(!root.outerHTML.includes("xoxp-secret"), "no token text anywhere in the DOM");
  assert.deepEqual(text(".sx-from"), ["Ana"]);
  // and after a refusal from Rust
  await open(UNSET);
  btn("Connect").click();
  answers.slack_connect = { error: { kind: "auth", message: "invalid_auth" } };
  await submitToken("xoxp-secret");
  assert.equal(tokenField().value, "");
  assert.ok(!root.outerHTML.includes("xoxp-secret"));
  assert.equal(root.querySelector(".cx-note-msg").textContent, "Slack Rejected the Token");
});

test("remote text renders as text", async () => {
  await open(SAVED, { items: [ITEM], truncated: false });
  const summary = root.querySelector(".sx-summary");
  assert.equal(summary.textContent, "<b>ping</b> me");
  assert.equal(summary.children.length, 0);
  assert.equal(root.querySelector(".cx-list b"), null);
  assert.equal(text(".sx-conv-name")[0], "dev");
  assert.equal(root.querySelector(".sx-time").textContent.includes("#dev"), false);
});

test("the head draws no count, truncated or not", async () => {
  await open(SAVED, { items: [ITEM], truncated: true });
  assert.deepEqual(text(".jx-count"), []);
  await open(SAVED, { items: [ITEM], truncated: false });
  assert.deepEqual(text(".jx-count"), []);
});

const mk = (id, place, channel, sender, ts) => ({ id: `${id}:${ts}`, kind: "mention", place, sender, channel, text: "hi", ts, url: "" });
const MIXED = [
  mk("D1", "dm", "DM", "Ada", "1760000300.000100"),
  mk("G2", "group", "Group DM", "Bo", "1760000200.000100"),
  mk("C1", "channel", "#dev", "Unknown", "1760000100.000100"),
  mk("C2", "private", "#ops", "Cy", "1760000250.000100"),
];

test("rows group into Direct Messages and Channels with heads, avatars and a lock", async () => {
  globalThis.__slack.prefs = {};
  await open(SAVED, { items: MIXED, truncated: false });
  assert.deepEqual(text(".cx-sec-label"), ["Direct Messages", "Channels"]);
  assert.deepEqual(text(".sx-conv-name"), ["ops", "dev"]);
  assert.equal(root.querySelector(".sx-group").dataset.place, "dm");
  assert.deepEqual([...root.querySelectorAll(".sx-conv")].map((c) => c.dataset.place), ["private", "channel"]);
  const heads = [...root.querySelectorAll(".sx-conv")];
  assert.equal(heads.length, 2);
  assert.equal(heads[0].querySelectorAll("svg").length, 1);
  assert.deepEqual(text(".sx-from"), ["Ada", "Bo", "Cy", "Unknown"]);
  const avs = [...root.querySelectorAll(".sx-av")];
  assert.equal(avs[0].textContent, "A");
  assert.ok(avs[1].querySelector("svg"), "group row draws the users glyph");
  assert.ok(avs[3].querySelector("svg"), "Unknown draws the user glyph");
  assert.equal(root.querySelectorAll(".sx-dot-new").length, 0, "no pref, nothing new");
});

test("rows newer than slack.seen carry the New dot with its name and tooltip", async () => {
  globalThis.__slack.prefs = { "slack.seen": "1760000200.000100" };
  await open(SAVED, { items: MIXED, truncated: false });
  const dots = [...root.querySelectorAll(".sx-dot-new")];
  assert.equal(dots.length, 2);
  assert.equal(dots[0].getAttribute("aria-label"), "New");
  assert.equal(dots[0].title, "New since you last opened this tab.");
  assert.equal(root.querySelectorAll(".sx-dot").length, 4, "every row keeps the slot");
});

test("hiding writes the newest ts once, and an older or empty view never moves it back", async () => {
  globalThis.__slack.prefs = {};
  await open(SAVED, { items: MIXED, truncated: false });
  onSlackHidden();
  assert.equal(globalThis.__slack.prefs["slack.seen"], "1760000300.000100");
  await open(SAVED, { items: [mk("C1", "channel", "#dev", "Ana", "1760000100.000100")], truncated: false });
  onSlackHidden();
  assert.equal(globalThis.__slack.prefs["slack.seen"], "1760000300.000100", "older refresh keeps the newer mark");
  await open(SAVED, { error: { kind: "network", message: "x" } });
  onSlackHidden();
  await open(SAVED, { items: [], truncated: false });
  onSlackHidden();
  assert.equal(globalThis.__slack.prefs["slack.seen"], "1760000300.000100", "error and empty write nothing");
  globalThis.__slack.prefs = {};
  await open(SAVED, { error: { kind: "network", message: "x" } });
  onSlackHidden();
  assert.equal(globalThis.__slack.prefs["slack.seen"], undefined);
});

test("Send types into the focused tab, or says there is none", async () => {
  await open(SAVED, { items: [ITEM], truncated: false });
  btn("Send").click();
  for (let i = 0; i < 4; i++) await dom.flush();
  assert.deepEqual(globalThis.__slack.written, [["t1", "@Ana in #dev: <b>ping</b> me"]]);
  assert.equal(root.querySelector(".jx-note").hidden, true);
  globalThis.__slack.focused = null;
  btn("Send").click();
  for (let i = 0; i < 4; i++) await dom.flush();
  assert.equal(globalThis.__slack.written.length, 1);
  assert.equal(root.querySelector(".jx-note").textContent, "No tab to type into.");
  globalThis.__slack.focused = { id: "t1" };
});

test("a failed load shows the title for its kind, the message in the tooltip", async () => {
  const titles = { auth: "Slack Rejected the Token", scope: "Slack Is Missing a Scope", rate: "Slack Is Rate Limiting", network: "Slack Is Unreachable", endpoint: "Slack Couldn't Load the Inbox" };
  for (const [kind, title] of Object.entries(titles)) {
    await open(SAVED, { error: { kind, message: "connection changed, try again" } });
    assert.deepEqual(text(".cx-empty-title"), [title], kind);
    assert.equal(root.querySelector(".cx-empty").title, "connection changed, try again");
  }
  await open(SAVED, { items: [], truncated: false });
  assert.deepEqual(text(".cx-empty-title"), ["No Recent Mentions or DMs"]);
});
