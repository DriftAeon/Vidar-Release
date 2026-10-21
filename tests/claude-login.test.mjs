// Claude login from the Not Logged In pill (A15): the pill opens the Login Card, Log In runs
// `claude auth login` for the tab's own home (claude_login_run; the env build is a Rust unit test in
// src-tauri/src/claude_login.rs), the exit re-checks `claude auth status` for that home, and Cancel
// ends the spawned login.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const ipc = globalThis.__domMount;
const { claudeLogin, claudeLoginCalls, claudeStatus, tabLogin, CLAUDE_LOGIN_STILL_OUT, CLAUDE_LOGIN_TIMED_OUT, CLAUDE_LOGIN_UNKNOWN } =
  await import("../src/panels/rendered/claude-login.ts");
const { API_KEY_CARD } = await import("../src/panels/rendered/api-key-card.ts");
const { LOGIN_TIP, LOGIN_TIP_NO_CARD, LOGIN_TIP_REFUSED, LOGIN_TIP_GATEWAY, claudeLoginTip: loginTip, claudeReach } =
  await import("../src/panels/rendered/claude-login.ts");
const { createLogin } = await import("../src/panels/rendered/login.ts");
const { createRefusedTransport, createFalconAdoptTransport } = await import("../src/panels/rendered/transport.ts");
const { createStatusBar } = await import("../src/panels/rendered/status-bar.ts");
const { hostHas } = await import("../src/panels/rendered/host-profile.ts");

const labels = (host) => [...host.querySelectorAll("button")].map((b) => b.textContent);
const press = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent === text).click();
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A login whose run resolves when the test says so. */
function harness({ available = true, status = false } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const calls = [];
  let finish;
  let st = status;
  let out = true;
  const login = claudeLogin({
    available,
    loggedOut: () => out,
    run: () => { calls.push("run"); return new Promise((r) => { finish = r; }); },
    cancel: async () => { calls.push("cancel"); finish?.({ code: null, cancelled: true, timedOut: false }); return true; },
    check: async () => { calls.push("check"); return st; },
    mount: (c) => host.append(c),
    loggedIn: () => calls.push("loggedIn"),
  });
  return {
    host, calls, login,
    exit: (e = {}) => finish({ code: 0, cancelled: false, timedOut: false, ...e }),
    setStatus: (v) => { st = v; },
    setLoggedOut: (v) => { out = v; },
    done: () => host.remove(),
  };
}

test("the pill opens one card with one action, in place of the warn tip", () => {
  const h = harness();
  h.host.append(Object.assign(document.createElement("div"), { className: "blk blk-notice warn", textContent: LOGIN_TIP }));
  h.login.open();
  h.login.offer();
  h.login.open();
  assert.equal(h.host.querySelectorAll(`.${API_KEY_CARD}`).length, 1, "a redraw or second press never stacks a card");
  assert.equal(h.host.querySelectorAll(".blk-notice").length, 0, "the tip it replaces is gone");
  assert.equal(h.host.querySelector(".approval-title").textContent, "Log In To Claude");
  assert.deepEqual(labels(h.host), ["Log In"]);
  assert.equal(document.activeElement?.textContent, "Log In");
  assert.deepEqual(h.calls, [], "opening runs nothing");
  h.done();
});

test("the tip points at the pill, not at a terminal", () => {
  assert.match(LOGIN_TIP, /Click Not Logged In in the status bar/);
  assert.doesNotMatch(LOGIN_TIP, /terminal/);
});

test("Log In waits on the login; an exit that the status check says is logged in folds and respawns", async () => {
  const h = harness();
  h.login.open();
  press(h.host, "Log In");
  assert.deepEqual(h.calls, ["run"]);
  assert.match(h.host.textContent, /Waiting For Browser/);
  assert.deepEqual(labels(h.host), ["Cancel"]);
  h.setStatus(true);
  h.exit();
  await tick(); await tick();
  assert.deepEqual(h.calls, ["run", "check", "loggedIn"]);
  assert.equal(h.host.querySelector(".approval-title").textContent, "Logged In");
  assert.deepEqual(labels(h.host), []);
  h.done();
});

test("an exit the status check still calls logged out keeps the card, with the reason", async () => {
  const h = harness();
  h.login.open();
  press(h.host, "Log In");
  h.exit({ code: 1 });
  await tick(); await tick();
  assert.deepEqual(h.calls, ["run", "check"]);
  assert.equal(h.host.querySelector(".approval-why.failed").textContent, CLAUDE_LOGIN_STILL_OUT);
  assert.deepEqual(labels(h.host), ["Log In"], "the action is offered again");
  press(h.host, "Log In");
  h.exit({ timedOut: true });
  await tick(); await tick();
  assert.equal(h.host.querySelector(".approval-why.failed").textContent, CLAUDE_LOGIN_TIMED_OUT);
  h.done();
});

test("Cancel ends the spawned login and returns the action, with no failure line", async () => {
  const h = harness();
  h.login.open();
  press(h.host, "Log In");
  press(h.host, "Cancel");
  assert.deepEqual(labels(h.host), ["Log In"]);
  await tick(); await tick();
  assert.deepEqual(h.calls, ["run", "cancel", "check"]);
  assert.equal(h.host.querySelector(".approval-why.failed"), null);
  assert.ok(!h.calls.includes("loggedIn"));
  h.done();
});

test("a failed start shows its error in the card", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const login = claudeLogin({ available: true, loggedOut: () => true, run: () => Promise.reject("Claude Code was not found; install it, then log in"),
    cancel: async () => true, check: async () => false, mount: (c) => host.append(c), loggedIn: () => assert.fail("not logged in") });
  login.open();
  press(host, "Log In");
  await tick();
  assert.equal(host.querySelector(".approval-why.failed").textContent, "Claude Code was not found; install it, then log in");
  host.remove();
});

test("an unavailable login (no host command, a gateway tab) offers no card", () => {
  const h = harness({ available: false });
  h.login.offer();
  h.login.open();
  assert.equal(h.host.children.length, 0);
  assert.equal(h.login.offered(), false);
  h.done();
});

test("the Tauri calls carry the tab and its profile; status goes to the profile's home", async () => {
  ipc.answers.claude_login_run = (args) => ({ code: 0, cancelled: false, timedOut: false, args });
  ipc.answers.claude_login_cancel = true;
  ipc.answers.claude_auth_status = false;
  ipc.answers.claude_auth_status_bare = true;
  const bare = claudeLoginCalls("tab-1", "bare");
  assert.deepEqual((await bare.run()).args, { tab: "tab-1", profile: "bare" });
  assert.equal(await bare.check(), true);
  const plain = claudeLoginCalls("tab-2", null);
  assert.deepEqual((await plain.run()).args, { tab: "tab-2", profile: null });
  assert.equal(await plain.check(), false);
  ipc.invoked.length = 0;
  await claudeStatus({ profile: "bare" })();
  await claudeStatus({})();
  assert.deepEqual(ipc.invoked, ["claude_auth_status_bare", "claude_auth_status"]);
  await plain.cancel();
  assert.equal(ipc.invoked.at(-1), "claude_login_cancel");
});

test("tabLogin: Claude on a host with the command gets the card; a gateway tab or the Falcon shell does not", () => {
  const base = { sendEncoded: async () => true, mount: () => {}, textarea: document.createElement("textarea"), noticeBlock: () => {},
    loggedIn: () => {}, stopAgent: async () => {}, spawn: async () => {} };
  const S = { adapter: {}, isAlive: false };
  const claude = (host, transport) => tabLogin(S, { ...base, opts: { tabId: "t", agent: "claude" }, transport, hostCan: hostHas(host, "loginRun") });
  assert.equal(claude("vidar-tab", {}).offered(), true);
  assert.equal(claude("vidar-tab", { gateway: "acme" }).offered(), false);
  assert.equal(claude("falcon-shell", {}).offered(), false);
  const codex = tabLogin(S, { ...base, opts: { tabId: "t", agent: "codex" }, transport: {}, hostCan: true });
  assert.equal("offered" in codex, false, "Codex keeps its own login");
});

test("a refused respawn (unknown gateway art) gets no card and runs no login", () => {
  const base = { sendEncoded: async () => true, textarea: document.createElement("textarea"), noticeBlock: () => {},
    loggedIn: () => assert.fail("no login"), stopAgent: async () => assert.fail("no stop"), spawn: async () => assert.fail("no spawn") };
  const host = document.createElement("div");
  document.body.append(host);
  ipc.invoked.length = 0;
  for (const transport of [createRefusedTransport(), createFalconAdoptTransport("sess-1", undefined, undefined, true)]) {
    assert.equal(transport.respawnRefused, true);
    assert.equal(transport.gateway, undefined, "the marker, not a gateway, turns the card off");
    const login = tabLogin({ adapter: {}, isAlive: true, loggedOut: true },
      { ...base, mount: (c) => host.append(c), opts: { tabId: "t", agent: "claude" }, transport, hostCan: true });
    assert.equal(login.offered(), false);
    login.offer(); login.open(); login.chatgpt();
  }
  assert.equal(host.children.length, 0);
  assert.ok(!ipc.invoked.includes("claude_login_run"), "no login run");
  assert.equal(createFalconAdoptTransport("sess-2").respawnRefused, undefined, "a known art keeps its card");
  host.remove();
});

test("a card that folded before the console exits does not respawn", async () => {
  const h = harness();
  h.login.open();
  press(h.host, "Log In");
  h.setLoggedOut(false); // a clean turn cleared it, and the redraw folds the card
  h.login.settle();
  h.setStatus(true);
  h.exit();
  await tick(); await tick();
  assert.deepEqual(h.calls, ["run", "check"], "no respawn");
  h.done();
});

test("a still-open card on a tab no longer logged out folds without a respawn", async () => {
  const h = harness();
  h.login.open();
  press(h.host, "Log In");
  h.setLoggedOut(false);
  h.setStatus(true);
  h.exit();
  await tick(); await tick();
  assert.deepEqual(h.calls, ["run", "check"]);
  assert.equal(h.host.querySelector(".approval-title").textContent, "Logged In");
  h.done();
});

test("an unreadable status after the exit says so, not that the tab is still logged out", async () => {
  const h = harness({ status: null });
  h.login.open();
  press(h.host, "Log In");
  h.exit();
  await tick(); await tick();
  assert.equal(h.host.querySelector(".approval-why.failed").textContent, CLAUDE_LOGIN_UNKNOWN);
  assert.equal(CLAUDE_LOGIN_UNKNOWN, "The login window closed, but Claude Code's login status could not be read.");
  h.done();
});

test("a profile other than bare is refused by the status check without a call", async () => {
  ipc.invoked.length = 0;
  await assert.rejects(claudeLoginCalls("t", "zzz").check(), /zzz/);
  assert.equal(await claudeStatus({ profile: "zzz" })().catch(() => "refused"), "refused");
  assert.deepEqual(ipc.invoked, []);
});

test("dispose ends a running login", async () => {
  const h = harness();
  h.login.open();
  press(h.host, "Log In");
  h.login.dispose();
  await tick(); await tick();
  assert.deepEqual(h.calls, ["run", "cancel", "check"]);
  assert.ok(!h.calls.includes("loggedIn"));
  h.done();
});

const flipTip = (reach) => {
  const notes = [];
  const login = createLogin({ loggedOut: false, disposed: false }, { claude: true, reach, tip: loginTip, check: async () => null,
    noticeBlock: (t) => notes.push(t), redrawStatus() {}, refreshState() {} });
  login.fromAgent(false);
  return notes;
};
const tipFor = (hostCan, transport) => {
  const base = { sendEncoded: async () => true, mount: () => {}, textarea: document.createElement("textarea"), noticeBlock: () => {},
    loggedIn: () => {}, stopAgent: async () => {}, spawn: async () => {} };
  const login = tabLogin({ adapter: {}, isAlive: false, loggedOut: true },
    { ...base, opts: { tabId: "t", agent: "claude" }, transport, hostCan });
  return flipTip(login.reach)[0];
};

test("without the card the tip names no pill and no plain claude auth login", () => {
  assert.equal(loginTip("outside"), LOGIN_TIP_NO_CARD);
  assert.equal(loginTip(), LOGIN_TIP);
  assert.equal(LOGIN_TIP_NO_CARD, "Claude Code is not logged in. Log in to this tab's Claude home outside Vidar, then type /clear here to restart the session.");
  for (const tip of [LOGIN_TIP_NO_CARD, LOGIN_TIP_REFUSED, LOGIN_TIP_GATEWAY]) assert.doesNotMatch(tip, /Click Not Logged In|claude auth login/);
  assert.equal(tipFor(false, {}), LOGIN_TIP_NO_CARD, "a host without the command");
  assert.equal(tipFor(true, {}), LOGIN_TIP, "the card");
});

test("a refused-respawn tab's tip sends the user to a new tab, not /clear", () => {
  assert.equal(LOGIN_TIP_REFUSED, "Claude Code is not logged in. Log in to this tab's Claude home outside Vidar, then open a new tab.");
  assert.equal(tipFor(true, createRefusedTransport()), LOGIN_TIP_REFUSED);
  assert.equal(tipFor(true, createFalconAdoptTransport("sess-1", undefined, undefined, true)), LOGIN_TIP_REFUSED);
  assert.deepEqual(flipTip(() => "refused"), [LOGIN_TIP_REFUSED]);
});

test("a known-gateway tab's tip points at the gateway's key", () => {
  assert.equal(LOGIN_TIP_GATEWAY, "This gateway reports Claude Code is not logged in. Check the gateway's API key.");
  assert.equal(tipFor(true, { gateway: "acme" }), LOGIN_TIP_GATEWAY);
  assert.equal(tipFor(false, { gateway: "acme", respawnRefused: true }), LOGIN_TIP_GATEWAY, "a gateway wins over a refused respawn");
  assert.equal(claudeReach(true, { gateway: "acme" }), "gateway");
});

test("a login that settles after dispose neither folds nor respawns", async () => {
  const h = harness({ status: true });
  h.login.open();
  press(h.host, "Log In");
  h.login.dispose(); // the harness's cancel resolves the run as cancelled, and the check says logged in
  await tick(); await tick();
  assert.ok(!h.calls.includes("loggedIn"), "no respawn");
  assert.notEqual(h.host.querySelector(".approval-title").textContent, "Logged In");
  h.done();
});

test("tabLogin respawns after a Claude login: stop a live process, then spawn", async () => {
  const order = [];
  const host = document.createElement("div");
  document.body.append(host);
  ipc.answers.claude_login_run = { code: 0, cancelled: false, timedOut: false };
  ipc.answers.claude_auth_status = true;
  const S = { adapter: {}, isAlive: true, loggedOut: true };
  const login = tabLogin(S, { sendEncoded: async () => true, mount: (c) => host.append(c), textarea: document.createElement("textarea"),
    noticeBlock: (t) => order.push(`notice:${t}`), opts: { tabId: "t", agent: "claude" }, transport: {}, hostCan: true,
    loggedIn: () => order.push("loggedIn"), stopAgent: async () => { order.push("stop"); }, spawn: async () => { order.push("spawn"); } });
  login.open();
  press(host, "Log In");
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(order, ["loggedIn", "stop", "spawn"]);
  host.remove();
});

test("the Claude pill, logged out, opens the card even with no live process", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const login = claudeLogin({ available: true, loggedOut: () => true, run: () => new Promise(() => {}), cancel: async () => true,
    check: async () => false, mount: (c) => host.append(c), loggedIn: () => {} });
  const S = { adapter: {}, isAlive: false, loggedOut: true, inTurn: false, mode: "default", models: [], modelPending: null,
    characterModel: null, characterModelLive: false };
  let menu = null;
  const bar = createStatusBar(S, { opts: { agent: "claude", cwd: "C:/work", effort: null }, send: async () => true,
    noticeBlock: () => {}, refreshState() {}, emitCharacterStatus() {}, textarea: document.createElement("textarea"),
    openStMenu: (_a, items) => { menu = items; }, login });
  bar.redrawStatus();
  assert.equal(host.querySelectorAll(`.${API_KEY_CARD}`).length, 1, "the redraw offers the card while logged out");
  host.replaceChildren(); // a /clear drops it
  bar.pickModelMenu();
  assert.equal(menu, null, "no model or ChatGPT menu");
  assert.equal(host.querySelectorAll(`.${API_KEY_CARD}`).length, 1, "the press brings the card back");
  S.loggedOut = false;
  bar.redrawStatus();
  assert.equal(host.querySelector(".approval-title").textContent, "Logged In", "a flip to logged in folds it");
  host.remove();
});
