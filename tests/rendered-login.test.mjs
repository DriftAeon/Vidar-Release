// Rendered tab login state (src/panels/rendered/login.ts). The CLI's not-logged-in reply is a
// cross-process contract (Claude Code 2.1.x prints `Not logged in · Please run /login`), and the
// state must clear once a login lands (first-run smoke 2026-10-08, finding 1).
import test from "node:test";
import assert from "node:assert/strict";
import { createLogin, saysAuthFailed, saysNotLoggedIn } from "../src/panels/rendered/login.ts";
import { chipState } from "../src/panels/rendered/state-chip.ts";

test("an idle logged-out tab never reads Ready; a turn or approval still outranks it", () => {
  const idle = { hydrating: false, disconnected: false, isAlive: true, pendingApproval: null, inTurn: false, loggedOut: true, sessionId: null, costTotal: 0 };
  assert.deepEqual(chipState(idle, false, 0), { key: "login", cls: "login", title: "Not Logged In" });
  assert.deepEqual(chipState({ ...idle, loggedOut: false }, false, 0), { key: "ready", cls: "idle", title: "Ready" });
  assert.equal(chipState({ ...idle, inTurn: true }, false, 0).cls, "working");
});

test("the CLI's not-logged-in reply is recognised, a quote of it mid-reply is not", () => {
  assert.ok(saysNotLoggedIn("Not logged in · Please run /login"));
  assert.ok(!saysNotLoggedIn("You said you were not logged in earlier"));
  assert.ok(!saysNotLoggedIn("Not logged in, apparently: the CLI said so."), "model prose opening with the words");
  assert.ok(!saysNotLoggedIn(""));
});

test("an expired or failed sign-in on an error turn is logged out; prose or a clean turn is not", () => {
  const expired = "Failed to authenticate: OAuth session expired and could not be refreshed";
  assert.ok(saysAuthFailed(expired, false));
  assert.ok(saysAuthFailed("API Error: OAuth session expired and could not be refreshed. Please run /login", false));
  assert.ok(saysAuthFailed("Failed to authenticate. API Error: 401 invalid bearer token", false));
  assert.ok(!saysAuthFailed(expired, true), "a clean turn never logs out");
  assert.ok(!saysAuthFailed("The deploy step said it failed to authenticate with GitHub", false));
  assert.ok(!saysAuthFailed("", false));
  const S = { loggedOut: false, disposed: false };
  const tips = [];
  const login = createLogin(S, { claude: true, tip: () => "log in", check: () => Promise.resolve(null), noticeBlock: (t) => tips.push(t), redrawStatus: () => {}, refreshState: () => {} });
  login.sawTurn(expired, false);
  assert.equal(S.loggedOut, true);
  assert.deepEqual(tips, ["log in"]);
});

test("logged out before any first turn the chip reads Not Logged In, never Ready", () => {
  const fresh = { hydrating: false, disconnected: false, isAlive: true, pendingApproval: null, inTurn: false, loggedOut: true, sessionId: null, costTotal: 0 };
  assert.equal(chipState(fresh, false, 0).key, "login");
  assert.notEqual(chipState({ ...fresh, isAlive: false }, false, 0).key, "ready");
});

test("a non-Claude tab never reads replies for the diagnostic", () => {
  const S = { loggedOut: false, disposed: false };
  const login = createLogin(S, { claude: false, tip: () => "", check: () => Promise.resolve(null), noticeBlock: () => {}, redrawStatus: () => {}, refreshState: () => {} });
  login.sawTurn("Not logged in · Please run /login", false);
  assert.equal(S.loggedOut, false);
});

test("a check that resolves after newer evidence is dropped", async () => {
  const S = { loggedOut: false, disposed: false };
  const pending = [];
  const login = createLogin(S, {
    claude: true, tip: () => "",
    check: () => new Promise((r) => pending.push(r)),
    noticeBlock: () => {}, redrawStatus: () => {}, refreshState: () => {},
  });
  login.check();                 // older check, resolves last
  login.sawTurn("hi", true);     // newer evidence: logged in
  pending[0](false);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(S.loggedOut, false, "stale logged-out answer overwrote a clean turn");
  login.check(); login.check();  // two checks: only the second may land
  pending[2](true); pending[1](false);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(S.loggedOut, false);
});

function harness(answer) {
  const S = { loggedOut: false, disposed: false };
  const notices = [];
  const login = createLogin(S, {
    claude: true, tip: () => "",
    check: () => Promise.resolve(answer.value),
    noticeBlock: (text, level) => notices.push(level),
    redrawStatus: () => {},
    refreshState: () => {},
  });
  return { S, notices, login };
}

test("a reply sets it once; a clean turn or a logged-in check clears it; unknown leaves it", async () => {
  const answer = { value: null };
  const { S, notices, login } = harness(answer);
  login.sawTurn("Not logged in · Please run /login", false);
  login.sawTurn("Not logged in · Please run /login", false);
  assert.equal(S.loggedOut, true);
  assert.deepEqual(notices, ["warn"]);
  login.check();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(S.loggedOut, true, "an unknown check must not clear it");
  answer.value = true;
  login.check();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(S.loggedOut, false);
  answer.value = false;
  login.check();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(S.loggedOut, true);
  login.sawTurn("hi", true);
  assert.equal(S.loggedOut, false);
});
