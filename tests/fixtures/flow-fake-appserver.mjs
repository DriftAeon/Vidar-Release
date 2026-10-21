// Fake `codex app-server` for the Rust Flow Codex runner's transport tests (flow.rs tests).
// Spawned as `node flow-fake-appserver.mjs app-server`. Speaks newline-delimited JSON-RPC like
// the real app-server, with no model: the scenario is the text of the turn/start input.
//
// It records every method it receives in order, and checks the handshake the runner owes it:
// `initialize` (capabilities.experimentalApi true) -> `initialized` -> `thread/start` -> `turn/start`.
//
// Scenarios (the prompt text):
//   "handshake"     agent text "<methods joined by >>|<approvalPolicy>|<sandbox>|model=<model or none>"
//   "retry-error"   an `error` notification with willRetry:true, then agent text "recovered", completed
//   "approve-cmd"   item/commandExecution/requestApproval id 100 (plain), waits, then "decision:<decision>"
//   "escalate-cmd"  same, but with a reason and additionalPermissions (a sandbox escalation)
//   "user-input"    item/tool/requestUserInput id 101, waits, then the JSON of the answer it got
//   "fail"          turn/completed with status "failed" and error message "boom"
//   "argv"          agent text = the argv after `app-server`, joined by spaces
//   "mcp-call"      item/started mcpToolCall exec-1 (okprobe/echo_probe), then an
//                   mcp_tool_call mcpServer/elicitation/request id 102, then the JSON of the answer
//   "mcp-call-2"    two mcpToolCalls in flight on okprobe (exec-1 delete {path:"x"}, exec-2 echo
//                   {text:"hi"}), then an mcp_tool_call elicitation id 104 for {path:"x"}, then
//                   the JSON of the answer
//   "elicit-form"   a plain form mcpServer/elicitation/request id 103, then the JSON of the answer
// Any other text: agent message "hello" (as deltas "hel" + "lo"), completed.
//
// mcpServerStatus/list must carry threadId "t1" and a serverName (unfiltered is refused). The
// server's name picks its status: "ok*" connected; "dead*" failed with a toolsError, after
// writing "dead server <name> exited" to stderr; anything else is not reported (data: []).
//
// Exits when stdin closes, like the real app-server is expected to.

import { createInterface } from "node:readline";

const seen = [];
let threadParams = null;
const waiting = new Map(); // our server-request id -> resolve

function out(obj) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");
}
const notify = (method, params) => out({ method, params });

function agentMessage(text, id = "msg1") {
  notify("item/started", { threadId: "t1", turnId: "u1", item: { type: "agentMessage", id, text: "" } });
  notify("item/agentMessage/delta", { threadId: "t1", turnId: "u1", itemId: id, delta: text.slice(0, 3) });
  notify("item/agentMessage/delta", { threadId: "t1", turnId: "u1", itemId: id, delta: text.slice(3) });
  notify("item/completed", { threadId: "t1", turnId: "u1", item: { type: "agentMessage", id, text } });
}
function complete(status = "completed", error = null) {
  notify("turn/completed", { threadId: "t1", turn: { id: "u1", status, items: [], error } });
}
function ask(id, method, params) {
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    out({ id, method, params: { threadId: "t1", turnId: "u1", ...params } });
  });
}

async function run(text) {
  notify("turn/started", { threadId: "t1", turn: { id: "u1", status: "inProgress", items: [] } });
  notify("account/rateLimits/updated", { rateLimits: {} });
  switch (text) {
    case "handshake": {
      const p = threadParams ?? {};
      agentMessage(`${seen.join(">")}|${p.approvalPolicy}|${p.sandbox}|model=${p.model ?? "none"}`);
      return complete();
    }
    case "retry-error":
      notify("error", { threadId: "t1", turnId: "u1", willRetry: true, error: { message: "stream dropped" } });
      agentMessage("recovered");
      return complete();
    case "approve-cmd":
    case "escalate-cmd": {
      const extra = text === "escalate-cmd"
        ? { reason: "needs network", additionalPermissions: { network: { enabled: true } } }
        : { reason: null };
      const msg = await ask(100, "item/commandExecution/requestApproval",
        { itemId: "cmd1", command: "git status", cwd: process.cwd(), ...extra });
      agentMessage(`decision:${msg.result?.decision ?? JSON.stringify(msg.error ?? null)}`);
      return complete();
    }
    case "user-input": {
      const msg = await ask(101, "item/tool/requestUserInput", { itemId: "q1", questions: [{ id: "a", question: "?" }] });
      agentMessage(JSON.stringify(msg.result ?? null));
      return complete();
    }
    case "fail":
      return complete("failed", { message: "boom" });
    case "argv":
      agentMessage(process.argv.slice(3).join(" "));
      return complete();
    case "mcp-call": {
      notify("item/started", { threadId: "t1", turnId: "u1",
        item: { type: "mcpToolCall", id: "exec-1", server: "okprobe", tool: "echo_probe", status: "inProgress", arguments: { text: "hi" } } });
      const msg = await ask(102, "mcpServer/elicitation/request", {
        serverName: "okprobe", mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Echo",
          tool_params: { text: "hi" }, tool_params_display: [{ name: "text", value: "hi", display_name: "text" }] },
        message: "Allow the okprobe MCP server to run tool \"echo_probe\"?",
        requestedSchema: { type: "object", properties: {} },
      });
      agentMessage(JSON.stringify(msg.result ?? msg.error ?? null));
      return complete();
    }
    case "mcp-call-2": {
      const call = (id, tool, args) => notify("item/started", { threadId: "t1", turnId: "u1",
        item: { type: "mcpToolCall", id, server: "okprobe", tool, status: "inProgress", arguments: args } });
      call("exec-1", "delete", { path: "x" });
      call("exec-2", "echo", { text: "hi" });
      const msg = await ask(104, "mcpServer/elicitation/request", {
        serverName: "okprobe", mode: "form",
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { path: "x" } },
        message: "Allow the okprobe MCP server to run tool \"delete\"?",
        requestedSchema: { type: "object", properties: {} },
      });
      agentMessage(JSON.stringify(msg.result ?? msg.error ?? null));
      return complete();
    }
    case "elicit-form": {
      const msg = await ask(103, "mcpServer/elicitation/request", {
        serverName: "okprobe", mode: "form", _meta: null, message: "Your name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } } },
      });
      agentMessage(JSON.stringify(msg.result ?? msg.error ?? null));
      return complete();
    }
    default:
      agentMessage("hello");
      return complete();
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === undefined && m.id !== undefined) {
    const resolve = waiting.get(m.id);
    if (resolve) { waiting.delete(m.id); resolve(m); }
    return;
  }
  seen.push(m.method);
  switch (m.method) {
    case "initialize": {
      const ok = m.params?.capabilities?.experimentalApi === true;
      return out(ok ? { id: m.id, result: { userAgent: "fake" } }
        : { id: m.id, error: { code: -32600, message: "experimentalApi capability missing" } });
    }
    case "initialized":
      return;
    case "thread/start":
      if (!seen.includes("initialized")) return out({ id: m.id, error: { code: -32600, message: "not initialized" } });
      threadParams = m.params;
      out({ id: m.id, result: { thread: { id: "t1" } } });
      return notify("thread/started", { thread: { id: "t1" } });
    case "turn/start":
      if (m.params?.threadId !== "t1") return out({ id: m.id, error: { code: -32600, message: "bad threadId" } });
      out({ id: m.id, result: { turn: { id: "u1", status: "inProgress", items: [] } } });
      return void run(m.params?.input?.[0]?.text ?? "");
    case "mcpServerStatus/list": {
      const name = m.params?.serverName;
      if (m.params?.threadId !== "t1" || !name) return out({ id: m.id, error: { code: -32600, message: "unfiltered list refused by fake" } });
      const base = { name, authStatus: "unsupported", tools: {}, resources: [], resourceTemplates: [] };
      if (name.startsWith("ok")) return out({ id: m.id, result: { data: [{ ...base, runtimeStatus: "connected", toolsError: null }], nextCursor: null } });
      if (name.startsWith("dead")) {
        process.stderr.write(`dead server ${name} exited\n`);
        return out({ id: m.id, result: { data: [{ ...base, runtimeStatus: "failed", toolsError: "MCP startup failed: connection closed" }], nextCursor: null } });
      }
      return out({ id: m.id, result: { data: [], nextCursor: null } });
    }
    case "turn/interrupt":
      out({ id: m.id, result: {} });
      return complete("interrupted");
    default:
      return out({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
});
rl.on("close", () => process.exit(0));
