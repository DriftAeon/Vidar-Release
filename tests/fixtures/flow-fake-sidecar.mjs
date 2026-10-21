// Fake sidecar for the Rust runner's transport test.
// Speaks the same stdout/stdin JSON-line
// protocol as tools/claude-sidecar.mjs (§4.3) but has no SDK and no model: every
// scenario is driven by the *content* of the one prompt line the caller writes, so
// one process can be reused for every case in the Rust test file.
//
// stdin  (flow.rs -> fixture): {"type":"user","content":"<scenario>"} then, when a
//   scenario opens a permission, zero or more {"type":"permission_response",...} and
//   optionally {"type":"interrupt"}.
// stdout (fixture -> flow.rs): {"type":"sidecar","subtype":"ready",...} first, then
//   whatever the scenario below emits, ending (unless --hang) with a "result" message
//   and process exit.
//
// Scenarios (the prompt's content string), each a case flow.rs's transport test needs:
//   "echo"        one assistant text block "hello", then a success result "hello-done"
//   "allow:<tool>"     opens a permission_request for <tool>, waits for the response,
//                      then emits a success result "after-allow-done:<behavior>:<message>"
//                      so the test can check *what* flow.rs actually sent, not just that
//                      something non-awaiting-approval eventually happened
//   "deny:<tool>"      same shape, for testing auto-deny (AskUserQuestion/ExitPlanMode)
//   "mcp:<n>=<status>,...|<tool>"  emits system/init with mcp_servers, then opens a
//                      permission_request for <tool>; result "mcp-done:<behavior>"
//   "two-tools"        opens permission_request p1 (Bash) and p2 (Write) back to back,
//                      waits for both responses (any order), then a success result
//   "noise"            emits stream_event / effort / sidecar / user lines interleaved
//                      with real assistant text, to prove those never enter output text
//   "big-stderr"       writes 70000 bytes to stderr in chunks, then a success result
//   "is-error"         emits assistant text "partial-progress", then a result with
//                      is_error:true, errors:["boom"], no "result" text field
//   "abandon-permission"   opens a permission (like an SDK-aborted canUseTool the real
//                      sidecar would resolve locally with no stdout line at all) but,
//                      unlike "allow"/"deny", never awaits an answer — emits the result
//                      immediately, proving flow.rs clears stale pending ids on result
//   "sidecar-error-then-ok"   emits a non-fatal {type:sidecar,subtype:error} line, then
//                      real assistant text and a success result
//   "big-text"         one ~70000-byte assistant text block, echoed as the result text,
//                      to exercise the 64 KiB output cap
//   "rapid-text"       five assistant text chunks emitted back to back with no delay,
//                      to exercise the 4 Hz throttle
//   "crash-with-partial"   emits assistant text then exits (code 1) with no "result"
//                      line at all, to exercise the live-text-survives-a-crash fallback
//   "env"              reports, as the result text, a JSON object naming which of a
//                      fixed sentinel list of env var names (never values) it can see,
//                      plus CONTEXT_GATE's value — the security acceptance check
//
// --require-mcp + --fake-mcp-statuses: see the wait block after the ready line.
//
// --hang: after stdin closes, the fixture genuinely never exits on its own (a real
//   setInterval, not just an empty event loop), proving flow.rs's 5s hard-kill actually
//   has something to kill. Without --hang, the process exits only once stdin closes
//   (matching claude-sidecar.mjs's rl.on("close") -> process.exit behavior), never
//   immediately after a scenario's result — the ordering the real transport relies on.

import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const hang = argv.includes("--hang");

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function argVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

out({ type: "sidecar", subtype: "ready", pid: process.pid, model: argVal("--model") ?? null });

// --require-mcp (passed by flow's claude runner) plus --fake-mcp-statuses '[{"proxy":"pending"},…]': runs the
// real sidecar's holdFirstPrompt (tools/claude-sidecar-mcp-wait.mjs) against those mcpServerStatus() snapshots, the last
// repeating, bounded by --fake-mcp-wait-ms (default 300). Failure emits the real mcp_unavailable line and exits 1
// before any prompt is read; success falls through to the scenario. Without --fake-mcp-statuses, no wait.
if (argVal("--require-mcp") !== undefined && argVal("--fake-mcp-statuses") !== undefined) {
  const { holdFirstPrompt } = await import("../../tools/claude-sidecar-mcp-wait.mjs");
  const snapshots = JSON.parse(argVal("--fake-mcp-statuses"));
  let poll = 0;
  const getStatus = async () => {
    const snap = snapshots[Math.min(poll++, snapshots.length - 1)];
    return Object.entries(snap).map(([name, status]) => ({ name, status }));
  };
  await holdFirstPrompt(argVal("--require-mcp"), getStatus, out, {
    limitMs: Number(argVal("--fake-mcp-wait-ms") ?? 300),
    pollMs: 10,
  });
}

let closed = false;
const pending = new Map(); // id -> resolve()

function assistantText(text) {
  out({
    type: "assistant",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function successResult(text) {
  out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.001, result: text });
}

function openPermission(id, tool) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    out({ type: "permission_request", id, toolUseId: null, tool, input: {}, suggestions: [] });
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    out({ type: "sidecar", subtype: "error", message: "bad JSON on stdin" });
    return;
  }
  if (m.type === "permission_response") {
    const r = pending.get(m.id);
    if (r) {
      pending.delete(m.id);
      r(m);
    }
    return;
  }
  if (m.type === "interrupt") {
    out({ type: "sidecar", subtype: "error", message: "interrupted" });
    return;
  }
  if (m.type !== "user") return;

  const content = String(m.content ?? "");
  if (content === "echo") {
    assistantText("hello");
    successResult("hello-done");
  } else if (content.startsWith("allow:") || content.startsWith("deny:")) {
    const tool = content.split(":", 2)[1] || "Bash";
    const r = await openPermission("p1", tool);
    successResult(`after-allow-done:${r.behavior ?? ""}:${r.message ?? ""}`);
  } else if (content.startsWith("mcp:")) {
    // "mcp:<name>=<status>,<name>=<status>|<tool>": a system/init message carrying
    // mcp_servers, then a permission_request for <tool> (like a model calling it).
    const [servers, tool] = content.slice(4).split("|");
    const mcp_servers = servers
      .split(",")
      .filter(Boolean)
      .map((s) => {
        const [name, status] = s.split("=");
        return { name, status };
      });
    out({ type: "system", subtype: "init", mcp_servers });
    const r = await openPermission("p1", tool || "Bash");
    successResult(`mcp-done:${r.behavior ?? ""}`);
  } else if (content === "two-tools") {
    const a = openPermission("p1", "Bash");
    const b = openPermission("p2", "Write");
    await Promise.all([a, b]);
    successResult("two-tools-done");
  } else if (content === "noise") {
    out({ type: "stream_event", event: { type: "content_block_delta" } });
    out({ type: "effort", level: "high" });
    out({ type: "sidecar", subtype: "cache_ttl", ttl: "5m" });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } });
    assistantText("real-text");
    successResult("real-text-done");
  } else if (content === "big-stderr") {
    const chunk = "e".repeat(4096);
    for (let i = 0; i < 20; i++) process.stderr.write(chunk);
    successResult("big-stderr-done");
  } else if (content === "is-error") {
    assistantText("partial-progress");
    out({ type: "result", subtype: "error", is_error: true, total_cost_usd: 0, errors: ["boom"] });
  } else if (content === "abandon-permission") {
    // Deliberately does not await this — mirrors the SDK aborting a canUseTool
    // and the real sidecar resolving it locally with no stdout line at all, so
    // the id never gets a permission_response and would otherwise stay pending.
    openPermission("p1", "Bash");
    successResult("abandoned-done");
  } else if (content === "sidecar-error-then-ok") {
    out({ type: "sidecar", subtype: "error", message: "transient, ignore me" });
    assistantText("recovered");
    successResult("recovered-done");
  } else if (content === "big-text") {
    const big = "A".repeat(70000);
    assistantText(big);
    successResult(big);
  } else if (content === "rapid-text") {
    for (let i = 0; i < 5; i++) assistantText(`chunk${i}`);
    successResult("rapid-done");
  } else if (content === "crash-with-partial") {
    assistantText("partial-before-crash");
    process.exitCode = 1;
    process.exit(1);
  } else if (content === "env") {
    const sentinelNames = [
      "NO_COLOR", "TERM", "COLORTERM", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID", "VIDAR_CTL_TOKEN", "VIDAR_TAB",
      "VIDAR_SIDECAR_DUMP",
    ];
    const scrubbed = sentinelNames.filter((n) => process.env[n] !== undefined);
    for (const k of Object.keys(process.env)) {
      if ((k.startsWith("ANTHROPIC_") || k.endsWith("_API_KEY")) && !scrubbed.includes(k)) {
        scrubbed.push(k);
      }
    }
    successResult(JSON.stringify({ scrubbed: scrubbed.sort(), contextGate: process.env.CONTEXT_GATE ?? null }));
  } else {
    successResult("unknown-scenario");
  }

  // Exit is driven only by stdin closing (below), matching flow.rs's §4.3 step 5
  // contract (close stdin after result, then wait) — not by exiting right after
  // the scenario's own result, which would never exercise that contract.
});

rl.on("close", () => {
  closed = true;
  for (const [id, r] of pending) {
    pending.delete(id);
    r({ behavior: "deny", message: "closed" });
  }
  if (!hang) {
    out({ type: "sidecar", subtype: "closed" });
    process.exit(0);
    return;
  }
  // --hang: keep the event loop genuinely alive (not just "ignore EOF and let
  // Node exit on its own once nothing else is pending") so the Rust side's 5s
  // grace wait actually elapses and exercises the Job Object hard-kill path.
  setInterval(() => {}, 1 << 30);
});
