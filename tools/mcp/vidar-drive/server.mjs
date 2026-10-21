#!/usr/bin/env node
// tools\mcp\vidar-drive\server.mjs — "Vidar Drive" stdio MCP server: the control-bus verbs
// (tools\control) as tools for Claude tabs. Config key `vidar-drive` in the repo `.mcp.json` and
// `drive` in `plugins\vidar-app\.mcp.json` (tools `mcp__plugin_vidar_drive__*`).

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, RpcError, INVALID_PARAMS } from "./rpc.mjs";
import { TOOLS, makeCall } from "./tools.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VERSION = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")).version;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

// Captured before main chdirs to the repo: MCP `spawn` defaults its cwd (and resolves a relative
// `brief`) against where the server was launched, i.e. the caller's folder.
const LAUNCH_CWD = process.cwd();

/** method → handler; `call` is injectable for tests. */
export function handlers(call = makeCall(undefined, LAUNCH_CWD)) {
  return {
    initialize: (p) => ({
      protocolVersion: PROTOCOLS.includes(p?.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "vidar-drive", title: "Vidar Drive", version: VERSION },
    }),
    ping: () => ({}),
    "tools/list": () => ({ tools: TOOLS }),
    "tools/call": (p) => {
      if (p === null || typeof p !== "object") throw new RpcError(INVALID_PARAMS, "params must be an object");
      return call(p.name, p.arguments ?? {});
    },
  };
}

const real = (p) => { try { return realpathSync(p).toLowerCase(); } catch { return null; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  process.chdir(REPO); // repo-relative tool paths; a spawn `brief`/`cwd` resolves against LAUNCH_CWD, not the repo
  await serve({ input: process.stdin, output: process.stdout, handlers: handlers() });
  process.stdout.write("", () => process.exit(0)); // every reply flushed, then exit
}
