// Codex mode and skills/list contracts through the existing Rendered controls.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { createStatusBar, modeLabel } = await import("../src/panels/rendered/status-bar.ts");
const { AGENT_PROFILE } = await import("../src/agents/agent-profile.ts");
const { createPalette } = await import("../src/panels/rendered/palette.ts");
const { createEvents } = await import("../src/panels/rendered/events.ts");

function harness(permissionMode = "default", resume) {
  const adapter = new CodexAdapter();
  const wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  const request = (method) => wire.findLast((m) => m.method === method);
  const reply = (method, result) => adapter.feed(JSON.stringify({ id: request(method).id, result }));
  adapter.start({ cwd: "C:/work", permissionMode, resume });
  reply("initialize", {});
  reply("account/read", { account: { type: "apiKey" }, requiresOpenaiAuth: true }); // turns wait for it
  return { adapter, wire, request, reply };
}

test("Codex modes explicitly select the reviewer on start, resume, fallback, and subsequent turns", () => {
  for (const mode of ["default", "plan", "auto"]) for (const resume of [undefined, "old-thread"]) {
    const h = harness(mode, resume);
    const reviewer = mode === "auto" ? "auto_review" : "user";
    const initial = resume ? "thread/resume" : "thread/start";
    assert.equal(h.request(initial).params.approvalsReviewer, reviewer);
    assert.equal(h.request(initial).params.approvalPolicy, "on-request");
    assert.equal(h.request(initial).params.sandbox, mode === "plan" ? "read-only" : "workspace-write");
    if (resume) {
      h.adapter.feed(JSON.stringify({ id: h.request(initial).id, error: { message: "Deleted" } }));
      assert.equal(h.request("thread/start").params.approvalsReviewer, reviewer);
    }
    h.reply("thread/start", { thread: { id: "thread-1" } });
    h.adapter.encodeUser("First turn");
    assert.equal(h.request("turn/start").params.approvalsReviewer, reviewer);
    assert.equal(h.request("turn/start").params.sandboxPolicy.type, mode === "plan" ? "readOnly" : "workspaceWrite");
    h.adapter.encodeSetPermissionMode("auto");
    h.adapter.encodeUser("Auto Review");
    assert.equal(h.request("turn/start").params.approvalsReviewer, "auto_review");
    for (const next of ["default", "plan"]) {
      h.adapter.encodeSetPermissionMode(next);
      h.adapter.encodeUser("Manual review");
      assert.equal(h.request("turn/start").params.approvalsReviewer, "user", "leaving Auto Review resets its persistent override");
    }
  }
});

test("the existing Codex mode menu labels Auto Review and stages it until the next turn", () => {
  const h = harness();
  h.reply("thread/start", { thread: { id: "thread-1" } });
  const state = { adapter: h.adapter, isAlive: true, inTurn: false, mode: "default", models: [], modelPending: null };
  let menu, pick;
  const bar = createStatusBar(state, { opts: { agent: "codex", cwd: "C:/work" },
    send: async () => assert.fail("No setter RPC"), noticeBlock: () => assert.fail("No warnings"),
    refreshState() {}, emitCharacterStatus() {}, openStMenu: (_anchor, items, onPick) => { menu = items; pick = onPick; } });
  bar.sl.model = "Ready";
  bar.settleSwitch("default");
  state.modeBtn.click();
  assert.deepEqual(menu.map((m) => m.label), ["Default", "Plan", "Auto Review"]);
  const before = h.wire.length;
  pick("auto");
  assert.equal(state.mode, "auto");
  assert.equal(bar.sl.mode, "Auto Review");
  assert.equal(h.wire.length, before);
  state.inTurn = true;
  pick("plan");
  assert.equal(state.mode, "auto", "Codex mode picks are blocked during a turn");
  h.adapter.encodeUser("Next turn");
  assert.equal(h.request("turn/start").params.approvalsReviewer, "auto_review");
  assert.equal(modeLabel("auto", "claude"), "Auto");
  assert.ok(AGENT_PROFILE.claude.permissionModes.includes("auto"));
});

test("skills/list maps enabled names into the shared palette and selected skills into turn input", () => {
  for (const skillsFirst of [true, false]) {
    const h = harness();
    assert.deepEqual(h.request("skills/list").params, { cwds: ["C:/work"] });
    if (!skillsFirst) h.reply("thread/start", { thread: { id: "thread-1" } });
    const skill = (name, path, enabled = true) => ({ name, path, enabled, description: "Skill", scope: "repo" });
    const events = h.reply("skills/list", { data: [{ cwd: "C:/work", errors: [], skills: [
      skill("build.plan", "C:/work/plan/SKILL.md"), skill("build.plan", "C:/work/duplicate/SKILL.md"),
      skill("disabled", "C:/work/disabled/SKILL.md", false), skill("broken", ""), null,
      skill("review", "C:/work/review/SKILL.md"),
    ] }] });
    assert.deepEqual(events, [{ kind: "commands", commands: ["build.plan", "review"] }]);
    if (skillsFirst) {
      const session = h.reply("thread/start", { thread: { id: "thread-1" } });
      assert.deepEqual(session.find((ev) => ev.kind === "session").commands, events[0].commands);
    }
    const textarea = document.createElement("textarea");
    const palette = document.createElement("div");
    const state = { commands: [], paletteSel: null };
    const ui = createPalette(state, { textarea, palette });
    textarea.value = "/";
    const { handle } = createEvents(state, { tools: new Map(), updatePalette: ui.updatePalette });
    handle(events[0]);
    assert.deepEqual([...palette.children].map((r) => r.textContent), ["/build.plan", "/review"]);
    ui.movePalette(1);
    ui.pickPalette();
    assert.equal(textarea.value, "/review ");
    h.adapter.encodeUser(textarea.value + "Inspect this change");
    assert.deepEqual(h.request("turn/start").params.input, [
      { type: "text", text: "/review Inspect this change" },
      { type: "skill", name: "review", path: "C:/work/review/SKILL.md" },
    ]);
    textarea.value = "/build.";
    ui.updatePalette();
    assert.deepEqual([...palette.children].map((r) => r.textContent), ["/build.plan"]);
    h.adapter.feed(JSON.stringify({ method: "skills/changed", params: {} }));
    assert.equal(h.request("skills/list").params.forceReload, true);
    const cleared = h.reply("skills/list", { data: [] });
    assert.deepEqual(cleared, [{ kind: "commands", commands: [] }]);
    handle(cleared[0]);
    assert.ok(palette.classList.contains("hidden"), "catalog refresh hides a palette with no enabled skills");
    h.adapter.encodeUser("/review No longer available");
    assert.deepEqual(h.request("turn/start").params.input, [{ type: "text", text: "/review No longer available" }]);
  }
});

test("warning-family notifications read the schema text field per method", () => {
  const h = harness();
  const note = (method, params) => h.adapter.feed(JSON.stringify({ method, params }));
  assert.equal(note("deprecationNotice", { summary: "Old flag", details: "Use the new one" })[0].text, "deprecationNotice: Old flag");
  assert.equal(note("deprecationNotice", { details: "Use the new one" })[0].text, "deprecationNotice: Use the new one");
  assert.equal(note("configWarning", { summary: "Bad key", path: "config.toml" })[0].text, "configWarning: Bad key");
  assert.equal(note("warning", { message: "Careful" })[0].text, "warning: Careful");
  assert.equal(note("guardianWarning", { threadId: "t", message: "Blocked" })[0].text, "guardianWarning: Blocked");
  assert.match(note("warning", { other: 1 })[0].text, /^warning: \{\s*"other": 1\s*\}$/);
});

test("a skills/list error is a quiet info notice", () => {
  const h = harness();
  const events = h.adapter.feed(JSON.stringify({ id: h.request("skills/list").id, error: { message: "method not found" } }));
  assert.deepEqual(events, [{ kind: "notice", text: "skills/list: method not found", level: "info", quiet: true }]);
});

test("the restored-history notice is singular for one item", () => {
  for (const [agent, count, text] of [["codex", 1, "1 Turn"], ["codex", 3, "3 Turns"], ["claude", 1, "1 Message"], ["claude", 2, "2 Messages"]]) {
    const notices = [];
    const S = { replaying: false, hydrating: false, turnGroups: [], stick: false };
    const noop = () => {};
    const { handle } = createEvents(S, {
      opts: { agent }, tools: new Map(), sealGroup: noop, follow: { jump: noop },
      restoredBlock: (t, truncated) => notices.push([t, truncated]),
      settleReplayedAgents: noop,
    });
    handle({ kind: "replay", phase: "end", count });
    assert.deepEqual(notices, [[text, false]]);
  }
});

const DOWNGRADE = [
  { kind: "mode", mode: "default", ack: true },
  { kind: "notice", text: "Auto Review Unavailable, Back To Default", level: "warn" },
];
const fail = (h, method, message) => h.adapter.feed(JSON.stringify({ id: h.request(method).id, error: { message } }));
const note = (h, method, params) => h.adapter.feed(JSON.stringify({ method, params }));

test("a reviewer-naming turn/start error in Auto Review drops to Default and hands the draft back", () => {
  const h = harness("auto");
  h.reply("thread/start", { thread: { id: "thread-1" } });
  h.adapter.encodeUser("Needs network");
  const events = fail(h, "turn/start", "unknown variant `auto_review` for approvalsReviewer");
  assert.deepEqual(events, [
    { kind: "notice", text: "turn/start: unknown variant `auto_review` for approvalsReviewer", level: "error" },
    ...DOWNGRADE,
    { kind: "send_failed", text: "Needs network", reason: "turn/start: unknown variant `auto_review` for approvalsReviewer" },
  ]);
  h.adapter.encodeUser("Retry by hand");
  assert.equal(h.request("turn/start").params.approvalsReviewer, "user");
});

test("an unrelated turn/start error keeps Auto Review", () => {
  const h = harness("auto");
  h.reply("thread/start", { thread: { id: "thread-1" } });
  h.adapter.encodeUser("First");
  const events = fail(h, "turn/start", "rate limited");
  assert.ok(!events.some((e) => e.kind === "mode"));
  h.adapter.encodeUser("Second");
  assert.equal(h.request("turn/start").params.approvalsReviewer, "auto_review");
});

test("a reviewer-naming thread/start error retries once as Default, keeping queued drafts", () => {
  const h = harness("auto");
  h.adapter.encodeUser("Queued draft");
  const first = h.request("thread/start");
  const events = fail(h, "thread/start", "approvalsReviewer auto_review is not supported");
  assert.deepEqual(events.slice(1), DOWNGRADE);
  const retry = h.request("thread/start");
  assert.notEqual(retry.id, first.id);
  assert.equal(retry.params.approvalsReviewer, "user");
  assert.equal(h.adapter.sessionFailed, false);
  assert.ok(!events.some((e) => e.kind === "send_failed"));
  const again = fail(h, "thread/start", "approvalsReviewer auto_review is not supported");
  assert.equal(h.wire.filter((m) => m.method === "thread/start").length, 2, "no retry loop");
  assert.equal(h.adapter.sessionFailed, true);
  assert.deepEqual(again.filter((e) => e.kind === "send_failed").map((e) => e.text), ["Queued draft"]);
});

test("a thread/start or resume response reporting the user reviewer in Auto Review is a downgrade", () => {
  for (const resume of [undefined, "old-thread"]) {
    const h = harness("auto", resume);
    const events = h.reply(resume ? "thread/resume" : "thread/start", { thread: { id: "thread-1" }, approvalsReviewer: "user" });
    assert.equal(events.find((e) => e.kind === "session").permissionMode, "default");
    assert.deepEqual(events.filter((e) => e.kind === "mode" || e.level === "warn"), DOWNGRADE);
    for (const reviewer of ["auto_review", "guardian_subagent"]) {
      const k = harness("auto", resume);
      const ok = k.reply(resume ? "thread/resume" : "thread/start", { thread: { id: "thread-1" }, approvalsReviewer: reviewer });
      assert.ok(!ok.some((e) => e.kind === "mode"));
    }
  }
});

test("thread/settings/updated downgrades only after an Auto Review turn has started on that thread", () => {
  const h = harness("default");
  h.reply("thread/start", { thread: { id: "thread-1" } });
  const userSettings = { threadId: "thread-1", threadSettings: { approvalsReviewer: "user" } };
  h.adapter.encodeSetPermissionMode("auto"); // staged; the server still holds user
  assert.equal(note(h, "thread/settings/updated", userSettings)[0].quiet, true, "a staged pick is never reverted");
  h.adapter.encodeUser("Auto turn");
  assert.equal(note(h, "thread/settings/updated", userSettings)[0].quiet, true, "before turn/started");
  note(h, "turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
  assert.equal(note(h, "thread/settings/updated", { ...userSettings, threadId: "other" })[0].quiet, true, "another thread");
  assert.equal(note(h, "thread/settings/updated", { threadId: "thread-1", threadSettings: { approvalsReviewer: "auto_review" } })[0].quiet, true);
  assert.deepEqual(note(h, "thread/settings/updated", userSettings), DOWNGRADE);
  h.adapter.encodeUser("Next");
  assert.equal(h.request("turn/start").params.approvalsReviewer, "user");
});

test("reviewer decisions: denied is a visible warn, approved is quiet, malformed stays a quiet method notice", () => {
  const h = harness("auto");
  const review = (action, status, rationale) => note(h, "item/autoApprovalReview/completed",
    { threadId: "t", turnId: "u", reviewId: "r", action, review: { status, rationale } })[0];
  const curl = { type: "command", command: "curl https://example.com", cwd: "C:/work", source: "shell" };
  assert.deepEqual(review(curl, "denied", "Exfiltration risk"),
    { kind: "notice", text: "Auto Review Denied: curl https://example.com - Exfiltration risk", level: "warn" });
  for (const status of ["timedOut", "aborted"]) assert.equal(review(curl, status, null).level, "warn");
  assert.deepEqual(review(curl, "approved", "Fine"),
    { kind: "notice", text: "Auto Review Approved: curl https://example.com", level: "info", quiet: true });
  const quiet = { kind: "notice", text: "item/autoApprovalReview/completed", level: "info", quiet: true };
  assert.deepEqual(note(h, "item/autoApprovalReview/completed", { review: "nope", action: 3 }), [quiet]);
  assert.deepEqual(note(h, "item/autoApprovalReview/completed", {}), [quiet]);
  assert.deepEqual(review({ type: "command" }, "inProgress"), quiet);
  assert.equal(review({ type: "command", command: "x".repeat(500) }, "denied", "y".repeat(500)).text.length, "Auto Review Denied: ".length + 200 + 3 + 200);
});

test("a writeStdin review never prints the typed input", () => {
  const h = harness("auto");
  const [ev] = note(h, "item/autoApprovalReview/completed", { action: { type: "writeStdin", approvalId: "a", cwd: "C:/work", processId: "42", stdin: "hunter2\n" },
    review: { status: "denied", rationale: "Prompt input" } });
  assert.equal(ev.text, "Auto Review Denied: Process 42 Input - Prompt input");
  assert.ok(!ev.text.includes("hunter2"));
});
