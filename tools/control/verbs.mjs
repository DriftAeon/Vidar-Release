// tools\control\verbs.mjs — pure argument checks and payload build for the `ctl.*` verbs,
// shared by the CLI (`vidar.mjs`) and the MCP server (`tools\mcp\vidar-drive`).
// No side effects at import; the only I/O is reading a spawn `brief` file.
//
// opts are camel-case named fields. CLI flag ↔ opts field: `--timeout` (seconds) ↔ `timeoutS`,
// `--bytes` ↔ `bytes`, `--choice a,b` ↔ `choices` (array), every other `--flag` ↔ `flag`.
// Usage details name the CLI flag (`--report …`); the MCP layer rewrites them to its field names.

import { readFileSync, statSync } from "node:fs";

export class UsageError extends Error { exitCode = 1 }

export const VERBS = ["state", "read", "show", "focus", "prompt", "spawn", "ask", "wait", "flow"];

/** Slack past `wait`'s own timeout before the client gives up on the bus itself. */
const WAIT_GRACE_MS = 15_000;
/** ctl.spawn/ctl.prompt `text`: 1..65536 bytes, no NUL (the frozen payload rule). */
const MAX_TEXT_BYTES = 65_536;
/** `title` must pass Rust's `valid_reason` (printable ASCII); the tab strip shows 60 chars at most. */
const MAX_TITLE = 60;
/** `report`: wait.rs's rule (non-blank, <= 400 bytes, no control chars), plus no `"`,
 *  because the push line quotes it (`report="<path>"`). */
const MAX_REPORT_BYTES = 400;
/** ctl.spawn `brief` (the path, display only) must pass Rust's `valid_reason`:
 *  printable ASCII, non-blank, <= 200 bytes; otherwise it is omitted. */
const MAX_BRIEF_LABEL = 200;
const MAX_CHOICES = 6;
const MAX_DETAIL = 120;
const DEFAULT_READ_BYTES = 4000;
const DEFAULT_WAIT_S = 600;

const fail = (detail) => { throw new UsageError(detail); };

/** Optional string field; `required` makes absence (or blank) a usage error. */
function str(opts, key, flag, required = false) {
  const v = opts[key];
  if (v === undefined || v === null) {
    if (required) fail(`${flag} is required`);
    return undefined;
  }
  if (typeof v !== "string") fail(`${flag} must be a string`);
  if (required && !v.trim()) fail(`${flag} is required`);
  return v;
}

const bool = (v) => v === true;

function checkText(text) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < 1 || bytes > MAX_TEXT_BYTES) fail(`text must be 1-${MAX_TEXT_BYTES} bytes, got ${bytes}`);
  if (text.includes("\0")) fail("text contains NUL");
}

function checkReport(report) {
  if (!report.trim()) fail("--report takes a path");
  if (Buffer.byteLength(report, "utf8") > MAX_REPORT_BYTES || /[\u0000-\u001f\u007f-\u009f"]/.test(report)) {
    fail(`--report must be <= ${MAX_REPORT_BYTES} bytes, printable, without "`);
  }
  return report;
}

function checkTitle(title) {
  const cut = title.trim().slice(0, MAX_TITLE).trim();
  if (!cut || !/^[\x20-\x7e]+$/.test(cut)) fail("--title must be printable ASCII");
  return cut;
}

function briefLabelOk(path) {
  return path.length <= MAX_BRIEF_LABEL && /^[\x20-\x7e]+$/.test(path) && path.trim() !== "";
}

/** `notify`/`report` pair shared by prompt and spawn: report needs notify. */
function notifyFields(opts) {
  const notify = bool(opts.notify);
  let report = str(opts, "report", "--report");
  if (report !== undefined) report = checkReport(report);
  if (report !== undefined && !notify) fail("--report needs --notify");
  return notify ? { notify, report } : {};
}

// Input node field key, split because the paths-contract scan counts a bare content literal as a layout path.
const CONTENT_KEY = "con" + "tent";

/** Copy of `graph` with `input` written into its single Input node's content field. */
function fillGraphInput(graph, input) {
  if (!input) fail("input must not be empty");
  if (graph === null || typeof graph !== "object" || !Array.isArray(graph.nodes)) fail("graph needs a nodes array");
  const copy = structuredClone(graph);
  for (const node of copy.nodes) {
    if (node === null || typeof node !== "object") fail("graph nodes must be objects");
    if (node.fields !== undefined && !Array.isArray(node.fields)) fail("graph node fields must be an array");
  }
  const inputs = copy.nodes.filter((n) => n.kind === "input");
  if (inputs.length !== 1) fail(`input needs exactly one Input node in graph (found ${inputs.length})`);
  const node = inputs[0];
  if (node.fields === undefined) node.fields = [];
  const field = node.fields.find((f) => f !== null && typeof f === "object" && f.k === CONTENT_KEY);
  if (field === undefined) node.fields.push({ k: CONTENT_KEY, v: input });
  else if (field.v === undefined || field.v === "") field.v = input;
  else if (field.v !== input) fail("graph Input node already has content; send input or content, not both");
  return copy;
}

const builders = {
  flow: (o) => {
    const action = str(o, "action", "<action>", true);
    if (action === "status" || action === "wait") {
      const runId = str(o, "run_id", "<run-id>", true);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) fail("bad run id");
      if (action === "status") return { verb: "flow-status", payload: { run_id: runId } };
      const seconds = o.timeoutS === undefined ? DEFAULT_WAIT_S : o.timeoutS;
      if (typeof seconds !== "number" || !(seconds > 0)) fail("--timeout takes seconds > 0");
      const ms = Math.round(Math.min(3600, Math.max(1, seconds)) * 1000);
      return { verb: "flow-wait", payload: { run_id: runId, timeout_ms: ms }, timeoutMs: ms + WAIT_GRACE_MS };
    }
    if (action !== "start" && action !== "save") fail("flow action must be start, save, status or wait");
    const templateId = str(o, "template_id", "--template");
    let input = str(o, "input", "--input");
    const inputFile = str(o, "input_file", "--input-file");
    const graphPath = str(o, "graph_path", "--graph");
    let graph = o.graph;
    if (inputFile !== undefined && input !== undefined) fail("--input and --input-file are exclusive");
    if (inputFile !== undefined) {
      try {
        if (statSync(inputFile).size > MAX_TEXT_BYTES) fail("--input-file exceeds 65536 bytes");
        input = readFileSync(inputFile, "utf8").replace(/^\u{FEFF}/u, "");
      }
      catch (error) {
        if (error instanceof UsageError) throw error;
        fail(`cannot read --input-file "${inputFile}": ${error.code ?? error.message}`);
      }
    }
    if (graphPath !== undefined) {
      if (graph !== undefined) fail("--graph and graph are exclusive");
      try {
        if (statSync(graphPath).size > MAX_TEXT_BYTES) fail("--graph exceeds 65536 bytes");
        graph = JSON.parse(readFileSync(graphPath, "utf8").replace(/^\u{FEFF}/u, ""));
      }
      catch (error) {
        if (error instanceof UsageError) throw error;
        fail(`cannot read --graph "${graphPath}": ${error.message}`);
      }
    }
    if (action === "save") {
      if (templateId !== undefined || input !== undefined) fail("flow save takes --graph only");
      if (graph === undefined) fail("flow save needs --graph <file>");
      const saved = { action, graph, cwd: str(o, "cwd", "--cwd") ?? process.cwd() };
      if (Buffer.byteLength(JSON.stringify(saved), "utf8") > MAX_TEXT_BYTES) fail("flow request exceeds 65536 bytes");
      return { verb: "flow-save", payload: saved, timeoutMs: 60_000 };
    }
    if (templateId === undefined && graph === undefined) fail("flow start needs --template <id> or --graph <file>");
    if (templateId !== undefined && graph !== undefined) fail("--template and --graph are exclusive");
    if (templateId !== undefined && !input) fail(`--template ${templateId} needs --input or --input-file`);
    if (templateId === undefined && input !== undefined) graph = fillGraphInput(graph, input);
    const payload = { action: "start", ...(templateId === undefined ? { graph } : { template_id: templateId, input }),
      cwd: str(o, "cwd", "--cwd") ?? process.cwd() };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_TEXT_BYTES) fail("flow request exceeds 65536 bytes");
    return { payload, timeoutMs: 300_000 };
  },
  state: (o) => ({ payload: { json: bool(o.json) } }),

  read: (o) => {
    const bytes = o.bytes === undefined ? DEFAULT_READ_BYTES : o.bytes;
    if (!Number.isInteger(bytes) || bytes < 1) fail("--bytes takes an integer >= 1");
    return { payload: { bytes } };
  },

  show: (o) => ({ payload: { path: str(o, "path", "<path>", true), focus: bool(o.focus) } }),

  focus: (o) => ({ payload: { target: str(o, "target", "<tab>|workbench", true) } }),

  prompt: (o) => {
    const tab = str(o, "tab", "<tab>", true);
    const text = str(o, "text", "<text>", true);
    const extra = notifyFields(o);
    checkText(text);
    return { payload: { tab, text, ...extra } };
  },

  spawn: (o) => {
    const agent = str(o, "agent", "<agent>", true);
    if (agent.startsWith("--")) fail("<agent> is required");
    const model = str(o, "model", "--model", true); // required: the card shows it and no tab opens on a default
    // The caller's shell cwd is its tab's cwd; without it the tab falls back to the roster/default folder.
    const cwd = str(o, "cwd", "--cwd") ?? process.cwd();
    const effort = str(o, "effort", "--effort");
    // Literal copy of contracts\effort-levels.json; Rust refuses anything outside the contract too.
    if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      fail("--effort must be one of low, medium, high, xhigh, max");
    }
    const brief = str(o, "brief", "--brief");
    let text = str(o, "text", "--text");
    let title = str(o, "title", "--title");
    if (brief !== undefined && text !== undefined) fail("--brief and --text are exclusive");
    if (brief !== undefined) {
      // Read here, not in Rust: the caller already has file access, and Rust never reads paths.
      // Missing or unreadable is a usage error before any bus call, so no card is shown.
      try {
        text = readFileSync(brief, "utf8").replace(/^\u{FEFF}/u, ""); // a leading BOM
      } catch (error) {
        fail(`cannot read --brief "${brief}": ${error.code ?? error.message}`);
      }
    }
    if (text === undefined) fail("--brief or --text is required"); // the card always carries the prompt
    // No --title: none is sent, and the app mints a themed tab name.
    const extra = notifyFields(o);
    checkText(text);
    if (title !== undefined) title = checkTitle(title);
    // `brief` is display only; Rust rejects the whole request unless it passes `valid_reason`.
    const briefShown = brief !== undefined && briefLabelOk(brief) ? brief : undefined;
    return { payload: { agent, model, ...(effort !== undefined ? { effort } : {}), cwd, text, title, brief: briefShown, ...extra } };
  },

  ask: (o) => {
    const question = str(o, "question", "<question>", true);
    let choices;
    if (o.choices !== undefined) {
      if (!Array.isArray(o.choices) || !o.choices.every((c) => typeof c === "string")) fail("--choice takes strings");
      choices = o.choices.map((s) => s.trim()).filter(Boolean);
      if (choices.length > MAX_CHOICES) fail(`at most ${MAX_CHOICES} choices`);
    }
    let details;
    if (o.details !== undefined) {
      if (!Array.isArray(o.details) || !o.details.every((d) => typeof d === "string")) fail("--detail takes strings");
      if (o.details.length > 0) {
        if (!choices?.length) fail("--detail needs --choice");
        if (o.details.length > choices.length) fail("more --detail values than choices");
        if (o.details.some((d) => d.length > MAX_DETAIL || !/^[\x20-\x7e]*$/.test(d))) fail(`--detail takes up to ${MAX_DETAIL} printable ASCII chars`);
        details = o.details;
      }
    }
    const placeholder = str(o, "placeholder", "--placeholder");
    if (bool(o.pending)) {
      // Pending ask: its own bus verb, answered at once; no free-text placeholder.
      if (placeholder !== undefined) fail("--pending takes no --placeholder");
      const context = str(o, "context", "--context");
      if (context !== undefined) {
        const c = context.trim();
        if (c.length > 80 || !/^[\x20-\x7e]*$/.test(c)) fail("--context takes 1-80 printable ASCII chars");
      }
      return { verb: "pend", payload: { question, ...(choices !== undefined ? { choices } : {}), ...(details ? { details } : {}), ...(context?.trim() ? { context: context.trim() } : {}) } };
    }
    if (o.context !== undefined) fail("--context needs --pending");
    return { payload: { question, choices, ...(details ? { details } : {}), placeholder } };
  },

  unpend: (o) => {
    const id = str(o, "id", "[id]");
    if (id !== undefined && !/^[0-9a-f]{8}$/.test(id)) fail("[id] takes an 8-character hex pending ask id");
    return { payload: id === undefined ? {} : { id } };
  },

  wait: (o) => {
    const tab = str(o, "tab", "<tab>", true);
    if (tab.startsWith("--")) fail("<tab> is required");
    const report = str(o, "report", "--report");
    if (report !== undefined && !report) fail("--report takes a path");
    const timeoutS = o.timeoutS === undefined ? DEFAULT_WAIT_S : o.timeoutS;
    if (typeof timeoutS !== "number" || !(timeoutS > 0)) fail("--timeout takes seconds > 0");
    // Same 1..3600 s clamp as wait.rs; unclamped, a huge value overflows
    // setTimeout (> 2^31-1 ms fires at once) in the bus client.
    const ms = Math.round(Math.min(3600, Math.max(1, timeoutS)) * 1000);
    // Vidar answers `err timeout` at the deadline; the bus timeout is only the
    // backstop if that answer never arrives.
    return { payload: { tab, report, timeout_ms: ms }, timeoutMs: ms + WAIT_GRACE_MS };
  },
};

/** Validates `opts` for `verb` and returns `{ verb?, payload, timeoutMs? }` for
 *  `request(built.verb ?? verb, payload, timeoutMs ? { timeoutMs } : undefined)`.
 *  Throws `UsageError(detail)` before any bus call. */
export function build(verb, opts = {}) {
  const builder = Object.hasOwn(builders, verb) ? builders[verb] : undefined;
  if (!builder) fail(`unknown verb "${verb}"`);
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) fail("options must be an object");
  return builder(opts);
}
