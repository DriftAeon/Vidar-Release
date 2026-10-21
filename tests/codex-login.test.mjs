// Codex login through the tab's own app-server (P5b): account/read before thread/start, a turn
// refused while logged out, account/login/start in both methods (shapes pinned from
// `codex app-server generate-json-schema --experimental`, codex-cli 0.162.1: LoginAccountParams
// `{type:"chatgpt"}` / `{type:"apiKey", apiKey}`, LoginAccountResponse `{type:"chatgpt", authUrl,
// loginId}` / `{type:"apiKey"}`, AccountLoginCompletedNotification `{success, error?, loginId?}`),
// and an API key that never reaches an event. The API-key path is untested live; these carry it.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { LOGIN_ORIGIN, NOT_LOGGED_IN_REASON } = await import("../src/agents/codex-login.ts");
const { authCheck, createLogin } = await import("../src/panels/rendered/login.ts");
const { CODEX_LOGIN_TIP } = await import("../src/panels/rendered/api-key-card.ts");
const codexTip = () => CODEX_LOGIN_TIP;
const { apiKeyCard, codexLogin, loginCard, API_KEY_CARD, codexDeadLogin, CODEX_LOGIN_STARTING, LOGIN_COPY_LINK } = await import("../src/panels/rendered/api-key-card.ts");
const { createStatusBar } = await import("../src/panels/rendered/status-bar.ts");

const KEY = "sk-proj-Test\"Key\\0123456789";

function harness() {
  const adapter = new CodexAdapter(), wire = [], emitted = [];
  adapter.attach((line) => wire.push(JSON.parse(line)), (ev) => emitted.push(ev));
  adapter.start({ cwd: "C:/work", permissionMode: "default" });
  const feed = (m) => adapter.feed(JSON.stringify(m));
  const request = (method) => wire.findLast((m) => m.method === method);
  const reply = (method, result) => feed({ id: request(method).id, result });
  const fail = (method, message) => feed({ id: request(method).id, error: { code: -32600, message } });
  return { adapter, wire, emitted, feed, request, reply, fail };
}
const methods = (wire) => wire.map((m) => m.method).filter(Boolean);

test("account/read goes out on the initialize reply, before thread/start", () => {
  const h = harness();
  h.reply("initialize", {});
  const sent = methods(h.wire);
  assert.ok(sent.indexOf("account/read") > sent.indexOf("initialized"));
  assert.ok(sent.indexOf("account/read") < sent.indexOf("thread/start"), sent.join(", "));
  assert.deepEqual(h.request("account/read").params, {});
});

test("account/read: no account where one is required is logged out; an account or no requirement is logged in", () => {
  const read = (result) => { const h = harness(); h.reply("initialize", {}); return h.reply("account/read", result); };
  assert.deepEqual(read({ account: null, requiresOpenaiAuth: true }), [{ kind: "auth", loggedIn: false }]);
  assert.deepEqual(read({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true }), [{ kind: "auth", loggedIn: true }]);
  assert.deepEqual(read({ account: { type: "apiKey" }, requiresOpenaiAuth: true }), [{ kind: "auth", loggedIn: true }]);
  assert.deepEqual(read({ account: null, requiresOpenaiAuth: false }), [{ kind: "auth", loggedIn: true }]);
  const h = harness(); h.reply("initialize", {});
  const [ev] = h.fail("account/read", "nope");
  assert.equal(ev.kind, "notice");
  assert.equal(ev.quiet, true, "a failed read is bookkeeping; the state stays unknown");
});

const LOGGED_OUT = { account: null, requiresOpenaiAuth: true };
const LOGGED_IN = { account: { type: "apiKey" }, requiresOpenaiAuth: true };
const reads = (wire) => methods(wire).filter((m) => m === "account/read").length;

test("logged out: a typed turn and a queued draft read again, then come back as send_failed with no turn/start", () => {
  const h = harness();
  h.reply("initialize", {});
  h.adapter.encodeUser("queued before the thread opened");
  h.reply("account/read", LOGGED_OUT);
  assert.deepEqual(h.reply("thread/start", { thread: { id: "t1" } }).filter((e) => e.kind === "send_failed"), [], "held for a second read");
  assert.equal(reads(h.wire), 2);
  const ev = h.reply("account/read", LOGGED_OUT);
  assert.deepEqual(ev.filter((e) => e.kind === "send_failed"), [{ kind: "send_failed", text: "queued before the thread opened", reason: NOT_LOGGED_IN_REASON }]);
  assert.equal(h.adapter.encodeUser("typed now"), null);
  assert.equal(reads(h.wire), 3);
  assert.deepEqual(h.reply("account/read", LOGGED_OUT).filter((e) => e.kind === "send_failed"), [{ kind: "send_failed", text: "typed now", reason: NOT_LOGGED_IN_REASON }]);
  assert.deepEqual(h.emitted, []);
  assert.ok(!methods(h.wire).includes("turn/start"));
});

test("thread/start answered before account/read: the queued draft waits for the read, then goes or is refused", () => {
  for (const [result, sends] of [[LOGGED_IN, true], [LOGGED_OUT, false]]) {
    const h = harness();
    h.reply("initialize", {});
    h.adapter.encodeUser("queued");
    h.reply("thread/start", { thread: { id: "t1" } });
    assert.ok(!methods(h.wire).includes("turn/start"), "nothing goes before the read lands");
    const ev = h.reply("account/read", result);
    assert.equal(methods(h.wire).includes("turn/start"), sends);
    assert.deepEqual(ev.filter((e) => e.kind === "send_failed"), sends ? [] : [{ kind: "send_failed", text: "queued", reason: NOT_LOGGED_IN_REASON }]);
    assert.equal(reads(h.wire), 1, "the first read is not repeated");
  }
});

// C5: a draft held on an unanswered account/read, or queued for a thread that never opened, comes
// back as send_failed when the process exits; it used to vanish with no "not sent" mark.
test("process exit: drafts held by the login gate or still queued come back as send_failed", async () => {
  const { EXITED_REASON } = await import("../src/agents/codex-login.ts");
  const h = harness();
  h.reply("initialize", {});
  h.reply("thread/start", { thread: { id: "t1" } });
  assert.equal(h.adapter.encodeUser("typed right after spawn"), null);
  assert.ok(!methods(h.wire).includes("turn/start"), "held on the unanswered read");
  assert.deepEqual(h.adapter.exited(), [{ kind: "send_failed", text: "typed right after spawn", reason: EXITED_REASON }]);
  assert.deepEqual(h.adapter.exited(), [], "drained once");
  const q = harness();
  q.reply("initialize", {});
  q.adapter.encodeUser("queued before the thread opened");
  assert.deepEqual(q.adapter.exited(), [{ kind: "send_failed", text: "queued before the thread opened", reason: EXITED_REASON }]);
});

test("account/read answered before thread/start: a logged-in draft goes on the thread/start flush", () => {
  const h = harness();
  h.reply("initialize", {});
  h.adapter.encodeUser("queued");
  h.reply("account/read", LOGGED_IN);
  h.reply("thread/start", { thread: { id: "t1" } });
  assert.equal(h.request("turn/start").params.input[0].text, "queued");
});

test("a failed account read sends the held turns, as before the read existed", () => {
  const h = harness();
  h.reply("initialize", {});
  h.reply("thread/start", { thread: { id: "t1" } });
  h.adapter.encodeUser("hello");
  assert.ok(!methods(h.wire).includes("turn/start"));
  const ev = h.fail("account/read", "method not found");
  assert.equal(ev[0].quiet, true);
  assert.ok(methods(h.wire).includes("turn/start"));
  assert.deepEqual(h.emitted, []);
});

test("a login made outside this process lets the next turn through", () => {
  const h = harness();
  h.reply("initialize", {});
  h.reply("account/read", LOGGED_OUT);
  h.reply("thread/start", { thread: { id: "t1" } });
  h.adapter.encodeUser("after a terminal login");
  assert.equal(reads(h.wire), 2, "the refused turn reads the account again");
  assert.ok(!methods(h.wire).includes("turn/start"));
  const ev = h.reply("account/read", LOGGED_IN);
  assert.deepEqual(ev, [{ kind: "auth", loggedIn: true }], "the tab's state clears");
  assert.equal(h.request("turn/start").params.input[0].text, "after a terminal login");
  h.adapter.encodeUser("next");
  assert.equal(reads(h.wire), 2, "logged in: no further read");
});

test("ChatGPT login: the exact request, an auth.openai.com link opened, any other link ignored", () => {
  const h = harness();
  h.reply("initialize", {});
  assert.equal(h.adapter.encodeLogin("chatgpt"), null);
  const req = h.request("account/login/start");
  assert.deepEqual(req, { jsonrpc: "2.0", id: req.id, method: "account/login/start", params: { type: "chatgpt" } });
  const url = `${LOGIN_ORIGIN}oauth/authorize?x=1`;
  assert.deepEqual(h.reply("account/login/start", { type: "chatgpt", authUrl: url, loginId: "l1" }), [{ kind: "login_url", url }]);
  for (const bad of ["https://auth.openai.com.evil.example/x", "http://auth.openai.com/x", "https://example.com/", ""]) {
    h.adapter.encodeLogin("chatgpt");
    const ev = h.reply("account/login/start", { type: "chatgpt", authUrl: bad, loginId: "l2" });
    assert.ok(ev.every((e) => e.kind !== "login_url"), bad);
    assert.equal(ev[0].level, "warn");
  }
});

test("login/completed: success clears the state, failure is an error notice", () => {
  const h = harness();
  h.reply("initialize", {});
  h.reply("account/read", { account: null, requiresOpenaiAuth: true });
  assert.deepEqual(h.feed({ method: "account/login/completed", params: { success: true, loginId: "l1" } }), [{ kind: "auth", loggedIn: true }]);
  h.reply("thread/start", { thread: { id: "t1" } });
  h.adapter.encodeUser("after login");
  assert.ok(methods(h.wire).includes("turn/start"), "a completed login lets turns through");
  const [ev] = h.feed({ method: "account/login/completed", params: { success: false, error: "port 1455 in use", loginId: "l2" } });
  assert.deepEqual(ev, { kind: "notice", text: "Codex login failed: port 1455 in use", level: "error" });
  assert.deepEqual(h.feed({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } }), [{ kind: "auth", loggedIn: true }]);
});

test("API key login: the exact request shape, trimmed, and success clears the state", () => {
  const h = harness();
  h.reply("initialize", {});
  h.reply("account/read", { account: null, requiresOpenaiAuth: true });
  assert.equal(h.adapter.encodeLogin({ apiKey: `  ${KEY}\n` }), null);
  const req = h.request("account/login/start");
  assert.deepEqual(req, { jsonrpc: "2.0", id: req.id, method: "account/login/start", params: { type: "apiKey", apiKey: KEY } });
  assert.deepEqual(h.reply("account/login/start", { type: "apiKey" }), [{ kind: "auth", loggedIn: true }]);
  // a blank key sends nothing
  const before = h.wire.length;
  assert.equal(h.adapter.encodeLogin({ apiKey: "   " }), null);
  assert.equal(h.wire.length, before);
});

test("API key login failure: the notice names the failure and never echoes the key", () => {
  const h = harness();
  h.reply("initialize", {});
  h.reply("thread/start", { thread: { id: "t1" } });
  const events = [];
  // a server error that quotes the key, raw and JSON-escaped, then a stray line and a completion that do too
  h.adapter.encodeLogin({ apiKey: KEY });
  events.push(...h.fail("account/login/start", `invalid api key ${KEY}: rejected`));
  h.adapter.encodeLogin({ apiKey: KEY });
  events.push(...h.feed({ method: "account/login/completed", params: { success: false, error: `bad key ${KEY}` } }));
  h.adapter.encodeLogin({ apiKey: KEY });
  events.push(...h.adapter.feed(`{"method":"mystery/echo","params":{"k":${JSON.stringify(KEY)}}}`));
  events.push(...h.adapter.feed(`not json ${KEY}`));
  const errors = events.filter((e) => e.kind === "notice" && e.level === "error");
  assert.equal(errors.length, 2);
  assert.match(errors[0].text, /^Codex login failed: invalid api key \[api key\]: rejected$/);
  assert.match(errors[1].text, /^Codex login failed: bad key /);
  const all = JSON.stringify(events) + JSON.stringify(h.emitted);
  const escaped = JSON.stringify(KEY).slice(1, -1);
  for (const needle of [KEY, escaped, "Test\"Key", "0123456789"]) assert.ok(!all.includes(needle), `leaked ${needle}`);
  // the pending map keeps no copy of the key either (it holds turn text for send_failed)
  assert.ok(!JSON.stringify([...h.adapter.pending.values()]).includes("0123456789"));
});

test("a Codex tab's not-logged-in flip says how to log in, once", () => {
  const S = { loggedOut: false, disposed: false }, notices = [];
  const login = createLogin(S, { claude: false, tip: codexTip, check: () => Promise.resolve(null), noticeBlock: (t) => notices.push(t), redrawStatus() {}, refreshState() {} });
  login.fromAgent(false);
  login.fromAgent(false);
  assert.equal(S.loggedOut, true);
  assert.deepEqual(notices, [CODEX_LOGIN_TIP]);
  login.fromAgent(true);
  assert.equal(S.loggedOut, false);
});

test("the pill's API key row: one card, its Log In puts the key on the wire once and nowhere else", async () => {
  const h = harness();
  h.reply("initialize", {});
  const host = document.createElement("div"), lines = [];
  const textarea = document.createElement("textarea");
  document.body.append(host, textarea);
  const S = { adapter: h.adapter, isAlive: true };
  const login = codexLogin(S, { sendEncoded: async (l) => { if (l !== null) lines.push(l); return true; }, mount: (c) => host.append(c), textarea, noticeBlock() {} });
  login.apiKey();
  login.apiKey();
  assert.equal(host.querySelectorAll(`.${API_KEY_CARD}`).length, 1, "a second press focuses the open card");
  const field = host.querySelector("input");
  assert.equal(document.activeElement, field);
  field.value = KEY; field.dispatchEvent(new window.Event("input"));
  field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(host.querySelector("input"), null, "the key field is gone from the card");
  assert.deepEqual([...host.querySelectorAll("button")].map((b) => b.textContent), ["ChatGPT", "API Key"], "the card is back to the choice until the account state answers");
  const sent = h.wire.filter((m) => m.method === "account/login/start");
  assert.deepEqual(sent.map((m) => m.params), [{ type: "apiKey", apiKey: KEY }]);
  assert.deepEqual(lines, [], "the adapter sends the line itself; nothing comes back for the body to send");
  h.reply("account/login/start", { type: "apiKey" }); // the account state answers
  login.settle();
  login.chatgpt();
  assert.deepEqual(h.request("account/login/start").params, { type: "chatgpt" });
  host.remove(); textarea.remove();
});

test("No-Claude machine: a Codex tab's logged-out state and login strings never probe or name Claude", async () => {
  const { chipState } = await import("../src/panels/rendered/state-chip.ts");
  const { readFileSync } = await import("node:fs");
  const seen = [];
  // rendered.ts's spawn check (authCheck): a Codex tab resolves null without running anything, on any host
  let probed = 0;
  const run = () => { probed++; return Promise.resolve(true); };
  for (const hostCan of [true, false]) assert.equal(await authCheck(false, hostCan, run)(), null);
  assert.equal(probed, 0, "a Codex tab never runs claude auth status");
  assert.equal(await authCheck(true, true, run)(), true, "a Claude tab on a registering host does");
  assert.equal(await authCheck(true, false, run)(), null);
  assert.equal(await authCheck(true, true, () => Promise.reject(new Error("no claude")))(), null);
  const S = { loggedOut: false, disposed: false };
  const login = createLogin(S, { claude: false, tip: codexTip, check: authCheck(false, true, run), noticeBlock: (t) => seen.push(t), redrawStatus() {}, refreshState() {} });
  login.check();
  login.fromAgent(false);
  login.sawTurn("Not logged in · Please run /login", false);
  assert.equal(probed, 1, "the Codex tab's check ran nothing");
  seen.push(codexTip(), chipState({ hydrating: false, disconnected: false, isAlive: true, pendingApproval: null, inTurn: false, loggedOut: true, sessionId: null, costTotal: 0 }, false, 0).title);
  // every adapter-side login string: refused turn, bad link, failed login, unexpected reply
  const h = harness();
  h.reply("initialize", {});
  h.reply("account/read", { account: null, requiresOpenaiAuth: true });
  h.reply("thread/start", { thread: { id: "t1" } });
  h.adapter.encodeUser("x");
  const events = h.reply("account/read", { account: null, requiresOpenaiAuth: true }).filter((e) => e.kind === "send_failed");
  assert.equal(events.length, 1);
  h.adapter.encodeLogin("chatgpt");
  events.push(...h.emitted, ...h.reply("account/login/start", { type: "chatgpt", authUrl: "https://example.com/", loginId: "l" }));
  h.adapter.encodeLogin({ apiKey: "sk-1" });
  events.push(...h.fail("account/login/start", "denied"), ...h.feed({ method: "account/login/completed", params: { success: false } }));
  for (const e of events) seen.push(e.text ?? e.reason ?? "");
  // the API key card and the pill's menu rows
  const { card } = apiKeyCard(() => {}, () => {});
  seen.push(card.textContent, card.querySelector("input").getAttribute("aria-label"));
  const bar = readFileSync(new URL("../src/panels/rendered/status-bar.ts", import.meta.url), "utf8");
  const rows = [...bar.matchAll(/label: "(Log In With [^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ["Log In With ChatGPT", "Log In With API Key"]);
  seen.push(...rows);
  assert.ok(seen.length >= 10 && seen.every((t) => typeof t === "string" && t.length > 0));
  for (const t of seen) assert.ok(!/claude/i.test(t), `names Claude: ${t}`);
});

test("the API key card: masked field, Log In only with text, the key handed over once and the field emptied", () => {
  const host = document.createElement("div");
  const got = [];
  let closed = 0;
  const { card, field } = apiKeyCard((k) => got.push(k), () => closed++);
  host.append(card);
  assert.ok(card.classList.contains(API_KEY_CARD));
  assert.equal(card.querySelector(".approval-title").textContent, "OpenAI API Key");
  assert.equal(field.type, "password");
  const [logIn, cancel] = card.querySelectorAll("button");
  assert.equal(logIn.textContent, "Log In");
  assert.equal(cancel.textContent, "Cancel");
  assert.equal(logIn.disabled, true);
  field.value = " sk-abc "; field.dispatchEvent(new window.Event("input"));
  assert.equal(logIn.disabled, false);
  logIn.click();
  assert.deepEqual(got, ["sk-abc"]);
  assert.equal(field.value, "");
  assert.equal(card.isConnected, false);
  assert.equal(closed, 1);

  const second = apiKeyCard((k) => got.push(k), () => closed++);
  host.append(second.card);
  second.field.value = "sk-xyz";
  second.card.querySelectorAll("button")[1].click();
  assert.deepEqual(got, ["sk-abc"], "cancel hands nothing over");
  assert.equal(second.field.value, "");
  assert.equal(second.card.isConnected, false);
  assert.equal(closed, 2);
});

function pill(h, S) {
  const host = document.createElement("div"), textarea = document.createElement("textarea"), notices = [];
  document.body.append(host, textarea);
  const login = codexLogin(S, { sendEncoded: async () => true, mount: (c) => host.append(c), textarea, noticeBlock: (t, level) => notices.push([t, level]) });
  return { host, textarea, notices, login, done: () => { host.remove(); textarea.remove(); } };
}

test("the login is offered only once the initialize reply has landed", () => {
  const h = harness();
  const S = { adapter: h.adapter, isAlive: true };
  const p = pill(h, S);
  assert.equal(p.login.ready(), false, "a press before initialize answered would go nowhere");
  h.reply("initialize", {});
  assert.equal(p.login.ready(), true);
  S.isAlive = false;
  assert.equal(p.login.ready(), false);
  p.done();
});

test("Log In with the process gone says so instead of dropping the press", () => {
  const h = harness();
  h.reply("initialize", {});
  const S = { adapter: h.adapter, isAlive: true };
  const p = pill(h, S);
  p.login.apiKey();
  const field = p.host.querySelector("input");
  field.value = KEY; field.dispatchEvent(new window.Event("input"));
  S.isAlive = false;
  p.host.querySelector("button").click();
  assert.deepEqual(p.notices, [[codexDeadLogin(false), "warn"]]);
  assert.equal(field.value, "", "the key is still emptied");
  p.login.chatgpt();
  assert.equal(p.notices.length, 2);
  assert.ok(!methods(h.wire).includes("account/login/start"));
  assert.ok(!JSON.stringify(p.notices).includes("0123456789"));
  p.done();
});

test("a key card dropped by /clear keeps no typed text, and the next press opens a new card", () => {
  const h = harness();
  h.reply("initialize", {});
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.apiKey();
  const old = p.host.querySelector("input");
  old.value = KEY;
  p.host.replaceChildren(); // resetTranscript
  p.login.apiKey();
  assert.equal(old.value, "");
  const cards = p.host.querySelectorAll(`.${API_KEY_CARD}`);
  assert.equal(cards.length, 1);
  assert.equal(document.activeElement, cards[0].querySelector("input"));
  p.done();
});

test("account/updated with authMode null logs the tab out, as account/read does", () => {
  const h = harness();
  h.reply("initialize", {});
  h.reply("account/read", { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
  h.reply("thread/start", { thread: { id: "t1" } });
  assert.deepEqual(h.feed({ method: "account/updated", params: { authMode: null, planType: null } }), [{ kind: "auth", loggedIn: false }]);
  h.adapter.encodeUser("after logout");
  assert.ok(!methods(h.wire).includes("turn/start"), "the next turn reads again before going");
  assert.equal(methods(h.wire).filter((m) => m === "account/read").length, 2);
});

// ---- the login card (L3-05): offered, key entry, pending, failed, logged in ----
const labels = (host) => [...host.querySelectorAll("button")].map((b) => b.textContent);
const press = (host, text) => [...host.querySelectorAll("button")].find((b) => b.textContent === text).click();
const started = () => { const h = harness(); h.reply("initialize", {}); return h; };

test("logged out before any turn: one card offers ChatGPT and API Key, in place of the warn tip", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.host.append(Object.assign(document.createElement("div"), { className: "blk blk-notice warn", textContent: CODEX_LOGIN_TIP }));
  p.login.offer();
  p.login.offer();
  assert.equal(p.host.querySelectorAll(`.${API_KEY_CARD}`).length, 1, "a redraw never stacks a second card");
  assert.equal(p.host.querySelectorAll(".blk-notice").length, 0, "the tip it replaces is gone");
  assert.equal(p.host.querySelector(".approval-title").textContent, "Log In To Codex");
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  assert.ok(!methods(h.wire).includes("turn/start") && !methods(h.wire).includes("account/login/start"));
  p.done();
});

test("a tab with no login of its own (hosted) gets no card", () => {
  const p = pill({}, { adapter: { loginReady: () => true }, isAlive: true });
  p.login.offer();
  assert.equal(p.host.children.length, 0);
  p.done();
});

test("API Key turns the card into the masked entry in place; Cancel returns the choice and empties the key", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "API Key");
  assert.equal(p.host.querySelectorAll(`.${API_KEY_CARD}`).length, 1);
  const field = p.host.querySelector("input");
  assert.equal(field.type, "password");
  assert.deepEqual(labels(p.host), ["Log In", "Cancel"]);
  field.value = KEY;
  press(p.host, "Cancel");
  assert.equal(field.value, "");
  assert.equal(p.host.querySelector("input"), null);
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  p.done();
});

test("ChatGPT shows a spinner, Waiting For Browser, and Cancel", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  assert.deepEqual(h.request("account/login/start").params, { type: "chatgpt" });
  assert.ok(p.host.querySelector('.mark[data-mark="running"]'));
  assert.ok(p.host.textContent.includes("Waiting For Browser"));
  assert.deepEqual(labels(p.host), ["Cancel"]);
  p.done();
});

test("Cancel sends the stored loginId and returns the card to the method picker", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  h.reply("account/login/start", { type: "chatgpt", authUrl: `${LOGIN_ORIGIN}oauth/authorize`, loginId: "l1" });
  press(p.host, "Cancel");
  const cancel = h.request("account/login/cancel");
  assert.deepEqual(cancel, { jsonrpc: "2.0", id: cancel.id, method: "account/login/cancel", params: { loginId: "l1" } });
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  assert.ok(!p.host.textContent.includes("Waiting For Browser"));
  assert.deepEqual(h.feed({ id: cancel.id, error: { code: -32600, message: "cancel refused" } }),
    [{ kind: "notice", text: "account/login/cancel: cancel refused", level: "error" }]);
  assert.deepEqual(h.feed({ method: "account/login/completed", params: { success: true, loginId: "l1" } }), []);
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  p.done();
});

test("Cancel before the start reply sends once when loginId arrives; late completion is ignored", () => {
  const h = started();
  h.reply("account/read", LOGGED_OUT);
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  press(p.host, "Cancel");
  assert.equal(h.request("account/login/cancel"), undefined);
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  assert.deepEqual(h.reply("account/login/start", { type: "chatgpt", authUrl: `${LOGIN_ORIGIN}oauth/authorize`, loginId: "l2" }), []);
  assert.deepEqual(h.request("account/login/cancel").params, { loginId: "l2" });
  assert.deepEqual(h.feed({ method: "account/login/completed", params: { success: true, loginId: "l2" } }), []);
  assert.deepEqual(h.feed({ method: "account/login/completed", params: { success: true, loginId: "l2" } }), []);
  assert.equal(p.host.querySelector(".approval-title").textContent, "Log In To Codex");
  h.reply("thread/start", { thread: { id: "t1" } });
  h.adapter.encodeUser("still logged out");
  assert.ok(!methods(h.wire).includes("turn/start"));
  p.done();
});

test("a failed login lands in the card in the server's words, once, and the buttons come back", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  const [ev] = h.feed({ method: "account/login/completed", params: { success: false, error: "the login did not complete" } });
  assert.equal(p.login.fail(ev.text), true);
  assert.equal(p.host.querySelector(".approval-why").textContent, "Codex login failed: the login did not complete");
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  assert.equal(p.login.fail("Model change failed: x"), false, "other errors stay notices");
  p.done();
});

test("with no card open a login failure is not taken, so the notice shows as before", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  assert.equal(p.login.fail("Codex login failed: nope"), false);
  p.done();
});

test("an API key failure echoing the key is masked before it reaches the card", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.apiKey();
  const field = p.host.querySelector("input");
  field.value = KEY; field.dispatchEvent(new window.Event("input"));
  press(p.host, "Log In");
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  const [ev] = h.adapter.feed(JSON.stringify({ id: h.request("account/login/start").id, error: { code: 1, message: `bad key ${KEY}` } }));
  assert.equal(p.login.fail(ev.text), true);
  assert.ok(!p.host.textContent.includes("0123456789"));
  p.done();
});

test("logged in folds the card to one Logged In row with a check; a later logout gets a new card", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  p.login.settle();
  const card = p.host.querySelector(`.${API_KEY_CARD}`);
  assert.ok(card.classList.contains("settled"));
  assert.equal(card.querySelector(".approval-title").textContent, "Logged In");
  assert.ok(card.querySelector(".approval-result.ok svg"));
  assert.deepEqual(labels(p.host), []);
  assert.ok(!card.textContent.includes("Waiting For Browser"));
  p.login.offer();
  assert.equal(p.host.querySelectorAll(`.${API_KEY_CARD}`).length, 2);
  p.done();
});

test("the pill's menu entries drive the same card", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  p.login.apiKey();
  assert.equal(p.host.querySelectorAll(`.${API_KEY_CARD}`).length, 1);
  assert.ok(p.host.querySelector("input"));
  p.login.chatgpt();
  assert.ok(p.host.textContent.includes("Waiting For Browser"), "a retry from the pill works while pending");
  p.done();
});

// ---- review-fix rf-g (cover.md 1-5, 8, 9) ----
const tick = () => new Promise((r) => setTimeout(r, 0));

test("Codex exiting mid-login returns the card to its choice, the failure in it (cover 1)", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  const evs = h.adapter.exited(); // lifecycle onExit hands these to handle(): a notice reaches login.fail
  const failed = evs.filter((ev) => ev.kind === "notice");
  assert.equal(failed.length, 1);
  assert.equal(p.login.fail(failed[0].text), true);
  assert.equal(p.host.querySelector(".approval-why").textContent, "Codex login failed: Codex exited before the login finished");
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  assert.deepEqual(h.adapter.exited(), [], "a settled login fails once");
  p.done();
});

test("an exit with no login out adds no login failure (cover 1)", () => {
  const h = started();
  assert.deepEqual(h.adapter.exited(), []);
  h.adapter.encodeLogin("chatgpt");
  h.adapter.encodeLoginCancel();
  assert.deepEqual(h.adapter.exited(), [], "a cancelled login is not failed");
});

test("a login request whose write fails comes back as a login failure (cover 1)", async () => {
  const adapter = new CodexAdapter(), wire = [], emitted = [];
  let ok = true;
  adapter.attach((line) => { wire.push(JSON.parse(line)); return Promise.resolve(ok); }, (ev) => emitted.push(ev));
  adapter.start({ cwd: "C:/work", permissionMode: "default" });
  adapter.feed(JSON.stringify({ id: wire.findLast((m) => m.method === "initialize").id, result: {} }));
  adapter.encodeLogin("chatgpt");
  await tick();
  assert.deepEqual(emitted, [], "a write that landed fails nothing");
  ok = false;
  adapter.encodeLogin("chatgpt");
  await tick();
  assert.deepEqual(emitted, [{ kind: "notice", text: "Codex login failed: the login request could not be sent", level: "error" }]);
});

test("card buttons before the initialize reply write nothing and say Codex is starting (cover 2)", () => {
  const calls = [];
  const adapter = { encodeLogin: (m) => { calls.push(m); return null; }, encodeLoginCancel: () => null, loginReady: () => false };
  const p = pill({}, { adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  assert.deepEqual(calls, []);
  assert.deepEqual(p.notices, [[CODEX_LOGIN_STARTING, "warn"]]);
  assert.deepEqual(labels(p.host), ["ChatGPT", "API Key"]);
  press(p.host, "API Key");
  const field = p.host.querySelector("input");
  field.value = KEY; field.dispatchEvent(new window.Event("input"));
  press(p.host, "Log In");
  assert.deepEqual(calls, [], "the key never reaches the adapter");
  assert.equal(p.notices.length, 2);
  p.done();
});

test("the dead-process notice names the exit line's button, never /clear (cover 3)", () => {
  assert.equal(codexDeadLogin(false), "Codex is not running. Press Restart, then log in.");
  assert.equal(codexDeadLogin(true), "Codex is not running. Press Resume, then log in.");
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: false, sessionId: "t1" });
  p.login.chatgpt();
  assert.deepEqual(p.notices, [[codexDeadLogin(true), "warn"]]);
  assert.ok(!p.notices[0][0].includes("/clear"));
  p.done();
});

test("a ChatGPT reply for a replaced attempt cancels its loginId (cover 4)", () => {
  const h = started();
  h.adapter.encodeLogin("chatgpt");
  h.adapter.encodeLoginCancel();
  h.adapter.encodeLogin("chatgpt");
  const [first, second] = h.wire.filter((m) => m.method === "account/login/start");
  assert.deepEqual(h.feed({ id: first.id, result: { type: "chatgpt", authUrl: `${LOGIN_ORIGIN}a`, loginId: "a" } }), []);
  assert.deepEqual(h.request("account/login/cancel").params, { loginId: "a" });
  assert.deepEqual(h.feed({ id: second.id, result: { type: "chatgpt", authUrl: `${LOGIN_ORIGIN}b`, loginId: "b" } }),
    [{ kind: "login_url", url: `${LOGIN_ORIGIN}b` }]);
  assert.equal(h.wire.filter((m) => m.method === "account/login/cancel").length, 1, "the live attempt is left alone");
});

test("the pending view offers the login link as Copy Link once it is known (cover 5)", () => {
  const card = loginCard({ chatgpt() {}, apiKey() {}, cancel() {} });
  card.pending();
  assert.equal(card.card.querySelector(".file-action"), null, "no link yet, no copy action");
  card.pending(`${LOGIN_ORIGIN}oauth`);
  const copy = card.card.querySelector("button.file-action");
  assert.ok(copy);
  assert.equal(copy.title, LOGIN_COPY_LINK);
  assert.ok(card.card.textContent.includes("Waiting For Browser"));
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  p.login.url(`${LOGIN_ORIGIN}x`);
  assert.equal(p.host.querySelector("button.file-action"), null, "a link with no login pending draws nothing");
  press(p.host, "ChatGPT");
  p.login.url(`${LOGIN_ORIGIN}x`);
  assert.ok(p.host.querySelector("button.file-action"));
  p.done();
});

test("API Key while a ChatGPT login is pending cancels it first (cover 9)", () => {
  const h = started();
  const p = pill(h, { adapter: h.adapter, isAlive: true });
  p.login.offer();
  press(p.host, "ChatGPT");
  h.reply("account/login/start", { type: "chatgpt", authUrl: `${LOGIN_ORIGIN}oauth/authorize`, loginId: "l9" });
  p.login.apiKey();
  assert.deepEqual(h.request("account/login/cancel")?.params, { loginId: "l9" });
  assert.ok(p.host.querySelector("input"));
  p.done();
});

test("the logged-out pill is pending until the initialize reply lands (cover 8)", () => {
  const adapter = new CodexAdapter(), wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  adapter.start({ cwd: "C:/work", permissionMode: "default" });
  const state = { adapter, isAlive: true, inTurn: false, mode: "default", models: [], modelPending: null, loggedOut: true };
  const host = document.createElement("div"), textarea = document.createElement("textarea");
  document.body.append(host, textarea);
  const login = codexLogin(state, { sendEncoded: async () => true, mount: (c) => host.append(c), textarea, noticeBlock() {} });
  const bar = createStatusBar(state, { opts: { agent: "codex", cwd: "C:/work" }, send: async () => true, noticeBlock() {},
    refreshState() {}, emitCharacterStatus() {}, openStMenu() {}, textarea, login });
  bar.redrawStatus();
  assert.equal(state.modelBtn.getAttribute("aria-busy"), "true");
  adapter.feed(JSON.stringify({ id: wire.findLast((m) => m.method === "initialize").id, result: {} }));
  bar.syncControls();
  assert.notEqual(state.modelBtn.getAttribute("aria-busy"), "true");
  host.remove(); textarea.remove();
});
