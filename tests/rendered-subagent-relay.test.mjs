// A subagent's pending approval reaches Relay (rendered/subagent-relay.ts): one "Agent Needs You" card
// while it waits; answering it from Relay or in chat removes the item and settles the in-chat card
// through the same buttons; a main-thread approval publishes nothing; a turn end and a tab close
// drop the item.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createCards } = await import("../src/panels/rendered/cards.ts");
const { createSubagentRelay } = await import("../src/panels/rendered/subagent-relay.ts");
const store = await import("../src/relay/store.ts");

const items = () => store.items().filter((i) => i.source === "subagent-approvals");
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(tabId = "tab-1") {
  const S = { hydrating: false, stick: false, pendingApproval: null, adapter: { encodePermission: (id, d) => JSON.stringify({ id, d }) } };
  const sent = [];
  const tools = new Map();
  const approvals = new Map();
  const relay = createSubagentRelay({ tabId, tabName: "Vidar Work", tools, approvals });
  const deps = {
    transport: { durable: false },
    textarea: document.createElement("textarea"),
    follow: { toBottom() {}, jump() {}, programmatic: () => false, dispose() {} },
    tools, approvals,
    approvalQueue: [],
    awaiting: new Map(),
    sendEncoded: async (line) => { sent.push(JSON.parse(line)); return true; },
    append: (n) => document.body.appendChild(n),
    sealGroup() {}, groupRefresh() {}, stalePill() {},
    refreshState: () => relay.sync(),
    noticeBlock() {},
    agent: "claude",
  };
  return { S, deps, sent, tools, approvals, relay, cards: createCards(S, deps) };
}

function pill(tools, id, name, host = document.body) {
  const details = document.createElement("details");
  details.className = "blk-tool tool";
  details.dataset.tool = name;
  details.appendChild(document.createElement("summary"));
  host.appendChild(details);
  const rec = { details, out: null, children: null, name, group: null, card: null };
  tools.set(id, rec);
  return rec;
}
/** An Agent pill with a child list, and one Bash call inside it. */
function agentWithChild(h, agentId = "ag1", childId = "c1") {
  const agent = pill(h.tools, agentId, "Agent");
  agent.subagentType = "Striker-O";
  agent.subagentDesc = "Fix the drawer";
  agent.children = document.createElement("div");
  agent.children.className = "tool-children";
  agent.details.appendChild(agent.children);
  return { agent, child: pill(h.tools, childId, "Bash", agent.children) };
}

test("a subagent's approval publishes one card with Agent, Tab, Tool and Request rows", () => {
  const h = harness();
  agentWithChild(h);
  h.cards.approvalCard("r1", "c1", "Bash", { command: "npm test", description: "Run the tests" }, 10, []);
  const list = items();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Agent Needs You");
  assert.equal(list[0].kind, "card");
  assert.deepEqual(list[0].view.rows, [
    ["Agent", "Striker-O · Fix the drawer"], ["Tab", "Vidar Work"], ["Tool", "Bash"], ["Request", "Run the tests"],
  ]);
  h.cards.cancelApprovals("turn ended");
  assert.equal(items().length, 0, "a turn end left the item");
});

test("Approve in Relay settles the in-chat card through its own Allow and drops the item", async () => {
  const h = harness();
  agentWithChild(h);
  h.cards.approvalCard("r2", "c1", "Bash", { command: "ls" }, 2, []);
  const card = h.approvals.get("r2");
  await items()[0].resolve({ verdict: "approve", comment: "" });
  await tick();
  assert.equal(h.approvals.has("r2"), false, "the in-chat card is still pending");
  assert.ok(card.classList.contains("allow"));
  assert.deepEqual(h.sent, [{ id: "r2", d: { behavior: "allow" } }]);
  assert.equal(items().length, 0);
});

test("Deny in Relay carries its comment as the card's reason", async () => {
  const h = harness();
  agentWithChild(h);
  h.cards.approvalCard("r3", "c1", "Bash", { command: "rm x" }, 4, []);
  await items()[0].resolve({ verdict: "deny", comment: "Not that one" });
  await tick();
  assert.deepEqual(h.sent, [{ id: "r3", d: { behavior: "deny", message: "Not that one" } }]);
  assert.equal(items().length, 0);
});

test("answering in chat drops the Relay item; a stale Relay answer sends nothing", async () => {
  const h = harness();
  const { child } = agentWithChild(h);
  h.cards.approvalCard("r4", "c1", "Bash", { command: "ls" }, 2, []);
  const [item] = items();
  child.details.querySelector(".approval-allow").click();
  await tick();
  assert.equal(items().length, 0);
  await assert.rejects(item.resolve({ verdict: "deny", comment: "" }), /Already Answered/);
  assert.equal(h.sent.length, 1);
});

test("a Relay answer keeps focus out of the composer; an in-chat click moves it in", async () => {
  const h = harness();
  const { child } = agentWithChild(h);
  document.body.appendChild(h.deps.textarea);
  const other = document.createElement("input");
  document.body.appendChild(other);
  other.focus();
  h.cards.approvalCard("r7", "c1", "Bash", { command: "ls" }, 2, []);
  await items()[0].resolve({ verdict: "approve", comment: "" });
  await tick();
  assert.equal(h.sent.length, 1);
  assert.notEqual(document.activeElement, h.deps.textarea, "a Relay answer moved focus into the composer");
  assert.equal(document.activeElement, other);
  h.cards.approvalCard("r8", "c1", "Bash", { command: "ls" }, 2, []);
  child.details.querySelector(".approval-allow").click();
  await tick();
  assert.equal(document.activeElement, h.deps.textarea, "an in-chat answer no longer focuses the composer");
});

test("a main-thread approval publishes nothing", () => {
  const h = harness();
  pill(h.tools, "m1", "Bash");
  h.cards.approvalCard("r5", "m1", "Bash", { command: "ls" }, 2, []);
  assert.equal(h.approvals.size, 1);
  assert.equal(items().length, 0);
  h.cards.cancelApprovals("turn ended");
});

test("a card that beat its child pill publishes once attached; a tab close drops it", () => {
  const h = harness("tab-2");
  h.cards.approvalCard("r6", "c9", "Bash", { command: "ls" }, 2, []); // no pill yet: parked standalone
  assert.equal(items().length, 0);
  agentWithChild(h, "ag9", "c9");
  h.cards.attachCard("c9", h.deps.awaiting.get("c9"));
  h.relay.sync();
  assert.equal(items().length, 1);
  h.relay.dispose();
  assert.equal(items().length, 0);
});
