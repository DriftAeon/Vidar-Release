// Hosted Codex adapter (codex-hosted.ts): the same golden wire draws the same AgentEvents hosted as
// in-process, the hosted view never writes a line, and user actions leave in the sidecar vocabulary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { HostedCodexAdapter } = await import("../src/agents/codex-hosted.ts");

const golden = JSON.parse(readFileSync(new URL("./fixtures/falcon-codex/golden-wire.json", import.meta.url), "utf8"));

/** In-process: the handshake answered, then every step fed; replies take the pending request's id. */
function inProcess() {
  const adapter = new CodexAdapter();
  const wire = [];
  adapter.attach((line) => wire.push(JSON.parse(line)));
  const pending = (method) => wire.findLast((m) => m.method === method).id;
  adapter.start(golden.start);
  adapter.feed(JSON.stringify({ id: pending("initialize"), result: {} }));
  adapter.feed(JSON.stringify({ id: pending("account/read"), result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } }));
  return golden.steps.map((step) => {
    if (step.user) { adapter.encodeUser(step.user); return []; }
    if (step.raw) return adapter.feed(step.raw);
    const line = step.replyTo ? { ...step.line, id: pending(step.replyTo) } : step.line;
    return adapter.feed(JSON.stringify(line));
  });
}

/** Hosted: every step fed as the host journaled it; a user step is the host's to run. */
function hosted(adapter) {
  adapter.start(golden.start);
  return golden.steps.map((step) => {
    if (step.user) return [];
    return adapter.feed(step.raw ?? JSON.stringify(step.line));
  });
}

test("the golden wire gives the same AgentEvents hosted as in-process", () => {
  const expected = inProcess();
  const wrapper = new HostedCodexAdapter();
  wrapper.attach(() => assert.fail("the hosted adapter never sends on its own"));
  const actual = hosted(wrapper);
  golden.steps.forEach((step, i) => assert.deepEqual(actual[i], expected[i], `step ${i}: ${JSON.stringify(step).slice(0, 120)}`));
  // the fixture reaches every branch the parity claim covers
  const kinds = new Set(expected.flat().map((ev) => ev.kind));
  for (const kind of ["session", "effort", "turn_start", "thinking", "tool_start", "tool_done", "approval", "approval_done",
    "text_delta", "text_done", "rate_limit", "notice", "turn_done", "unknown"]) assert.ok(kinds.has(kind), `golden covers ${kind}`);
});

test("the hosted view writes nothing: no handshake, no request, no server-request answer", () => {
  const view = new CodexAdapter({ hosted: true });
  const writes = [];
  view.attach((line) => writes.push(line));
  hosted(view);
  view.encodePermission("sr:41", { behavior: "allow" });
  view.encodeUser("Queued locally");
  view.encodeInterrupt();
  assert.deepEqual(writes, []);
});

test("a hosted reply is read by its shape, never by a request id it did not send", () => {
  const view = new HostedCodexAdapter();
  view.attach(() => {});
  view.start({ cwd: "C:/work", permissionMode: "plan" });
  assert.deepEqual(view.feed(JSON.stringify({ method: "skills/changed", params: {} })), []); // in-process: a skills/list
  // host ids that match nothing here (or what in-process would have pending) are read by shape
  const [session] = view.feed(JSON.stringify({ id: 999, result: { thread: { id: "thr-9" }, model: "gpt-5.5" } }));
  assert.equal(session.kind, "session");
  assert.equal(session.sessionId, "thr-9");
  assert.equal(session.permissionMode, "plan");
  assert.deepEqual(view.feed(JSON.stringify({ id: 1, result: { userAgent: "codex" } })), [], "initialize is the host's");
  assert.deepEqual(view.feed(JSON.stringify({ id: 5, result: {} })), [], "an interrupt ack is the host's");
  // the host settles a failed request as a record; the view shows no second failure
  assert.deepEqual(view.feed(JSON.stringify({ id: 6, error: { message: "turn refused" } })),
    [{ kind: "notice", text: "Codex: turn refused", level: "info", quiet: true }]);
});

test("a falcon/models page gives the models event an in-process model/list reply gives", () => {
  const data = [
    { model: "gpt-5.5", displayName: "gpt-5.5", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
    { model: "gpt-hidden", hidden: true },
  ];
  const local = new CodexAdapter();
  const wire = [];
  local.attach((line) => wire.push(JSON.parse(line)));
  local.start({ cwd: "C:/work", permissionMode: "default" });
  local.feed(JSON.stringify({ id: wire.findLast((m) => m.method === "initialize").id, result: {} }));
  const pending = () => wire.findLast((m) => m.method === "model/list").id;
  const expectedPartial = local.feed(JSON.stringify({ id: pending(), result: { data: data.slice(0, 1), nextCursor: "c2" } }));
  const expectedFinal = local.feed(JSON.stringify({ id: pending(), result: { data: data.slice(1) } }));

  const view = new HostedCodexAdapter();
  view.attach(() => assert.fail("the Rust client pages the catalog, not the view"));
  view.start({ cwd: "C:/work", permissionMode: "default" });
  const page = (result) => view.feed(JSON.stringify({ method: "falcon/models", params: { result } }));
  assert.deepEqual(page({ data: data.slice(0, 1), nextCursor: "c2" }), expectedPartial);
  assert.deepEqual(page({ data: data.slice(1) }), expectedFinal);
  assert.equal(expectedFinal[0].kind, "models");
  assert.equal(expectedFinal[0].partial, undefined);
  assert.deepEqual(expectedFinal[0].models.map((m) => m.value), ["gpt-5.5"]);
});

test("a falcon/skills reply gives the commands event an in-process skills/list reply gives, and a skill prompt leaves as items", () => {
  const data = [{ cwd: "C:/work", skills: [
    { name: "build.plan", path: "C:/work/plan/SKILL.md", enabled: true },
    { name: "off", path: "C:/work/off/SKILL.md", enabled: false },
  ] }];
  const local = new CodexAdapter();
  const wire = [];
  local.attach((line) => wire.push(JSON.parse(line)));
  local.start({ cwd: "C:/work", permissionMode: "default" });
  local.feed(JSON.stringify({ id: wire.findLast((m) => m.method === "initialize").id, result: {} }));
  const expected = local.feed(JSON.stringify({ id: wire.findLast((m) => m.method === "skills/list").id, result: { data } }));
  assert.equal(expected[0].kind, "commands");

  const view = new HostedCodexAdapter();
  view.attach(() => assert.fail("the Rust client asks for the catalog, not the view"));
  view.start({ cwd: "C:/work", permissionMode: "default" });
  assert.deepEqual(view.feed(JSON.stringify({ method: "falcon/skills", params: { result: { data } } })), expected);
  assert.equal(view.encodeUser("/build.plan tidy"), JSON.stringify({ type: "user", content: [
    { type: "text", text: "/build.plan tidy" },
    { type: "skill", name: "build.plan", path: "C:/work/plan/SKILL.md" },
  ] }));
  assert.equal(view.encodeUser("/off x"), JSON.stringify({ type: "user", content: "/off x" }), "a disabled skill is plain text");
  assert.equal(view.encodeUser("/unknown"), JSON.stringify({ type: "user", content: "/unknown" }));
});

test("hosted user actions leave as the sidecar lines Falcon's bridge maps", () => {
  const adapter = new HostedCodexAdapter();
  adapter.attach(() => {});
  adapter.start(golden.start);
  assert.equal(adapter.encodeUser("Hello"), JSON.stringify({ type: "user", content: "Hello" }));
  assert.equal(adapter.encodeInterrupt(), JSON.stringify({ type: "interrupt" }));
  assert.equal(adapter.encodeSetModel("gpt-5.5"), JSON.stringify({ type: "set_model", model: "gpt-5.5" }));
  assert.equal(adapter.encodeSetEffort("high"), JSON.stringify({ type: "set_effort", level: "high" }));
  assert.equal(adapter.encodeSetPermissionMode("auto"), JSON.stringify({ type: "set_permission_mode", mode: "auto" }));
  assert.equal(adapter.encodePermission("sr:41", { behavior: "deny", message: "No" }),
    JSON.stringify({ type: "permission_response", id: "sr:41", behavior: "deny", message: "No" }));
  assert.equal("encodeLogin" in adapter, false, "login stays in-process");
  assert.equal("loginReady" in adapter, false);
});

test("an answered hosted card settles once, as it does in-process", () => {
  const adapter = new HostedCodexAdapter();
  adapter.attach(() => {});
  adapter.start(golden.start);
  adapter.feed(JSON.stringify({ id: 2, result: { thread: { id: "thr-1" } } }));
  const [card] = adapter.feed(JSON.stringify({ id: 41, method: "item/commandExecution/requestApproval",
    params: { threadId: "thr-1", turnId: "turn-1", itemId: "cmd-2", command: "git push" } }));
  assert.equal(card.kind, "approval");
  adapter.encodePermission(card.requestId, { behavior: "allow" });
  assert.deepEqual(adapter.feed(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thr-1", requestId: 41 } })), []);
  const done = adapter.feed(JSON.stringify({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: "turn-1", status: "completed" } } }));
  assert.deepEqual(done.filter((ev) => ev.kind === "approval_done"), []);
});

test("a hosted mode pick reaches the next session line", () => {
  const adapter = new HostedCodexAdapter();
  adapter.attach(() => {});
  adapter.start(golden.start);
  adapter.encodeSetPermissionMode("acceptEdits");
  adapter.hostRecord(accepted(1, "set_permission_mode", { type: "set_permission_mode", mode: "acceptEdits" }));
  adapter.hostRecord(settled(1, "applied"));
  const [session] = adapter.feed(JSON.stringify({ id: 2, result: { thread: { id: "thr-1" } } }));
  assert.equal(session.permissionMode, "acceptEdits");
});

const accepted = (command, kind, payload) => ({ record: "command-accepted", command, client: "vidar", kind, payload });
const settled = (command, outcome, message = null) => ({ record: "command-settled", command, outcome, message });
function started() {
  const adapter = new HostedCodexAdapter();
  adapter.attach(() => {});
  adapter.start(golden.start);
  return adapter;
}

test("applied setter pairs become the events the panel settles on, with the payload's value", () => {
  const adapter = started();
  assert.deepEqual(adapter.hostRecord(accepted(1, "set_model", { type: "set_model", model: "gpt-5.5" })), []);
  assert.deepEqual(adapter.hostRecord(settled(1, "applied")), [{ kind: "model_set", model: "gpt-5.5" }]);
  adapter.hostRecord(accepted(2, "set_permission_mode", { type: "set_permission_mode", mode: "auto" }));
  assert.deepEqual(adapter.hostRecord(settled(2, "applied")), [{ kind: "mode", mode: "auto", ack: true }]);
  adapter.hostRecord(accepted(3, "set_effort", { type: "set_effort", level: "high" }));
  assert.deepEqual(adapter.hostRecord(settled(3, "applied")), [{ kind: "effort", level: "high" }]);
  // the view took the applied values
  const [session] = adapter.feed(JSON.stringify({ id: 2, result: { thread: { id: "thr-1" } } }));
  assert.equal(session.permissionMode, "auto");
});

test("a failed or unknown setter pair emits nothing and leaves the view unchanged", () => {
  const adapter = started();
  adapter.encodeSetPermissionMode("auto");
  adapter.hostRecord(accepted(1, "set_permission_mode", { type: "set_permission_mode", mode: "auto" }));
  assert.deepEqual(adapter.hostRecord(settled(1, "failed", "refused")), []);
  adapter.hostRecord(accepted(2, "set_model", { type: "set_model", model: "gpt-x" }));
  assert.deepEqual(adapter.hostRecord(settled(2, "delivery-unknown")), []);
  const [session] = adapter.feed(JSON.stringify({ id: 2, result: { thread: { id: "thr-1" } } }));
  assert.equal(session.permissionMode, golden.start.permissionMode);
});

test("a settle with no accepted record, or for another kind or generation, emits nothing", () => {
  const adapter = started();
  assert.deepEqual(adapter.hostRecord(settled(9, "applied")), []);
  adapter.hostRecord(accepted(4, "user", { type: "user" }), 1);
  assert.deepEqual(adapter.hostRecord(settled(4, "applied"), 1), []);
  adapter.hostRecord(accepted(5, "set_model", { type: "set_model", model: "gpt-5.5" }), 1);
  assert.deepEqual(adapter.hostRecord(settled(5, "applied"), 2), []);
  assert.deepEqual(adapter.hostRecord(settled(5, "applied"), 1), [{ kind: "model_set", model: "gpt-5.5" }]);
});

test("a permission-mode-changed record is a mode ack; an unknown mode is ignored", () => {
  const adapter = started();
  assert.deepEqual(adapter.hostRecord({ record: "permission-mode-changed", mode: "default" }), [{ kind: "mode", mode: "default", ack: true }]);
  assert.deepEqual(adapter.hostRecord({ record: "permission-mode-changed", mode: "bogus" }), []);
});

test("the router hands a hostRecord to the adapter and feeds its events to the tab", async () => {
  const { deliver } = await import("../src/panels/rendered/host-router.ts");
  const adapter = started();
  const handled = [];
  const route = { gen: 1, floor: 0, handle: (ev) => handled.push(ev), dropped() {}, exit() {}, adapter, host() {} };
  deliver(route, { hostRecord: { body: accepted(7, "set_effort", { type: "set_effort", level: "low" }) }, gen: 1 });
  deliver(route, { hostRecord: { body: settled(7, "applied") }, gen: 1 });
  assert.deepEqual(handled, [{ kind: "effort", level: "low" }]);
});

test("the hosted view refuses a misfit permission answer like the in-process one", () => {
  const adapter = started();
  assert.equal(typeof adapter.permissionRefusal, "function");
  assert.equal(adapter.permissionRefusal("none", { behavior: "deny" }), new CodexAdapter({ hosted: true }).permissionRefusal("none", { behavior: "deny" }));
});

test("host history envelopes identify a resumed thread and replay before live output", () => {
  const adapter = new HostedCodexAdapter();
  adapter.attach(() => assert.fail("host owns paging"));
  adapter.start({ cwd: "C:/work", permissionMode: "default", resume: "thr-old" });
  const feed = (params) => adapter.feed(JSON.stringify(params));
  const [session] = feed({ method: "falcon/thread", params: { resumed: true,
    result: { thread: { id: "thr-old" }, model: "gpt-live" } } });
  assert.equal(session.kind, "session");
  assert.equal(session.sessionId, "thr-old");
  assert.deepEqual(feed({ method: "falcon/history", params: { phase: "start" } }),
    [{ kind: "replay", phase: "start", count: 0 }]);
  const turn = feed({ method: "falcon/history", params: { phase: "turn", turn: { id: "t1", items: [
    { type: "userMessage", content: [{ type: "text", text: "Earlier prompt" }] },
  ] } } });
  assert.ok(turn.some((ev) => ev.kind === "user_echo" && ev.text === "Earlier prompt"));
  assert.deepEqual(feed({ method: "falcon/history", params: { phase: "end", count: 1, truncated: false } }),
    [{ kind: "replay", phase: "end", count: 1, truncated: undefined }]);
});

// ---- Codex Bare opens hosted (F1 2b) ----
const { AGENT_PROFILE, codexHostShape } = await import("../src/agents/agent-profile.ts");
const bareCaps = ["codex_turns", "codex_bare"];
const check = (over) => ({ hostedCodex: true, capabilities: bareCaps, rulesFile: null, profile: "bare", ...over });

test("hosted on + Bare row + a host that lists codex_bare: the tab is hosted and carries the profile", () => {
  assert.equal(codexHostShape(check()), true);
  assert.equal(AGENT_PROFILE.codex.falconHosted(check()), true);
});

test("hosted off: the Bare row stays in-process, however capable the host", () => {
  assert.equal(codexHostShape(check({ hostedCodex: false })), false);
  assert.equal(AGENT_PROFILE.codex.falconHosted(check({ hostedCodex: false })), false);
});

test("an old host (no codex_bare), no capabilities, a rules file or another profile stay in-process", () => {
  assert.equal(AGENT_PROFILE.codex.falconHosted(check({ capabilities: ["codex_turns"] })), false);
  assert.equal(AGENT_PROFILE.codex.falconHosted(check({ capabilities: null })), false);
  assert.equal(AGENT_PROFILE.codex.falconHosted(check({ rulesFile: "C:/r.md" })), false);
  assert.equal(codexHostShape(check({ profile: "other" })), false);
  assert.equal(codexHostShape(check({ profile: "Bare" })), false);
});

test("a plain Codex tab is unchanged: codex_turns alone hosts it", () => {
  assert.equal(AGENT_PROFILE.codex.falconHosted(check({ profile: null, capabilities: ["codex_turns"] })), true);
});

test("re-adopt keeps the Codex profile and row key; the A5 save path skips hosted tabs", () => {
  const hosted = readFileSync(new URL("../src/launcher/hosted.ts", import.meta.url), "utf8");
  assert.match(hosted, /profile: s\.profile,/);
  assert.match(hosted, /rowKey: s\.profile \? s\.row_key : undefined,/);
  assert.doesNotMatch(hosted, /agent === "codex" \? undefined : s\.profile/);
  const save = readFileSync(new URL("../src/panels/sessions/codex-save.ts", import.meta.url), "utf8");
  assert.match(save, /if \(s\.falconSession \|\| s\.rendered\?\.hosted\(\)\) continue;/);
});
