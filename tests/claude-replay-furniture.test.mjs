// Replayed agent completions (task-notification, with or without the harness preamble) and peer
// hand-backs close the agent row and never draw as user text after a reopen.
import test from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/dom-mount.mjs";

setupDom();
const { ClaudeAdapter } = await import("../src/agents/claude.ts");

const line = (content) => JSON.stringify({ type: "user", replay: true, message: { role: "user", content } });
const kinds = (evs) => evs.map((e) => e.kind);

test("replayed completion and hand-back strings are task events, not user echoes", () => {
  const a = new ClaudeAdapter();
  const note = "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>abc12345</task-id>\n<status>completed</status>\n<result>This agent's report was delivered to you as a message from \"abc12345\" (its SubagentHandback call).</result>\n</task-notification>";
  const ev = a.feed(line(note));
  assert.deepEqual(kinds(ev), ["task"], "a replayed task-notification drew as user text");
  assert.equal(ev[0].report, undefined, "the hand-back pointer became the report");

  const hb = "Another Claude session sent a message:\n<agent-message from=\"abc12345\">\nThe report follows:\n  done\n</agent-message>";
  assert.ok(!kinds(a.feed(line(hb))).includes("user_echo"), "a replayed hand-back drew as user text");

  assert.deepEqual(kinds(a.feed(line("hello"))), ["user_echo"], "ordinary replayed user text stopped drawing");
});

test("a typed task_notification's hand-back pointer summary is dropped", () => {
  // journal s890235d4 seq 3503 (2026-10-06): the SDK put the pointer in `summary`, drawn inline
  const a = new ClaudeAdapter();
  const pointer = "This agent's report was delivered to you as a message from \"abc12345\" (its SubagentHandback call). Read it there; it is not repeated here. ";
  const sys = (summary) => JSON.stringify({ type: "system", subtype: "task_notification", task_id: "abc12345", status: "completed", summary });
  assert.equal(a.feed(sys(pointer))[0].summary, undefined, "the hand-back pointer drew as the summary");
  assert.equal(a.feed(sys("Agent \"x\" finished"))[0].summary, "Agent \"x\" finished", "an ordinary summary was dropped");
});

const blocks = (...texts) => texts.map((text) => ({ type: "text", text }));

test("replayed harness furniture is a quiet notice, never a user echo", () => {
  const a = new ClaudeAdapter();
  const cases = {
    "interrupt marker": line(blocks("[Request interrupted by user]")),
    "interrupt for tool use": line(blocks("[Request interrupted by user for tool use]")),
    "no visible output nudge": line("[Your previous response had no visible output. Please continue and produce a user-visible response.]"),
    "handback enforcer": line("[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}) now, then stop."),
    "idle notice": line("[Cross-session idle notice] \"vidar-f2\", which you asked to be notified about, is idle now. This is an automated notice from that session's harness."),
    "image path": line(blocks("[Image: source: C:\\Users\\friend\\Documents\\x.png]")),
    "skill body": line("Base directory for this skill: C:\\Users\\friend\\.claude\\skills\\vidar-control\n\n# vidar-control\n\nbody"),
    "skill format flag": line(blocks("<skill-format>true</skill-format>")),
    "workflow reference": line("# Workflow authoring reference\n\nA workflow structures work across many agents."),
    "stop hook feedback": line("Stop hook feedback:\nBefore stopping: Context gate: this session is at 210190 tokens."),
    "coordinator message": line("The coordinator sent a message while you were working:\nOrchestrator: approved."),
    "cross-session message": line("Another Claude session sent a message:\n<cross-session-message from=\"uds:x\" from-name=\"main-18\">\nplease report\n</cross-session-message>"),
    "compaction summary": line("This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\nSummary:\n1. x"),
    "context report": line("## Context Usage\n\n**Model:** claude-fable-5-1  \n**Tokens:** 196.8k / 1m (20%)"),
    "tool_call task notification": line("<task-notification>\n<tool-use-id>toolu_01</tool-use-id>\n<task-type>tool_call</task-type>\n<status>completed</status>\n</task-notification>"),
  };
  for (const [name, l] of Object.entries(cases)) {
    const k = kinds(a.feed(l));
    assert.ok(!k.includes("user_echo"), `${name} drew as user text`);
  }
  // the user's words beside an attachment line still draw, minus the line
  const mixed = a.feed(line(blocks("[Image #1] look at this", "[Image: source: C:\\x.png]")));
  assert.deepEqual(mixed.map((e) => [e.kind, e.text]), [["user_echo", "[Image #1] look at this"]]);
  // a prompt that merely mentions a harness phrase is still the user's
  assert.deepEqual(kinds(a.feed(line("why did a Stop hook feedback message appear?"))), ["user_echo"]);
});
