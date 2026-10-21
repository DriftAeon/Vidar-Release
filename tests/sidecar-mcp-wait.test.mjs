// tools/claude-sidecar-mcp-wait.mjs: the Flow sidecar's wait for required MCP servers before the first prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpVerdict, waitForRequiredMcp, holdFirstPrompt, parseRequiredMcp, MCP_WAIT_MS } from "../tools/claude-sidecar-mcp-wait.mjs";

const s = (obj) => Object.entries(obj).map(([name, status]) => ({ name, status }));

/** A fake clock: sleep advances it, so the bound is reached without real time passing. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("verdict: connected is ready, pending waits, terminal statuses fail at once", () => {
  assert.deepEqual(mcpVerdict(["proxy"], s({ proxy: "connected" }), 0), { state: "ready" });
  assert.deepEqual(mcpVerdict(["proxy"], s({ proxy: "pending" }), 0), { state: "wait" });
  assert.deepEqual(mcpVerdict(["proxy"], null, 0), { state: "wait" });
  for (const status of ["failed", "needs-auth", "disabled"]) {
    assert.deepEqual(mcpVerdict(["proxy"], s({ proxy: status }), 0),
      { state: "fail", message: `MCP server "proxy" is unavailable: status ${status}` });
  }
  assert.deepEqual(mcpVerdict(["proxy"], s({ other: "connected" }), 0),
    { state: "fail", message: 'MCP server "proxy" is unavailable: not reported by the SDK' });
  // a failed server fails even while another is still pending
  assert.equal(mcpVerdict(["a", "b"], s({ a: "pending", b: "failed" }), 0).message, 'MCP server "b" is unavailable: status failed');
  assert.deepEqual(mcpVerdict(["proxy"], s({ proxy: "pending" }), MCP_WAIT_MS),
    { state: "fail", message: `MCP server "proxy" is unavailable: still pending after ${MCP_WAIT_MS / 1000} s` });
});

test("wait: pending then connected resolves ready", async () => {
  const snaps = [{ proxy: "pending" }, { proxy: "pending" }, { proxy: "connected" }];
  let i = 0;
  const c = clock();
  const message = await waitForRequiredMcp(["proxy"], async () => s(snaps[Math.min(i++, 2)]), c);
  assert.equal(message, null);
  assert.equal(i, 3);
});

test("wait: pending until the bound fails with the still-pending text", async () => {
  const c = clock();
  const message = await waitForRequiredMcp(["proxy"], async () => s({ proxy: "pending" }), { ...c, limitMs: 30_000, pollMs: 500 });
  assert.equal(message, 'MCP server "proxy" is unavailable: still pending after 30 s');
  assert.ok(c.now() >= 30_000);
});

test("wait: failed at the first poll fails without waiting", async () => {
  const c = clock();
  const message = await waitForRequiredMcp(["proxy"], async () => s({ proxy: "failed" }), c);
  assert.equal(message, 'MCP server "proxy" is unavailable: status failed');
  assert.equal(c.now(), 0);
});

test("wait: a throwing or hanging status call still ends at the bound", async () => {
  const c = clock();
  assert.match(await waitForRequiredMcp(["proxy"], async () => { throw new Error("x"); }, { ...c, limitMs: 2000 }), /still pending after 2 s/);
  assert.match(await waitForRequiredMcp(["proxy"], () => new Promise(() => {}), { limitMs: 50, pollMs: 10 }), /still pending after 0 s/);
});

test("hold: ready resolves silently; a failure writes one mcp_unavailable line and exits 1; a bad list refuses", async () => {
  const lines = [];
  const codes = [];
  const exit = (c) => { codes.push(c); };
  await holdFirstPrompt('["proxy"]', async () => s({ proxy: "connected" }), (o) => lines.push(o), { exit });
  assert.deepEqual([lines, codes], [[], []]);
  await holdFirstPrompt('["proxy"]', async () => s({ proxy: "disabled" }), (o) => lines.push(o), { exit });
  assert.deepEqual(lines, [{ type: "sidecar", subtype: "mcp_unavailable", message: 'MCP server "proxy" is unavailable: status disabled' }]);
  assert.deepEqual(codes, [1]);
  for (const bad of ["proxy", "[1]", '[""]', "{}"]) assert.equal(parseRequiredMcp(bad), null, bad);
  await holdFirstPrompt("proxy", () => { throw new Error("must not poll"); }, (o) => lines.push(o), { exit });
  assert.equal(lines.at(-1).subtype, "error");
  assert.deepEqual(codes, [1, 1]);
});

test("wait: no required servers is ready without a status call", async () => {
  assert.equal(await waitForRequiredMcp([], () => { throw new Error("must not poll"); }), null);
});
