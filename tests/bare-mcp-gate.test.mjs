// tools/bare/mcp-gate.mjs: PreToolUse read decisions and failure exits, using bundle fixtures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tools", "bare", "mcp-gate.mjs");
const root = mkdtempSync(join(tmpdir(), "vidar-mcp-gate-"));
const bundles = join(root, "bundles.json");
writeFileSync(bundles, JSON.stringify({
  version: 1,
  bundles: {
    jira: { mcp: [{ name: "atlassian", reads: ["get_issue"] }] },
    p4: { mcp: [{ name: "plugin_vidar_p4", reads: "*" }] },
  },
}));
after(() => rmSync(root, { recursive: true, force: true }));

function run(toolName, options = {}) {
  const input = options.input ?? JSON.stringify({ tool_name: toolName, tool_input: {} });
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    env: { ...process.env, VIDAR_MCP_GATE_BUNDLES: options.bundles ?? bundles },
    input,
    encoding: "utf8",
  });
}

function passes(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

function asks(result, reason) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.deepEqual(output.hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: reason,
  });
}

test("declared read passes", () => {
  passes(run("mcp__atlassian__get_issue"));
});

test("undeclared tool asks", () => {
  asks(run("mcp__atlassian__delete_issue"), "atlassian delete_issue is not a declared read; confirm the call");
});

test("wildcard read server passes, including a server name with underscores", () => {
  passes(run("mcp__plugin_vidar_p4__list_files"));
});

test("unknown server asks", () => {
  asks(run("mcp__unknown_server__read"), "unknown_server read is not a declared read; confirm the call");
});

test("drive passes without bundle lookup", () => {
  passes(run("mcp__plugin_vidar_drive__write", { bundles: join(root, "missing.json") }));
});

test("non-MCP tool passes without bundle lookup", () => {
  passes(run("Bash", { bundles: join(root, "missing.json") }));
});

test("missing bundle file asks", () => {
  const missing = join(root, "missing.json");
  asks(run("mcp__atlassian__get_issue", { bundles: missing }),
    `atlassian get_issue: bundle file missing: ${missing}; confirm the call`);
});

test("malformed bundle file asks", () => {
  const malformed = join(root, "malformed.json");
  writeFileSync(malformed, "{broken");
  asks(run("mcp__atlassian__get_issue", { bundles: malformed }),
    `atlassian get_issue: bundle file malformed: ${malformed}; confirm the call`);
});

test("malformed stdin exits 2 with a message", () => {
  const result = run(null, { input: "{broken" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /mcp-gate:/);
});

test("missing tool_name exits 2 with a message", () => {
  const result = run(null, { input: "{}" });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no tool_name/);
});
