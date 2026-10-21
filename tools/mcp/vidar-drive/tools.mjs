// tools\mcp\vidar-drive\tools.mjs — the nine control-bus verbs as MCP tools.
// Tool input reaches the bus only through `build()` (tools\control\verbs.mjs): never spread
// into a payload. Tool field `timeout_s` ↔ build() `timeoutS`; every other field keeps its name.

import { resolve as resolvePath } from "node:path";
import { build, UsageError } from "../../control/verbs.mjs";
import { request } from "../../control/client.mjs";
import { RpcError, INVALID_PARAMS } from "./rpc.mjs";

// Card-gated: spawn, ordinary ask, prompt to another tab. No card: show, focus, read (own tab),
// state, wait, pending ask, unpend (src-tauri/src/control/policy.rs, src/control/listen.ts).
const CARD = "a human approves on a Vidar card";
const NO_CARD = "runs at once, no approval card";
const s = (description) => (description ? { type: "string", description } : { type: "string" });
const b = { type: "boolean" };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS = [
  { name: "state", description: "List Vidar's tabs and the active one (json:true for the JSON line).",
    inputSchema: obj({ json: b }) },
  { name: "read", description: "Read the calling tab's own live transcript tail (default 4000 bytes).",
    inputSchema: obj({ bytes: { type: "integer", minimum: 1 } }) },
  { name: "show", description: `Show a file in the Workbench Display or Document tab; ${NO_CARD}.`,
    inputSchema: obj({ path: s(), focus: b }, ["path"]) },
  { name: "focus", description: `Focus a tab by id, or the workbench; ${NO_CARD}.`,
    inputSchema: obj({ target: s("tab id or \"workbench\"") }, ["target"]) },
  { name: "prompt", description: `Send text to another tab; ${CARD}.`,
    inputSchema: obj({ tab: s(), text: s(), notify: b, report: s() }, ["tab", "text"]) },
  { name: "spawn", description: `Open a new agent tab with a first prompt (model, and brief or text, are required); ${CARD}.`,
    inputSchema: obj({ agent: s(), model: s(), effort: s("low, medium, high, xhigh or max"), cwd: s(),
      brief: s("path, absolute or relative to the session's launch directory"), text: s(), title: s(), notify: b, report: s() }, ["agent", "model"]) },
  { name: "ask", description: `Ask the user a question, optionally with choices; ${CARD}. With pending:true it posts to Relay and returns at once, no card (no placeholder); the answer arrives later as a user message.`,
    inputSchema: obj({ question: s(), choices: { type: "array", items: { type: "string" }, maxItems: 6 },
      details: { type: "array", items: { type: "string", maxLength: 120 }, maxItems: 6, description: "details[i] is a one-line description of choices[i]; needs choices, at most as many as choices, each 0-120 printable ASCII chars" },
      placeholder: s(), pending: b, context: s("with pending: what the ask is for, 1-80 printable ASCII chars") }, ["question"]) },
  { name: "unpend", description: "Withdraw your own pending Relay asks (all, or one id) after the user answered in the thread.",
    inputSchema: obj({ id: s() }) },
  { name: "wait", description: "Block until another rendered tab's turn ends (no card); report is only echoed back.",
    inputSchema: obj({ tab: s(), report: s(),
      timeout_s: { type: "number", default: 600, minimum: 1, maximum: 3600 } }, ["tab"]) },
  { name: "flow", description: "Start a straight Flow chain with approval, or observe a run without a card. A graph is {name, nodes:[{id, kind input|agent|output, title, model (agents), fields:[{k,v}], inputs, outputs}], edges:[{id, from:{node,port}, to:{node,port}}]}; x/y are optional. With a graph, input fills its single Input node's content field (refused if that node already holds different content). A node may carry addons:[{kind,label,value}], shown on the Run Flow card; e.g. addons:[{kind:\"permission-allowlist\",label:\"Allowlist\",value:\"Read,Glob\"}] lets an agent node use those exact tool names without asking. Worked Unreal MCP graph: docs/reference/flow-unreal-mcp-smoke.md. Action save adds the graph to the Flow picker without running it. Building a graph is not running it: start only on an input the user named.",
    inputSchema: obj({ action: s("start, save, status or wait"), template_id: s(), input: s(), graph: { type: "object" },
      cwd: s(), run_id: s(), timeout_s: { type: "number", minimum: 1, maximum: 3600 } }, ["action"]) },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Usage details name CLI flags; rewrite them to this server's field names. */
function fieldNames(detail) {
  return detail
    .replace(/<tab>\|workbench/g, "target")
    .replace(/--timeout\b/g, "timeout_s")
    .replace(/--choice\b/g, "choices")
    .replace(/--detail\b/g, "details")
    .replace(/--(\w+)/g, "$1")
    .replace(/<(\w+)>/g, "$1");
}

const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

function thrown(error) {
  if (error instanceof UsageError) return text(`exit 1: usage: ${fieldNames(error.message)}`, true);
  switch (error.exitCode) {
    case 2: return text(`exit 2: timeout — ${error.message}`, true);
    case 3: return text(`exit 3: bus unavailable — ${error.message}`, true);
    case 4: return text("exit 4: no token in env — not a Vidar tab", true);
    default: return text(`exit ${error.exitCode ?? 1}: ${error.message}`, true);
  }
}

/** `call(name, input)` bound to a bus `request` function (injectable for tests). */
export function makeCall(requestFn = request, launchCwd = undefined) {
  return async function call(name, input = {}) {
    const tool = typeof name === "string" ? BY_NAME.get(name) : undefined;
    if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${name}`);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new RpcError(INVALID_PARAMS, "arguments must be an object");
    }
    try {
      const allowed = tool.inputSchema.properties;
      const opts = {};
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(allowed, key)) throw new UsageError(`unknown field "${key}"`);
        opts[key === "timeout_s" ? "timeoutS" : key] = input[key];
      }
      if ((name === "spawn" || name === "flow") && launchCwd !== undefined) {
        // The server chdirs to the repo; the caller's cwd is where it was launched.
        if (opts.cwd === undefined && (name === "spawn" || opts.action === "start" || opts.action === "save")) opts.cwd = launchCwd;
        if (typeof opts.brief === "string") opts.brief = resolvePath(launchCwd, opts.brief);
      }
      const built = build(name, opts);
      const { payload, timeoutMs } = built;
      const reply = await requestFn(built.verb ?? name, payload, timeoutMs ? { timeoutMs } : undefined);
      return text(reply.line, !reply.ok || reply.line === "err timeout");
    } catch (error) {
      return thrown(error);
    }
  };
}
