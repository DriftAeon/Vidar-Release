// claude-sidecar-mcp-wait.mjs: holds a Flow node's first prompt until every MCP server its tool allowlist
// needs reports `connected`. Settings-sourced servers (user/project scope, e.g. `proxy`) are still `pending`
// when the CLI starts its first turn, and that turn runs without their tools (probe 2026-10-19, CLI 2.1.266:
// system/init is emitted only once the first prompt is consumed, and `Query.mcpServerStatus()` answers
// before it). Loaded only when the sidecar is given --require-mcp (Flow children); Rendered tabs never import it.
//
// Usage (claude-sidecar.mjs, first prompt generator only):
//        await (await import("./claude-sidecar-mcp-wait.mjs")).holdFirstPrompt(arg("--require-mcp"), () => q.mcpServerStatus(), out);
//   --require-mcp '["proxy",…]': the servers the node's tool allowlist names (flow/claude.rs required_mcp_args).
//   On failure it writes one line and exits 1 (flow/claude.rs fails the node with the message as-is):
//   {"type":"sidecar","subtype":"mcp_unavailable","message":"MCP server \"<name>\" is unavailable: status <s>" |
//     "… not reported by the SDK" | "… still pending after <n> s"}
// Refuses a --require-mcp that is not a JSON array of names (sidecar error line, exit 1). A status call that throws
// or hangs counts as a poll with no answer, so the wait still ends at the bound.

/** Bound on the wait for a `pending` required server, in ms. */
export const MCP_WAIT_MS = 30_000;
/** Interval between `mcpServerStatus()` polls, in ms. */
export const MCP_POLL_MS = 500;

const unavailable = (name, why) => `MCP server "${name}" is unavailable: ${why}`;

/**
 * Pure: one poll's verdict. `statuses` is `mcpServerStatus()`'s array (`{ name, status }`), or null when the
 * poll got no answer. Returns { state: "ready" }, { state: "wait" }, or { state: "fail", message }.
 * A terminal status (`failed`, `needs-auth`, `disabled`, anything not pending/connected) or a server the CLI
 * does not report fails at once; `pending` (or no answer) waits until `elapsedMs` reaches `limitMs`.
 */
export function mcpVerdict(required, statuses, elapsedMs, limitMs = MCP_WAIT_MS) {
  let firstPending = null;
  for (const name of required) {
    if (!Array.isArray(statuses)) { firstPending ??= name; continue; }
    const entry = statuses.find((s) => s?.name === name);
    if (!entry) return { state: "fail", message: unavailable(name, "not reported by the SDK") };
    const status = typeof entry.status === "string" ? entry.status : "unknown";
    if (status === "connected") continue;
    if (status === "pending") { firstPending ??= name; continue; }
    return { state: "fail", message: unavailable(name, `status ${status}`) };
  }
  if (firstPending === null) return { state: "ready" };
  if (elapsedMs >= limitMs) {
    return { state: "fail", message: unavailable(firstPending, `still pending after ${Math.round(limitMs / 1000)} s`) };
  }
  return { state: "wait" };
}

/**
 * Polls `getStatus` until `mcpVerdict` is ready (resolves null) or fails (resolves the error text).
 * `now` and `sleep` are injectable for tests.
 */
export async function waitForRequiredMcp(required, getStatus, {
  limitMs = MCP_WAIT_MS,
  pollMs = MCP_POLL_MS,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!required.length) return null;
  const start = now();
  for (;;) {
    // A status call that never answers must not outlive the bound: race it against the time left.
    const left = Math.max(0, limitMs - (now() - start));
    let timer;
    const cap = new Promise((r) => { timer = setTimeout(() => r(null), left); });
    let statuses = null;
    try { statuses = await Promise.race([getStatus(), cap]); } catch { statuses = null; }
    clearTimeout(timer);
    const verdict = mcpVerdict(required, statuses, now() - start, limitMs);
    if (verdict.state === "ready") return null;
    if (verdict.state === "fail") return verdict.message;
    await sleep(pollMs);
  }
}

/** Pure: the `--require-mcp` value as a list of server names, or null when it is not one. */
export function parseRequiredMcp(raw) {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.every((s) => typeof s === "string" && s) ? list : null;
  } catch {
    return null;
  }
}

/**
 * The sidecar's call site: resolves once the servers are ready; otherwise writes the failure line through
 * `out` and exits 1 (`exit` is injectable for tests).
 */
export async function holdFirstPrompt(raw, getStatus, out, { exit = (code) => process.exit(code), ...opts } = {}) {
  const required = parseRequiredMcp(raw);
  if (!required) {
    out({ type: "sidecar", subtype: "error", message: "--require-mcp is not a JSON array of server names" });
    return exit(1);
  }
  const message = await waitForRequiredMcp(required, getStatus, opts);
  if (message) {
    out({ type: "sidecar", subtype: "mcp_unavailable", message });
    return exit(1);
  }
}
