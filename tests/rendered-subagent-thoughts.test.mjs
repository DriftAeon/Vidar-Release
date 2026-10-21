// A subagent's complete assistant records (parent_tool_use_id set) carry thinking blocks (empty
// text plus a signature, as written in the subagents/*.jsonl transcripts). The thinking event has
// no parent field, so each child record counted a Thought in the main flow's activity group, and
// the child's text sealed that group, so every child thought opened a fresh "Thought" card in the
// main flow. Child thinking is now dropped by the adapter and child text leaves the main group open.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom({
  stubs: {
    "panels/document": `export function renderMarkdownOrText(_n, md) { const el = document.createElement("div"); el.textContent = md; return { el, fellBack: null }; }`,
  },
});
globalThis.CSS ??= { escape: (s) => String(s) };
const { ClaudeAdapter } = await import("../src/agents/claude.ts");
const { createGroups } = await import("../src/panels/rendered/groups.ts");
const { createTextStream } = await import("../src/panels/rendered/text-stream.ts");

const PARENT = "toolu_01Agent";
const rec = (id, content, parent = null) =>
  JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { id, content } });
const thought = { type: "thinking", thinking: "", signature: "sig" };

function mount() {
  const S = { replaying: false, hydrating: false, curGroup: null, turnGroups: [], interimCandidates: [] };
  const transcript = document.createElement("div");
  const pillChildren = document.createElement("div");
  const append = (n, p = transcript) => p.appendChild(n);
  const groups = createGroups(S, { append, agent: "claude" });
  const text = createTextStream(S, {
    transcript, append, sealGroup: groups.sealGroup,
    follow: { toBottom: () => {} },
    toolHost: (parent) => (parent ? pillChildren : transcript),
  });
  const adapter = new ClaudeAdapter();
  // the events.ts routing of the kinds this covers
  const feed = (line) => {
    for (const ev of adapter.feed(line)) {
      if (ev.kind === "thinking") groups.thinkingBlock(ev.blockId, ev.done);
      else if (ev.kind === "text_done") text.textDone(ev.blockId, ev.markdown, ev.parentToolUseId);
    }
  };
  const groupsIn = () => transcript.querySelectorAll(":scope > details").length;
  return { S, transcript, pillChildren, feed, groupsIn, adapter };
}

test("a subagent's thinking draws no Thought card in the main flow", () => {
  const { transcript, pillChildren, feed, groupsIn } = mount();
  feed(rec("msg_c1", [thought], PARENT));
  feed(rec("msg_c2", [thought, { type: "text", text: "child note" }], PARENT));
  feed(rec("msg_c3", [thought], PARENT));
  assert.equal(groupsIn(), 0, "a child thought opened a main-flow group");
  assert.equal(transcript.textContent.includes("Thought"), false);
  assert.equal(pillChildren.textContent.includes("child note"), true, "the child's text left its pill");
});

test("the adapter emits no thinking event for a child record, and still does for the main thread", () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.feed(rec("msg_c", [thought], PARENT)).filter((e) => e.kind === "thinking"), []);
  assert.equal(a.feed(rec("msg_m", [thought])).filter((e) => e.kind === "thinking").length, 1);
});

test("child text between main thoughts keeps the main group whole", () => {
  const { S, feed, groupsIn } = mount();
  feed(rec("msg_m1", [thought]));
  const g = S.curGroup;
  assert.ok(g, "the main thread's thought opened no group");
  feed(rec("msg_c1", [{ type: "text", text: "child note" }], PARENT));
  assert.equal(S.curGroup, g, "the child's text sealed the main group");
  feed(rec("msg_m2", [thought]));
  assert.equal(groupsIn(), 1, "the main thread's second thought split into a new group");
});
