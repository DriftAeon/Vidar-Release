// tools/bare/probe-runes.mjs judging, on fixtures: the read, answer and markers checks decide from the
// transcript and payload, never from what the reply claims.
import test from "node:test";
import assert from "node:assert/strict";
import { FACTS, RULE, codexReadLines, firstList, judge } from "../tools/bare/probe-runes.mjs";

const payload = [
  "Intro line.",
  "",
  "# Vidar app layer (Raw tab)",
  "",
  "<!-- rune: ctl-bus-cli-pointer -->",
  "- While a Vidar tab holds the session no port is needed.",
  "<!-- rune: workbench-display-routing -->",
  "- To show the user something, put one file in display.",
  "",
  `- The paths-contract test scans tracked files only: read ${RULE}.md in skill vidar-runes (Paths Scan)`,
].join("\n");

const readLine = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `C:\\h\\skills\\vidar-runes\\${RULE}.md` } }] } });
const goodReply = `It uses ${FACTS[0]} in tools/lib/${FACTS[1]}.\n- While a Vidar tab holds the session no port is needed.\n- To show the user something, put one file in display.`;

test("the first list skips marker lines and stops at a blank line", () => {
  assert.deepEqual(firstList(payload), ["While a Vidar tab holds the session no port is needed.", "To show the user something, put one file in display."]);
});

test("a read, the body facts and a clean quoted list all pass", () => {
  const r = judge({ payload, reply: goodReply, runeReads: [RULE] }, readLine);
  assert.deepEqual(r.map(([n, v]) => `${n}:${v}`), ["read:PASS", "answer:PASS", "markers:NOTE"]);
});

test("no Read line fails read even when runeReads claims it", () => {
  assert.equal(judge({ payload, reply: goodReply, runeReads: [RULE] }, "")[0][1], "FAIL");
});

test("a quoted marker or a dropped item is a note, never a fail", () => {
  const q = judge({ payload, reply: `${goodReply}\n<!-- rune: ctl-bus-cli-pointer -->`, runeReads: [RULE] }, readLine)[2];
  assert.equal(q[1], "NOTE");
  assert.match(q[2], /quotes rune marker/);
  assert.match(judge({ payload, reply: goodReply.split("\n").slice(0, 2).join("\n"), runeReads: [RULE] }, readLine)[2][2], /drops 1\/2/);
});

// A Codex 0.164 rollout line (event_msg item_completed CommandExecution), shape copied from a Bare rollout.
const codexExec = (status, cmd, parsed) => JSON.stringify({
  timestamp: "2026-10-25T05:30:01.000Z", ordinal: 15, type: "event_msg",
  payload: { type: "item_completed", thread_id: "t", turn_id: "u", item: {
    type: "CommandExecution", id: "exec-1", process_id: "1", command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", cmd],
    cwd: "file:///C:/Temp/cwd", parsed_cmd: parsed, source: "unified_exec_startup", status, aggregated_output: "body", exit_code: 0 } },
});
const skillFile = `C:\\h\\runtime\\rune-skills\\abc\\vidar-runes\\${RULE}.md`;
const codexRead = codexExec("completed", `Get-Content -LiteralPath '${skillFile}'`, [{ type: "read", cmd: "Get-Content", name: `${RULE}.md`, path: skillFile.replace(/\\/g, "/") }]);
const codexAttempt = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", status: "completed", input: `await tools.exec_command({cmd:${JSON.stringify(`Get-Content '${skillFile}'`)}})` } });

test("codex: a completed command reading the rune passes read", () => {
  const r = judge({ payload, reply: goodReply, runeReads: [RULE] }, `{"type":"session_meta","payload":{}}\n${codexRead}\n`, "codex");
  assert.deepEqual(r.map(([n, v]) => `${n}:${v}`), ["read:PASS", "answer:PASS", "markers:NOTE"]);
  assert.match(r[0][2], /1 completed command/);
});

test("codex: a piped read the parser leaves unknown still counts from the command", () => {
  const piped = codexExec("completed", `Get-Content '${skillFile}' | Select-Object -First 40`, [{ type: "unknown", cmd: "..." }]);
  assert.equal(codexReadLines(piped, RULE).length, 1);
});

test("codex: a failed command or a tool-call attempt alone fails read, naming the attempt", () => {
  const failed = codexExec("failed", `Get-Content -LiteralPath '${skillFile}'`, [{ type: "read", path: skillFile }]);
  const r = judge({ payload, reply: goodReply, runeReads: [RULE] }, `${failed}\n${codexAttempt}\n`, "codex")[0];
  assert.equal(r[1], "FAIL");
  assert.match(r[2], /0 completed command.*1 tool call\(s\) naming it/);
  assert.equal(judge({ payload, reply: goodReply, runeReads: [RULE] }, "", "codex")[0][2], "no rollout");
});

test("codex: a Claude Read line is not a Codex read, nor the reverse", () => {
  assert.equal(judge({ payload, reply: goodReply, runeReads: [RULE] }, readLine, "codex")[0][1], "FAIL");
  assert.equal(judge({ payload, reply: goodReply, runeReads: [RULE] }, codexRead)[0][1], "FAIL");
});

test("a body inlined in the payload fails answer", () => {
  assert.match(judge({ payload: `${payload}\n${FACTS[0]}`, reply: goodReply, runeReads: [RULE] }, readLine)[1][2], /inline/);
});
