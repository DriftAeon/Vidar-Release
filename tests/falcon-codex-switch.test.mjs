// V3 switch: a Codex Rendered tab runs in Falcon only with the vidar.json `falcon.hostedCodex` gate
// on, the host's `codex_turns` capability, and no rules file or profile; every other case keeps
// today's in-process path. Adopts take the session's agent (gate on), and the view's C8 leftovers.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

// attachRenderedBody hands its transport to createRenderedBody: the stub captures the options and
// re-exports the real transports (set before rendered-body is imported).
const rig = { opts: null, real: null };
globalThis.__codexSwitchRig = rig;
const h = setupDom({ stubs: {
  "panels/rendered": `const r = globalThis.__codexSwitchRig;
    export const createFalconAdoptTransport = r.real.createFalconAdoptTransport;
    export const falconAgentTransport = r.real.falconAgentTransport;
    export function createRenderedBody(o) { r.opts = o; return { el: document.createElement("div"), focus() {}, dispose() {} }; }`,
} });
const transport = await import("../src/panels/rendered/transport.ts");
rig.real = { createFalconAdoptTransport: transport.createFalconAdoptTransport, falconAgentTransport: transport.falconAgentTransport };
const { AGENT_PROFILE } = await import("../src/agents/agent-profile.ts");
const { HostedCodexAdapter } = await import("../src/agents/codex-hosted.ts");
const { CodexAdapter } = await import("../src/agents/codex.ts");
const { attachRenderedBody, codexHostCapabilities, codexMayHost } = await import("../src/panels/sessions/rendered-body.ts");
const { resolveBodyKind } = await import("../src/panels/sessions/body-kind.ts");
const readopt = await import("../src/launcher/readopt.ts");
const { createHostPayload } = await import("../src/panels/rendered/host-payload.ts");
const { createCards } = await import("../src/panels/rendered/cards.ts");

const CAPS = ["codex_turns"];
const rules = { file: "C:\\v\\runtime\\rules\\built\\0123456789ab.md", codex: null, warnings: [] };
const tab = (extra) => ({
  id: "tab", agent: "codex", body: "rendered", cwd: "work",
  button: document.createElement("button"), container: document.createElement("div"), ...extra,
});
/** The transport attachRenderedBody picked (null = the in-process default). */
function picked(s, capabilities, gate) {
  readopt.setHostedCodexGate(gate);
  try {
    attachRenderedBody(s, undefined, undefined, undefined, false, capabilities);
    return rig.opts.transport;
  } finally {
    readopt.setHostedCodexGate(false);
  }
}

test("gate parse: only falcon.hostedCodex === true turns it on", () => {
  assert.equal(readopt.readHostedCodexGate({ hostedCodex: true }), true);
  for (const off of [undefined, null, true, "on", [], {}, { hostedCodex: "true" }, { hostedCodex: 1 }, { hostedCodex: false }]) {
    assert.equal(readopt.readHostedCodexGate(off), false, JSON.stringify(off));
  }
  assert.equal(readopt.hostedCodexOn(), false, "off by default");
});

test("gate off: a Codex tab stays in-process whatever the host can do", () => {
  assert.equal(picked(tab(), CAPS, false), null);
  assert.equal(codexMayHost(tab()), false, "no probe, so no host launch, with the gate off");
  assert.equal(AGENT_PROFILE.codex.falconHosted({ hostedCodex: false, capabilities: CAPS, rulesFile: null, profile: null }), false);
});

test("gate on: hosted only with codex_turns, no rules file and no profile", async () => {
  readopt.setHostedCodexGate(true);
  assert.equal(codexMayHost(tab()), true);
  assert.equal(codexMayHost(tab({ rules })), false, "a rules file stays in-process (Q5)");
  assert.equal(codexMayHost(tab({ profile: "bare" })), true, "Bare may host (codex_bare is checked at attach)");
  assert.equal(codexMayHost(tab({ profile: "other" })), false);
  assert.equal(codexMayHost(tab({ falconSession: "s1" })), false, "an adopt is already hosted");
  readopt.setHostedCodexGate(false);

  const hosted = picked(tab(), CAPS, true);
  assert.equal(hosted?.durable, true, "the Falcon transport");
  let payload;
  h.ipc.answers.falcon_spawn = (args) => { payload = args; return 4; };
  await hosted.spawn({ tabId: "tab", agent: "codex", cwd: "work", permissionMode: "default", rules, gateway: "g", profile: "p" });
  assert.equal(payload.agent, "codex");
  assert.equal(payload.rulesFile, null);
  assert.equal(Object.hasOwn(payload, "gateway"), false);
  assert.equal(payload.profile, "p", "a Codex profile now rides the spawn");

  // the fallbacks: no capability (older host or unknown), a rules file, a bare profile without codex_bare
  assert.equal(picked(tab(), null, true), null, "Falcon unavailable");
  assert.equal(picked(tab(), [], true), null, "host predates codex_turns");
  assert.equal(picked(tab({ rules }), CAPS, true), null, "rules file");
  assert.equal(picked(tab({ profile: "bare" }), CAPS, true)?.durable, undefined, "bare stays in-process");
});

test("capability probe: falcon_list's capabilities, or null when Falcon is unavailable", async () => {
  h.ipc.answers.falcon_list = { sessions: [], host_warning: null, capabilities: CAPS };
  assert.deepEqual(await codexHostCapabilities(), CAPS);
  h.ipc.answers.falcon_list = { sessions: [] }; // an older Vidar build sends none
  assert.equal(await codexHostCapabilities(), null);
  h.ipc.answers.falcon_list = () => { throw new Error("no host"); };
  assert.equal(await codexHostCapabilities(), null);
  delete h.ipc.answers.falcon_list;
});

test("adapter pick: a durable transport gets the hosted Codex adapter; Claude is unchanged", () => {
  assert.ok(AGENT_PROFILE.codex.newAdapter(true) instanceof HostedCodexAdapter);
  assert.ok(AGENT_PROFILE.codex.newAdapter(false) instanceof CodexAdapter);
  assert.ok(AGENT_PROFILE.codex.newAdapter() instanceof CodexAdapter);
  assert.equal(AGENT_PROFILE.claude.newAdapter(true).constructor, AGENT_PROFILE.claude.newAdapter().constructor);
  assert.equal(AGENT_PROFILE.claude.falconHosted({ hostedCodex: false, capabilities: null, rulesFile: null, profile: null }), true);
  // a plain Claude tab is Falcon's with the gate either way
  for (const gate of [false, true]) {
    assert.equal(picked(tab({ agent: "claude" }), null, gate), transport.falconAgentTransport);
  }
});

test("adopt kind: the session's agent with the gate on; gate off a Codex session is refused, not opened as Claude", () => {
  const codex = { agent: "codex" };
  // C3: gate off, adoptAgent still answers "claude", so every adopt path checks adoptRefusal first
  assert.notEqual(readopt.adoptRefusal(codex), null);
  assert.match(readopt.adoptRefusal(codex), /falcon\.hostedCodex/);
  assert.equal(readopt.adoptRefusal({ agent: "claude" }), null);
  readopt.setHostedCodexGate(true);
  assert.equal(readopt.adoptAgent(codex), "codex");
  assert.equal(readopt.adoptRefusal(codex), null);
  assert.equal(readopt.adoptAgent({ agent: "gemini" }), "claude");
  assert.notEqual(readopt.adoptRefusal({ agent: "gemini" }), null);
  readopt.setHostedCodexGate(false);
  assert.deepEqual(resolveBodyKind({ falconSession: "s1", agent: "codex" }), { kind: "codex", body: "rendered" });
  assert.deepEqual(resolveBodyKind({ falconSession: "s1", agent: "claude" }), { kind: "claude", body: "rendered" });
  // an adopted Codex tab: the adopt transport, so the hosted adapter
  const adopted = picked(tab({ falconSession: "s1" }), null, true);
  assert.equal(adopted.durable, true);
});

test("readopt filter: Codex sessions come back only with the gate on", () => {
  const base = {
    session: "abc-1", generation: 1, agent: "codex", cwd: "C:\\x", conversation: null, pid: 1,
    model: null, permission_mode: "default", attached: 0, exited: null,
    queued_prompts: [], pending_permissions: [], last_holder: "vidar",
  };
  const held = new Set(["abc-1"]);
  assert.equal(readopt.shouldReadopt(base), false);
  assert.equal(readopt.shouldReadoptHeld(base, held), false);
  readopt.setHostedCodexGate(true);
  assert.equal(readopt.shouldReadopt(base), true);
  assert.equal(readopt.shouldReadoptHeld(base, held), true);
  assert.equal(readopt.shouldReadopt({ ...base, agent: "gemini" }), false);
  assert.equal(readopt.shouldReadopt({ ...base, agent: "claude" }), true);
  readopt.setHostedCodexGate(false);
  assert.equal(readopt.shouldReadopt({ ...base, agent: "claude" }), true);
});

function payloadHarness() {
  const S = { hydrating: false, replaying: false, disconnected: false, inTurn: false, costTotal: 0, characterTurnOpen: false, gen: 1 };
  const root = document.createElement("div");
  const settled = [];
  const approvals = new Map();
  const deps = {
    opts: { tabId: "t1" }, transport: { durable: true }, root,
    follow: { jump() {} }, textarea: document.createElement("textarea"), approvals,
    cancelApprovals() {}, alreadyAnswered: () => false, resetTranscript: () => root.replaceChildren(), resetCache() {},
    setInTurn: (v) => { S.inTurn = v; },
    append: (n) => root.appendChild(n), sealGroup() {}, noticeBlock() {}, refreshState() {},
    emitCharacterStatus() {}, interrupt() {},
    stats: { start() {}, record() {}, end() {} }, openHydratedCards() {},
    tools: new Map(), stalePill() {},
    bang: { fromRecord: (text) => ({ runs: [], text }), hold() {} },
  };
  return { S, root, approvals, settled, hp: createHostPayload(S, deps) };
}
const rec = (body) => ({ hostRecord: { body } });

test("C8 (a): a requeued plain dispatch (no turn running) clears in-turn; a requeued steer does not", () => {
  const p = payloadHarness();
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p1", content: "one" }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p1" }));
  assert.equal(p.S.inTurn, true);
  p.hp.hostPayload(rec({ record: "prompt-requeued", prompt: "p1", content: "one", at: 0 }));
  assert.equal(p.S.inTurn, false, "in-turn stuck after a no-turn requeue");
  assert.equal(p.root.querySelectorAll(".blk-queued").length, 1, "the prompt is queued again");

  // a turn runs; a steer folded into it is refused and requeued: the turn is still running
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p1" }));
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p2", content: "two" }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p2", steered: true }));
  p.hp.hostPayload(rec({ record: "prompt-requeued", prompt: "p2", content: "two", at: 0 }));
  assert.equal(p.S.inTurn, true, "a refused steer ended the running turn");
});

// the host's reasons (src-falcon/src/session/dispatch.rs)
const TURN_END_REASON = "the agent never answered the steer, and the following turn has ended";
const CLOSE_REASON = "the agent never answered the steer before the session closed";

test("an undelivered plain dispatch clears in-turn; a released steer leaves the running turn alone", () => {
  const p = payloadHarness();
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p1", content: "one" }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p1" }));
  p.hp.hostPayload(rec({ record: "prompt-undelivered", prompt: "p1", reason: "refused" }));
  assert.equal(p.S.inTurn, false, "the dispatch's write was refused: no turn runs");

  // p2 steers into p1's turn, that turn ends, p3's turn runs, and p2's unanswered steer is
  // released while p3's turn is still running
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p2", content: "two" }));
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p3", content: "three" }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p1" }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p2", steered: true }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p3" }));
  p.hp.hostPayload(rec({ record: "prompt-undelivered", prompt: "p2", reason: TURN_END_REASON }));
  assert.equal(p.S.inTurn, true, "a released steer leaves p3's turn running");
  assert.equal(p.root.querySelectorAll(".blk-queued").length, 0, "no block is left queued");
});

const TURN_END_NOTICE = "This steer may not have reached Codex: the turn ended before Codex answered it.";
const CLOSE_NOTICE = "This steer may not have reached Codex: the session closed before Codex answered it.";

/** p1 runs a turn, p2 steers into it, and the host releases p2 unanswered for `reason`. */
const releasedSteerTrail = (reason) => [
  rec({ record: "prompt-queued", prompt: "p1", content: "one" }),
  rec({ record: "prompt-dispatched", prompt: "p1" }),
  rec({ record: "prompt-queued", prompt: "p2", content: "two" }),
  rec({ record: "prompt-dispatched", prompt: "p2", steered: true }),
  rec({ record: "prompt-undelivered", prompt: "p2", reason }),
];

/** The user's block for `text`, and the notice right under it, if any. */
function blockAndNotice(root, text) {
  const block = [...root.querySelectorAll(".blk-user")].find((b) => b.textContent.includes(text));
  const next = block?.nextElementSibling;
  return { block, notice: next?.classList.contains("blk-notice") ? next.textContent : null };
}

test("a released steer keeps its block and carries a notice, live", () => {
  for (const [reason, notice] of [[TURN_END_REASON, TURN_END_NOTICE], [CLOSE_REASON, CLOSE_NOTICE]]) {
    const p = payloadHarness();
    for (const payload of releasedSteerTrail(reason)) p.hp.hostPayload(payload);
    const shown = blockAndNotice(p.root, "two");
    assert.ok(shown.block, "the steer's block stays");
    assert.equal(shown.block.classList.contains("blk-queued"), false, "it stays settled");
    assert.equal(shown.notice, notice);
    assert.ok(shown.block.nextElementSibling.classList.contains("warn"));
  }
});

test("a released steer keeps its block and carries a notice after rehydrate", () => {
  const p = payloadHarness();
  for (const payload of releasedSteerTrail(CLOSE_REASON)) p.hp.hostPayload(payload);
  p.hp.hostPayload({ hydration: "start" });
  assert.equal(p.root.children.length, 0, "the replay starts from an empty transcript");
  for (const payload of releasedSteerTrail(CLOSE_REASON)) p.hp.hostPayload(payload);
  p.hp.hostPayload({ hydration: "end" });
  const shown = blockAndNotice(p.root, "two");
  assert.ok(shown.block, "the replayed steer's block stays");
  assert.equal(shown.notice, CLOSE_NOTICE);
  assert.equal(p.root.querySelectorAll(".blk-notice").length, 1, "one notice, not one per pass");
});

test("any other undelivered reason still removes the block", () => {
  const p = payloadHarness();
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p1", content: "one" }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p1" }));
  p.hp.hostPayload(rec({ record: "prompt-undelivered", prompt: "p1", reason: "broken pipe" }));
  assert.equal(p.root.querySelectorAll(".blk-user").length, 0);
  assert.equal(p.root.querySelectorAll(".blk-notice").length, 0);
});

test("a steer dispatched after its turn ended, then requeued, leaves in-turn false", () => {
  const p = payloadHarness();
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p1", content: "one" }));
  p.hp.hostPayload(rec({ record: "prompt-queued", prompt: "p2", content: "two" }));
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p1" }));
  assert.equal(p.S.inTurn, true);
  p.S.inTurn = false; // turn/completed: the agent event's turn end clears it
  p.hp.hostPayload(rec({ record: "prompt-dispatched", prompt: "p2", steered: true }));
  assert.equal(p.S.inTurn, false, "a steer never starts a turn");
  p.hp.hostPayload(rec({ record: "prompt-requeued", prompt: "p2", content: "two", at: 0 }));
  assert.equal(p.S.inTurn, false, "in-turn stuck after a requeued late steer");
  assert.equal(p.root.querySelectorAll(".blk-queued").length, 1, "p2 is queued again");
});

test("C8 (b): a Codex card going opened -> settled with no returned settles", () => {
  const S = { hydrating: false, stick: false, pendingApproval: null, adapter: { encodePermission: () => "line" } };
  const deps = {
    transport: { durable: true }, textarea: document.createElement("textarea"),
    follow: { toBottom() {}, jump() {}, programmatic: () => false, dispose() {} },
    tools: new Map(), approvals: new Map(), approvalQueue: [], awaiting: new Map(),
    sendEncoded: async () => true, append: (n) => document.body.appendChild(n),
    sealGroup() {}, groupRefresh() {}, stalePill() {}, refreshState() {}, noticeBlock() {}, agent: "codex",
  };
  const cards = createCards(S, deps);
  cards.approvalCard("sr:100", null, "Command", { command: "ls" }, 2, []);
  const card = deps.approvals.get("sr:100");
  card.hostSettle("opened");
  assert.equal(deps.approvals.has("sr:100"), true, "opened is not terminal");
  card.hostSettle("settled");
  assert.equal(deps.approvals.has("sr:100"), false, "settled without returned left the card pending");
  assert.equal(S.pendingApproval, null);
});

test("C8 (c): records after the exited summary still reach the view (no alive gate)", () => {
  const p = payloadHarness();
  const seen = [];
  const card = document.createElement("div");
  card.hostSettle = (state) => seen.push(state);
  p.approvals.set("sr:200", card);
  // the summary (and the body's exit) can come first; the journal's records follow
  p.hp.hostPayload(rec({ record: "exited", code: 3 }));
  p.hp.hostPayload(rec({ record: "permission-state", request: "sr:200", state: "cancelled-by-exit" }));
  assert.deepEqual(seen, ["cancelled-by-exit"]);
  // a card already folded (cancelApprovals on exit) is found by its DOM id
  globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, "\\$&") }; // jsdom has no CSS.escape
  p.approvals.clear();
  card.dataset.requestId = "sr:200";
  p.root.appendChild(card);
  p.hp.hostPayload(rec({ record: "permission-state", request: "sr:200", state: "cancelled-by-exit" }));
  assert.deepEqual(seen, ["cancelled-by-exit", "cancelled-by-exit"]);
});
