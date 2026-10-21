// Approval/question card DOM contract: every DRIVE_CLASS plus data-tool/data-request-id in place,
// `settled` + `approval-result` after settlement; answered/denied pill marks survive `done`.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { createCards } = await import("../src/panels/rendered/cards.ts");
const { setMark } = await import("../src/panels/rendered/marks.ts");
const { DRIVE_CLASS } = await import("../src/panels/rendered-drive.ts");

function harness({ durable = false, agent = "claude" } = {}) {
  const S = { hydrating: false, stick: false, pendingApproval: null, adapter: { encodePermission: () => "line" } };
  const nodes = [];
  const transcript = document.createElement("div");
  const deps = {
    transport: { durable },
    textarea: document.createElement("textarea"),
    follow: { toBottom() {}, jump() {}, programmatic: () => false, dispose() {} },
    tools: new Map(),
    approvals: new Map(),
    approvalQueue: [],
    awaiting: new Map(),
    sendEncoded: async () => true,
    append: (n) => { nodes.push(n); transcript.appendChild(n); },
    sealGroup: () => {},
    groupRefresh: () => {},
    stalePill: () => {},
    refreshState: () => {},
    noticeBlock: () => {},
    agent,
  };
  return { S, deps, nodes, cards: createCards(S, deps) };
}

function pill(deps, id) {
  const details = document.createElement("details");
  details.className = "tool running";
  details.appendChild(document.createElement("summary"));
  deps.tools.set(id, { details, out: null, children: null, name: "Bash", group: null, card: null });
  return details;
}

test("approval card: drive classes and dataset in place, then settled + result", () => {
  const h = harness();
  h.cards.approvalCard("req-1", undefined, "Bash", { command: "ls" }, 2, []);
  const card = h.nodes[0];
  assert.ok(card.classList.contains(DRIVE_CLASS.card));
  assert.ok(card.classList.contains("card"));
  assert.equal(card.dataset.tool, "Bash");
  assert.equal(card.dataset.requestId, "req-1");
  for (const k of ["allow", "deny", "message"]) assert.ok(card.querySelector("." + DRIVE_CLASS[k]), k);
  assert.ok(card.querySelector(".approval-head .approval-title"));
  assert.ok(card.querySelector(".approval-body"));
  assert.ok(!card.classList.contains(DRIVE_CLASS.settled));
  card.querySelector("." + DRIVE_CLASS.allow).click();
  assert.ok(card.classList.contains(DRIVE_CLASS.settled));
  assert.ok(card.classList.contains("allow"));
  assert.equal(card.querySelector("." + DRIVE_CLASS.result).textContent, "Allowed");
});

test("exit cancellation folds approval cards as Session Ended on both transports", () => {
  for (const durable of [true, false]) {
    const h = harness({ durable, agent: "codex" });
    h.cards.approvalCard("req-exit", undefined, "Command", { command: "ls" }, 2, []);
    const card = h.nodes[0];
    h.cards.cancelApprovals(h.cards.AGENT_EXITED);
    const result = card.querySelector(".approval-result");
    assert.ok(card.classList.contains(DRIVE_CLASS.settled));
    assert.equal(card.querySelector(".approval-inline").textContent, "Session Ended");
    assert.equal(result.textContent, "Session Ended");
    assert.equal(result.title, "Session Ended");
    assert.equal(result.querySelector("svg title").textContent, "Session Ended");
  }
});

test("live silent resolution keeps the agent-resolved label", () => {
  const h = harness({ durable: true, agent: "codex" });
  h.cards.approvalCard("req-resolved", undefined, "Command", { command: "ls" }, 2, []);
  const card = h.nodes[0];
  card.settle({ behavior: "allow" }, true);
  assert.equal(card.querySelector(".approval-result").textContent, "Resolved by the agent");
});

test("a user denial note matching the exit reason remains a denial", () => {
  const h = harness({ agent: "codex" });
  h.cards.approvalCard("req-denied", undefined, "Command", { command: "ls" }, 2, []);
  const card = h.nodes[0];
  card.querySelector("." + DRIVE_CLASS.message).value = h.cards.AGENT_EXITED;
  card.querySelector("." + DRIVE_CLASS.deny).click();
  assert.equal(card.querySelector(".approval-result").textContent, "Denied: agent exited");
});

test("MCP elicitation card shows its server and accepts a URL request", () => {
  const h = harness();
  let sent;
  h.S.adapter.encodePermission = (_id, decision) => { sent = decision; return "line"; };
  h.cards.approvalCard("mcp-url", undefined, "MCP Elicitation", {
    serverName: "proxy", mode: "url", message: "Open the authorization page", url: "https://example.test/approve",
  }, 100, []);
  const card = h.nodes[0];
  assert.match(card.textContent, /MCP Permission/);
  assert.match(card.textContent, /Proxy Server/);
  assert.doesNotMatch(card.textContent, /Server: proxy/); // the head chip names the server once
  assert.match(card.textContent, /Open the authorization page/);
  card.querySelector("." + DRIVE_CLASS.allow).click();
  assert.deepEqual(sent, { behavior: "allow" });
});

test("MCP form card requires its fields and sends typed content", () => {
  const h = harness();
  let sent;
  h.S.adapter.encodePermission = (_id, decision) => { sent = decision; return "line"; };
  h.cards.approvalCard("mcp-form", undefined, "MCP Elicitation", {
    serverName: "proxy", mode: "form", message: "Approve Unreal tool use?",
    requestedSchema: { type: "object", properties: { approved: { type: "boolean", title: "Approve" } }, required: ["approved"] },
  }, 100, []);
  const card = h.nodes[0];
  const allow = card.querySelector("." + DRIVE_CLASS.allow);
  assert.equal(allow.disabled, true);
  const field = card.querySelector(".mcp-field select");
  field.value = "true";
  field.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(allow.disabled, false);
  allow.click();
  assert.deepEqual(sent, { behavior: "allow", updatedInput: { content: { approved: true } } });
});

test("unsupported MCP form keeps Allow disabled after field changes", () => {
  const h = harness();
  h.cards.approvalCard("mcp-unsupported", undefined, "MCP Elicitation", {
    serverName: "proxy", mode: "openai/form", unsupportedReason: "Unsupported field",
    requestedSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  }, 100, []);
  const card = h.nodes[0];
  const allow = card.querySelector("." + DRIVE_CLASS.allow);
  const field = card.querySelector(".mcp-field input");
  field.value = "ready";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(allow.disabled, true);
  assert.match(card.textContent, /Unsupported field/);
});

test("question card: question and option classes in place", () => {
  const h = harness();
  const input = { questions: [{ question: "Which?", header: "H", options: [{ label: "A" }, { label: "B" }] }] };
  h.cards.approvalCard("req-2", undefined, "AskUserQuestion", input, 10, []);
  const card = h.nodes[0];
  assert.equal(card.dataset.tool, "AskUserQuestion");
  assert.equal(card.querySelectorAll("." + DRIVE_CLASS.question).length, 1);
  assert.equal(card.querySelectorAll("." + DRIVE_CLASS.option).length, 2);
  card.querySelector("." + DRIVE_CLASS.option).click();
  card.querySelector("." + DRIVE_CLASS.allow).click();
  assert.ok(card.classList.contains(DRIVE_CLASS.settled));
  assert.equal(card.querySelector("." + DRIVE_CLASS.result).textContent, "Answered");
});

test("question option with a description: label matches in the snapshot and the drive-click path", () => {
  const h = harness();
  const input = { questions: [{ question: "Colour?", header: "Question", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] };
  h.cards.approvalCard("r6", undefined, "AskUserQuestion", input, 10, []);
  const card = h.nodes[0];
  const opts = [...card.querySelectorAll("." + DRIVE_CLASS.question + " ." + DRIVE_CLASS.option)];
  assert.ok(opts[0].textContent.includes("warm"), "visible text carries the description");
  // the two readers, exactly as rendered.ts (snapshot) and drive.ts (click) spell them
  assert.deepEqual(opts.map((b) => b.dataset.label ?? b.textContent), ["Red", "Blue"]);
  const hit = opts.find((b) => (b.dataset.label ?? b.textContent) === "Blue");
  assert.ok(hit);
  hit.click();
  assert.ok(hit.classList.contains("on"));
  assert.ok(!opts[0].classList.contains("on"));
  assert.equal(card.querySelector(".q-tag"), null, "the header chip is never shown");
  card.querySelector("." + DRIVE_CLASS.allow).click();
  assert.equal(card.querySelector("." + DRIVE_CLASS.result).textContent, "Answered");
});

test("recommended option: star replaces the suffix, dataset.label and the answer keep it", () => {
  const h = harness();
  const input = { questions: [{ question: "Side?", header: "Icon side", options: [{ label: "Left (Recommended)", description: "first" }, { label: "Right" }] }] };
  h.cards.approvalCard("r7", undefined, "AskUserQuestion", input, 10, []);
  const card = h.nodes[0];
  const opts = [...card.querySelectorAll("." + DRIVE_CLASS.option)];
  assert.equal(opts[0].dataset.label, "Left (Recommended)");
  assert.equal(opts[0].querySelector("b").textContent, "Left");
  assert.equal(opts[0].querySelector(".icn").title, "Recommended");
  assert.equal(opts[1].querySelector(".icn"), null);
  opts[0].click();
  assert.ok(opts[0].classList.contains("on"));
});

test("answered Ask result: pairs parse, star on Recommended, unparsed text yields no block", async () => {
  const { askAnswersBlock } = await import("../src/panels/rendered/ask-answers.ts");
  const text = 'Your questions have been answered: "Which side?"="Icon first (Recommended)", "Pick?"="A, B". You can now continue.';
  const box = askAnswersBlock(text);
  assert.equal(box.querySelectorAll(".ask-answer").length, 2);
  assert.equal(box.querySelector(".ask-answer b").textContent, "Icon first");
  assert.equal(box.querySelector(".icn").title, "Recommended");
  assert.equal(askAnswersBlock("User declined to answer"), null);
});

test("pill marks: denied and answered stick over done; plain allow ends done", () => {
  const h = harness();
  const d = pill(h.deps, "t1");
  h.cards.approvalCard("r3", "t1", "Bash", { command: "rm x" }, 4, []);
  assert.ok(d.classList.contains("awaiting"));
  assert.equal(d.dataset.mark, "awaiting");
  h.nodes.length = 0;
  d.querySelector("." + DRIVE_CLASS.deny).click();
  assert.ok(d.classList.contains("denied"));
  assert.ok(!d.classList.contains("awaiting"));
  setMark(d, "done");
  assert.ok(d.classList.contains("denied"), "legacy denied class kept");
  assert.equal(d.dataset.mark, "denied");

  const q = pill(h.deps, "t2");
  h.cards.approvalCard("r4", "t2", "AskUserQuestion", { questions: [{ question: "Q", options: [{ label: "A" }] }] }, 4, []);
  q.querySelector("." + DRIVE_CLASS.option).click();
  q.querySelector("." + DRIVE_CLASS.allow).click();
  assert.ok(q.classList.contains("answered"));
  setMark(q, "done");
  assert.equal(q.dataset.mark, "answered");

  const a = pill(h.deps, "t3");
  h.cards.approvalCard("r5", "t3", "Bash", { command: "ls" }, 2, []);
  a.querySelector("." + DRIVE_CLASS.allow).click();
  assert.equal(a.dataset.mark, "running");
  setMark(a, "done");
  assert.equal(a.dataset.mark, "done");
  assert.ok(a.classList.contains("done") && !a.classList.contains("running"));
});
