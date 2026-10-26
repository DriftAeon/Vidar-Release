// tools/bare/mcp-gate.mjs: Claude Bare PreToolUse gate (matcher `mcp__.*`, run 2026-10-24-runesets-full-stack).
// Passes drive (`mcp__plugin_vidar_drive__*`) and the `reads` contracts/module-bundles.json declares per server;
// asks for every other MCP tool, unknown servers and an unreadable bundles file included.
// Usage: node tools/bare/mcp-gate.mjs < PreToolUse JSON   (VIDAR_MCP_GATE_BUNDLES overrides the bundles path)
// Refuses: unparseable input or any internal error → exit 2. Unlike other hooks this one fails closed, because
// Claude runs the tool on exit 1 or a crash (probe P4, verified 2026-10-24).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(error) {
  console.error(`mcp-gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validBundles(value) {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.bundles)) return false;
  for (const bundle of Object.values(value.bundles)) {
    if (!isRecord(bundle) || !Array.isArray(bundle.mcp)) return false;
    for (const server of bundle.mcp) {
      if (!isRecord(server) || typeof server.name !== "string" || !server.name) return false;
      if (server.reads !== "*" &&
          (!Array.isArray(server.reads) || !server.reads.every((tool) => typeof tool === "string" && tool))) return false;
    }
  }
  return true;
}

function bundleResult(path) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    return { problem: `bundle file ${error.code === "ENOENT" ? "missing" : "unreadable"}: ${path}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { problem: `bundle file malformed: ${path}` };
  }
  if (!validBundles(parsed)) return { problem: `bundle file malformed: ${path}` };
  return { bundles: parsed.bundles };
}

function ask(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  }));
}

function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (!isRecord(input) || typeof input.tool_name !== "string" || !input.tool_name) {
    throw new Error("PreToolUse input has no tool_name");
  }
  if (!input.tool_name.startsWith("mcp__")) return;

  const delimiter = input.tool_name.indexOf("__", "mcp__".length);
  if (delimiter < 0) throw new Error("PreToolUse MCP tool_name has no server/tool separator");
  const server = input.tool_name.slice("mcp__".length, delimiter);
  const tool = input.tool_name.slice(delimiter + 2);
  if (!server || !tool) throw new Error("PreToolUse MCP tool_name has an empty server or tool");
  if (server === "plugin_vidar_drive") return;

  const path = process.env.VIDAR_MCP_GATE_BUNDLES !== undefined
    ? process.env.VIDAR_MCP_GATE_BUNDLES
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "module-bundles.json");
  const result = bundleResult(path);
  if (result.problem) {
    ask(`${server} ${tool}: ${result.problem}; confirm the call`);
    return;
  }
  const declared = Object.values(result.bundles).some((bundle) =>
    bundle.mcp.some((entry) => entry.name === server && (entry.reads === "*" || entry.reads.includes(tool))));
  if (!declared) ask(`${server} ${tool} is not a declared read; confirm the call`);
}

try {
  main();
} catch (error) {
  fail(error);
}
