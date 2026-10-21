// Installed app-server request/notification contracts exercised through shared Rendered UI.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({ stubs: {
  "panels/document": `export { renderMarkdownOrText } from ${JSON.stringify(new URL("../src/panels/markdown-build.ts", import.meta.url).href)};`,
} });
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { createCards } = await import("../src/panels/rendered/cards.ts");
const { createTextStream } = await import("../src/panels/rendered/text-stream.ts");
const { toolClass } = await import("../src/panels/rendered/tool-class.ts");

function harness(resume) {
  const adapter = new CodexAdapter(), wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  adapter.start({ cwd: "C:/work", permissionMode: "default", resume });
  const feed = (m) => adapter.feed(JSON.stringify(m));
  const request = (method) => wire.findLast((m) => m.method === method);
  const reply = (method, result) => feed({ id: request(method).id, result });
  reply("initialize", {});
  reply(resume ? "thread/resume" : "thread/start", { thread: { id: "parent" } });
  const event = (method, params) => feed({ method, params: { threadId: "parent", turnId: "turn-1", ...params } });
  return { adapter, wire, feed, request, reply, event };
}

function cards(h) {
  const host = document.createElement("div"), approvals = new Map();
  const state = { adapter: h.adapter, hydrating: false, stick: false, pendingApproval: null };
  const api = createCards(state, {
    agent: "codex", transport: { durable: false }, textarea: document.createElement("textarea"),
    follow: { toBottom() {} }, tools: new Map(), approvals, approvalQueue: [], awaiting: new Map(),
    sendEncoded: async () => true, append: (n) => host.append(n), sealGroup() {}, groupRefresh() {},
    stalePill() {}, refreshState() {}, noticeBlock() {},
  });
  const show = (ev) => {
    assert.equal(ev.kind, "approval");
    api.approvalCard(ev.requestId, ev.toolUseId, ev.tool, ev.input, ev.inputBytes, ev.suggestions);
    return approvals.get(ev.requestId);
  };
  return { show, approvals, host };
}

test("Codex question cards answer stable IDs even when question text is duplicated", () => {
  const h = harness(), ui = cards(h);
  assert.equal(h.request("initialize").params.capabilities.experimentalApi, true);
  const before = h.wire.length;
  const [ev] = h.feed({ id: "ask-1", method: "item/tool/requestUserInput", params: {
    itemId: "ask-tool", threadId: "parent", turnId: "turn-1", isBlocking: true,
    questions: [
      { id: "a", header: "First", question: "Pick?", isOther: false, options: [{ label: "Red, Blue", description: "Colours" }] },
      { id: "b", header: "Second", question: "Pick?", isOther: true, options: null },
    ],
  } });
  assert.equal(h.wire.length, before, "question waits for the user");
  assert.equal(toolClass(ev.tool, "codex"), "ask");
  const card = ui.show(ev), answer = card.querySelector(".approval-allow");
  assert.equal(answer.textContent, "Answer");
  assert.equal(answer.disabled, true);
  assert.equal(card.querySelectorAll(".q-other").length, 1);
  card.querySelector(".q-opt").click();
  assert.equal(answer.disabled, true, "all questions must be answered");
  const text = card.querySelector(".q-other");
  text.value = "Custom"; text.dispatchEvent(new window.Event("input"));
  assert.equal(answer.disabled, false);
  answer.click();
  assert.deepEqual(h.wire.at(-1), { jsonrpc: "2.0", id: "ask-1", result: {
    answers: { a: { answers: ["Red, Blue"] }, b: { answers: ["Custom"] } },
  } });
  h.adapter.encodePermission(ev.requestId, { behavior: "allow", updatedInput: { answers: { a: "Again" } } });
  assert.equal(h.wire.length, before + 1, "one answer per request");
});

test("secret free-text questions use a masked field; deny answers no questions", () => {
  const h = harness(), ui = cards(h);
  const [ev] = h.feed({ id: 14, method: "item/tool/requestUserInput", params: {
    itemId: "secret", questions: [{ id: "secret-id", question: "Token?", header: "Token", options: null, isSecret: true }],
  } });
  const card = ui.show(ev);
  const field = card.querySelector(".q-other");
  assert.equal(field.type, "password");
  assert.equal(field.placeholder, "", "the only input of a free-text question is not \"Other\"");
  field.value = "hunter2"; field.dispatchEvent(new window.Event("input"));
  card.querySelector(".approval-deny").click();
  assert.deepEqual(h.wire.at(-1).result, { answers: {} });
  return new Promise((done) => setTimeout(() => { assert.equal(field.value, "", "secret wiped on settle"); done(); }, 0));
});

test("Other row: Codex questions opt in with isOther, Claude questions always have it", () => {
  const h = harness(), ui = cards(h);
  const options = [{ label: "Yes" }, { label: "No" }];
  const [codex] = h.feed({ id: 16, method: "item/tool/requestUserInput", params: {
    itemId: "q", questions: [{ id: "x", header: "H", question: "Go?", options }],
  } });
  assert.equal(ui.show(codex).querySelectorAll(".q-other").length, 0, "isOther absent defaults to false");
  const claude = ui.show({ kind: "approval", requestId: "claude-1", tool: "AskUserQuestion", input: { questions: [{ question: "Go?", header: "H", options, multiSelect: false }] }, inputBytes: 0, suggestions: [] });
  const other = claude.querySelectorAll(".q-other");
  assert.equal(other.length, 1);
  assert.equal(other[0].placeholder, "Other");
  assert.equal(other[0].type, "text");
});

test("a child thread's events never reach the parent turn, transcript or cards", () => {
  const h = harness();
  const [parentCard] = h.feed({ id: 40, method: "item/commandExecution/requestApproval", params: { itemId: "p", threadId: "parent", turnId: "turn-1", command: "ls" } });
  const [childCard] = h.feed({ id: 41, method: "item/commandExecution/requestApproval", params: { itemId: "c", threadId: "child", turnId: "child-turn", command: "dir" } });
  const child = (method, params) => h.feed({ method, params: { threadId: "child", turnId: "child-turn", ...params } });
  assert.deepEqual(child("turn/started", { turn: { id: "child-turn" } }), []);
  assert.deepEqual(child("item/started", { item: { id: "m", type: "agentMessage", text: "" } }), []);
  assert.deepEqual(child("item/agentMessage/delta", { itemId: "m", delta: "child says" }), []);
  assert.deepEqual(child("item/completed", { item: { id: "m", type: "agentMessage", text: "child says" } }), []);
  assert.deepEqual(child("item/started", { item: { id: "cmd", type: "commandExecution", command: "dir" } }), []);
  assert.deepEqual(child("turn/plan/updated", { plan: [{ step: "x", status: "pending" }] }), []);
  const ended = child("turn/completed", { turn: { id: "child-turn", status: "completed" } });
  assert.deepEqual(ended, [{ kind: "approval_done", requestId: childCard.requestId, reason: "turn completed" }]);
  const before = h.wire.length;
  h.adapter.encodePermission(parentCard.requestId, { behavior: "allow" });
  assert.equal(h.wire.length, before + 1, "the parent card is still live");
  assert.deepEqual(h.wire.at(-1).result, { decision: "accept" });
  const done = h.event("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  assert.ok(done.some((e) => e.kind === "turn_done"));
});

test("permission escalation cards show the exact profile and only grant it for the turn", () => {
  for (const allow of [true, false]) {
    const h = harness(), ui = cards(h);
    const permissions = { network: { enabled: true }, fileSystem: {
      read: ["C:/reference"], write: ["C:/output"],
      entries: [{ access: "read", path: { type: "glob_pattern", pattern: "D:/logs/**" } }],
    } };
    const [ev] = h.feed({ id: 15, method: "item/permissions/requestApproval", params: {
      permissions, cwd: "C:/work", reason: "Read logs and save output", itemId: "permission-tool",
    } });
    const card = ui.show(ev);
    assert.match(card.textContent, /Scope: This Turn/);
    assert.match(card.textContent, /D:\/logs\/\*\*/);
    assert.match(card.textContent, /Read logs and save output/);
    card.querySelector(allow ? ".approval-allow" : ".approval-deny").click();
    assert.deepEqual(h.wire.at(-1).result, { permissions: allow ? permissions : {}, scope: "turn" });
  }
  const h = harness();
  const [ev] = h.feed({ id: "pinned", method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } });
  h.adapter.encodePermission(ev.requestId, { behavior: "allow", updatedInput: { permissions: { fileSystem: { write: ["C:/"] } }, scope: "session" } });
  assert.deepEqual(h.wire.at(-1).result, { permissions: { network: { enabled: true } }, scope: "turn" });
});

test("withdrawal and turn end retire new request kinds without a late answer", () => {
  const h = harness();
  for (const [id, method] of [[20, "item/tool/requestUserInput"], [21, "item/permissions/requestApproval"]]) {
    h.feed({ id, method, params: { questions: [], permissions: {} } });
  }
  assert.deepEqual(h.event("serverRequest/resolved", { requestId: 20 }), [
    { kind: "approval_done", requestId: "sr:20", reason: "resolved by Codex" },
  ]);
  const events = h.event("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  assert.ok(events.some((ev) => ev.kind === "approval_done" && ev.requestId === "sr:21"));
  const before = h.wire.length;
  for (const id of [20, 21]) h.adapter.encodePermission(`sr:${id}`, { behavior: "allow" });
  assert.equal(h.wire.length, before);
});

test("MCP elicitation requests draw an approval card and answer with the elicitation action", () => {
  for (const [mode, allow, content, expected] of [
    ["form", true, { email: "person@example.invalid", extra: "omit" }, { action: "accept", content: { email: "person@example.invalid" } }],
    ["form", false, { email: "person@example.invalid" }, { action: "decline" }],
    ["url", false, undefined, { action: "decline" }],
    ["url", true, undefined, { action: "accept" }],
    ["openai/userVerification", true, { proof: "not-supported" }, { action: "decline" }],
  ]) {
    const h = harness(), ui = cards(h);
    const [ev] = h.feed({ id: `elicitation-${mode}`, method: "mcpServer/elicitation/request", params: {
      serverName: "calendar", mode, title: "Share availability", message: "Allow calendar access?",
      ...(mode === "form" ? { requestedSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } }
        : mode === "url" ? { url: "https://example.invalid/authorize", elicitationId: "request-1" }
          : { title: "Verify device", description: "Confirm this device", challenge: "challenge" }),
    } });
    assert.equal(ev.tool, "MCP Elicitation");
    assert.equal(ev.input.mode, mode);
    assert.equal(ev.input.serverName, "calendar");
    assert.match(ui.show(ev).textContent, /Share availability|Allow calendar access/);
    assert.equal(typeof ev.input.unsupportedReason, mode === "openai/userVerification" ? "string" : "undefined");
    h.adapter.encodePermission(ev.requestId, { behavior: allow ? "allow" : "deny", updatedInput: content === undefined ? undefined : { content } });
    assert.deepEqual(h.wire.at(-1).result, expected, `${mode} ${JSON.stringify(content)}`);
  }
});

test("MCP elicitation form answers enforce primitive and enum schema values", () => {
  for (const [field, fieldSchema, value, expected] of [
    ["choice", { type: "string", enum: ["red", "blue"] }, "red", "accept"],
    ["choice", { type: "string", enum: ["red", "blue"] }, "green", null],
    ["tags", { type: "array", items: { type: "string", enum: ["a", "b"] } }, ["a", "b"], "accept"],
    ["tags", { type: "array", items: { type: "string", enum: ["a", "b"] } }, ["a", "c"], null],
    ["enabled", { type: "boolean" }, true, "accept"],
  ]) {
    const h = harness();
    const [ev] = h.feed({ id: `elicitation-${field}-${String(value)}`, method: "mcpServer/elicitation/request", params: {
      mode: "form", message: "Choose", requestedSchema: { type: "object", properties: { [field]: fieldSchema }, required: [field] },
    } });
    const sent = h.wire.length;
    h.adapter.encodePermission(ev.requestId, { behavior: "allow", updatedInput: { content: { [field]: value } } });
    // a misfit allow is refused unsent (null): the server never hears a decline the user did not give
    if (expected === null) { assert.equal(h.wire.length, sent, `${field} misfit sends nothing`); continue; }
    assert.equal(h.wire.at(-1).result.action, expected);
    if (expected === "accept") assert.deepEqual(h.wire.at(-1).result.content, { [field]: value });
  }
});

test("a misfit MCP form allow sends nothing and keeps the card open; a fitting allow accepts, deny declines", async () => {
  const { FORM_MISFIT } = await import("../src/agents/codex-requests.ts");
  const feedForm = (h, id) => h.feed({ id, method: "mcpServer/elicitation/request", params: {
    serverName: "calendar", mode: "form", message: "Name the calendar",
    requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 5 } }, required: ["name"] },
  } })[0];
  const h = harness(), notices = [];
  const host = document.createElement("div"), approvals = new Map();
  const state = { adapter: h.adapter, hydrating: false, stick: false, pendingApproval: null };
  const api = createCards(state, {
    agent: "codex", transport: { durable: false }, textarea: document.createElement("textarea"),
    follow: { toBottom() {} }, tools: new Map(), approvals, approvalQueue: [], awaiting: new Map(),
    sendEncoded: async () => true, append: (n) => host.append(n), sealGroup() {}, groupRefresh() {},
    stalePill() {}, refreshState() {}, noticeBlock: (text, level) => notices.push({ text, level }),
  });
  const ev = feedForm(h, "misfit-1");
  api.approvalCard(ev.requestId, ev.toolUseId, ev.tool, ev.input, ev.inputBytes, ev.suggestions);
  const card = approvals.get(ev.requestId), field = card.querySelector(".mcp-field-input");
  const allow = card.querySelector(".approval-allow");
  const type = (text) => { field.value = text; field.dispatchEvent(new field.ownerDocument.defaultView.Event("input")); };
  // "abc" is shorter than minLength: the form's own check keeps Allow off, so a misfit reaches
  // the adapter only when the two checks disagree; force Allow on to stand in for that case
  type("abc");
  assert.equal(allow.disabled, true);
  allow.disabled = false;
  const sent = h.wire.length;
  allow.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.wire.length, sent, "misfit allow sends nothing to the server");
  assert.equal(approvals.has(ev.requestId), true, "the card stays open");
  assert.equal(card.classList.contains("settled"), false);
  assert.deepEqual(notices, [{ text: FORM_MISFIT, level: "warn" }]);
  assert.equal(h.adapter.permissionRefusal(ev.requestId, { behavior: "allow", updatedInput: { content: { name: "abc" } } }), FORM_MISFIT,
    "the request is still pending");
  // corrected: a fitting allow on the same card accepts
  type("Work calendar");
  allow.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.wire.at(-1).id, "misfit-1");
  assert.deepEqual(h.wire.at(-1).result, { action: "accept", content: { name: "Work calendar" } });
  assert.equal(approvals.has(ev.requestId), false);
  // a real deny on a fresh card still declines, whatever the form holds
  const ev2 = feedForm(h, "misfit-2");
  api.approvalCard(ev2.requestId, ev2.toolUseId, ev2.tool, ev2.input, ev2.inputBytes, ev2.suggestions);
  approvals.get(ev2.requestId).querySelector(".approval-deny").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.wire.at(-1).result, { action: "decline" });
  assert.equal(h.wire.at(-1).id, "misfit-2");
});

test("existing command and file approvals keep their payload and decision response", () => {
  const h = harness();
  const [command] = h.feed({ id: 30, method: "item/commandExecution/requestApproval", params: {
    itemId: "cmd", command: "node build.mjs", cwd: "C:/work", reason: "Run build",
    proposedExecpolicyAmendment: ["node", "build.mjs"],
  } });
  assert.equal(command.tool, "Command");
  assert.equal(command.input.command, "node build.mjs");
  assert.deepEqual(command.input.proposedExecpolicyAmendment, ["node", "build.mjs"]);
  h.adapter.encodePermission(command.requestId, { behavior: "deny" });
  assert.deepEqual(h.wire.at(-1).result, { decision: "decline" });
  h.event("item/started", { item: { id: "edit", type: "fileChange", changes: [
    { path: "test.txt", kind: { type: "update" }, diff: "-old\n+new" },
  ] } });
  const [edit] = h.feed({ id: 31, method: "item/fileChange/requestApproval", params: { itemId: "edit", reason: "Fix text" } });
  assert.equal(edit.tool, "Edit");
  assert.equal(edit.input.changes[0].diff, "-old\n+new");
  h.adapter.encodePermission(edit.requestId, { behavior: "allow" });
  assert.deepEqual(h.wire.at(-1).result, { decision: "accept" });
});

test("plan updates repaint a single shared text block per turn", () => {
  const h = harness(), transcript = document.createElement("div");
  const stream = createTextStream({ interimCandidates: [], replaying: false, hydrating: false }, {
    transcript, follow: { toBottom() {} }, append: (n, p) => (p ?? transcript).append(n),
    sealGroup() {}, toolHost: () => transcript,
  });
  const render = (plan, explanation) => {
    const [ev] = h.event("turn/plan/updated", { plan, explanation });
    assert.equal(ev.kind, "text_done");
    stream.textDone(ev.blockId, ev.markdown, ev.parentToolUseId);
  };
  render([{ step: "Read source", status: "inProgress" }, { step: "Build", status: "pending" }], "First pass");
  assert.match(transcript.textContent, /In Progress: Read source/);
  render([{ step: "Read source", status: "completed" }, { step: "Build", status: "inProgress" }], "Ready to build");
  assert.equal(transcript.children.length, 1);
  assert.match(transcript.textContent, /Completed: Read source/);
  assert.match(transcript.textContent, /In Progress: Build/);
  assert.doesNotMatch(transcript.textContent, /First pass/);
});

test("collaboration maps launch, child completion, and resume independently of tool completion", () => {
  const h = harness();
  const item = (id, tool, agentsStates, receiverThreadIds = ["child"]) => ({ id, type: "collabAgentToolCall", tool,
    status: "completed", agentsStates, receiverThreadIds, senderThreadId: "parent", prompt: "Review source" });
  const spawn = item("spawn", "spawnAgent", { child: { status: "running" } });
  const [start] = h.event("item/started", { item: spawn });
  assert.equal(start.name, "Agent");
  assert.equal(toolClass(start.name, "codex"), "agent");
  const launched = h.event("item/completed", { item: spawn });
  assert.equal(launched[0].kind, "tool_done");
  assert.deepEqual(launched.filter((e) => e.kind === "task"), [{ kind: "task", phase: "launched", taskId: "child", toolUseId: "spawn" }]);
  assert.deepEqual(h.event("item/completed", { item: spawn }).filter((e) => e.kind === "task"), []);
  const wait = item("wait", "wait", { child: { status: "completed", message: "Found a race" } });
  const done = h.event("item/completed", { item: wait }).find((e) => e.kind === "task");
  assert.deepEqual(done, { kind: "task", phase: "done", taskId: "child", toolUseId: "spawn", status: "completed", report: "Found a race" });
  const resumed = h.event("item/completed", { item: item("resume", "resumeAgent", { child: { status: "running" } }) });
  assert.deepEqual(resumed.filter((e) => e.kind === "task"), [{ kind: "task", phase: "resumed", taskId: "child", toolUseId: "resume" }]);
  const failed = h.event("item/completed", { item: item("wait2", "wait", { child: { status: "errored", message: "Failed" } }) });
  assert.equal(failed.find((e) => e.kind === "task").status, "errored");
  const unknown = h.event("item/completed", { item: item("send", "sendMessage", {}) });
  assert.equal(unknown.filter((e) => e.kind === "task").length, 0, "sending alone does not resurrect a child");
});

test("history collaboration items draw pills without resurrecting historical live agents", () => {
  const h = harness("old-thread");
  const replay = h.reply("thread/turns/list", { data: [{ id: "old-turn", items: [{
    id: "old-spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed",
    receiverThreadIds: ["old-child"], agentsStates: { "old-child": { status: "running" } }, senderThreadId: "parent",
  }] }], nextCursor: null });
  assert.ok(replay.some((e) => e.kind === "tool_start" && e.name === "Agent"));
  assert.ok(replay.some((e) => e.kind === "tool_done"));
  assert.equal(replay.filter((e) => e.kind === "task").length, 0);
});
