// claude-sidecar-statusline.mjs: the opt-in ~\.claude\statusline\<session_id>.json mirror that
// claude-sidecar.mjs feeds from its SDK stream. Imported by claude-sidecar.mjs and bundled beside
// it (Falcon bundle sidecar\, friend zip tools\), which is what vidarRoot() below relies on.
//
// Usage: import { startStatuslineMirror } from "./claude-sidecar-statusline.mjs";
//        const observeStatusline = startStatuslineMirror(); // then observeStatusline(msg) per message
//
// Refuses: no top-level side effects (the config read and the cleanup run inside
// startStatuslineMirror); writes nothing under ~\.claude unless vidar.json opts in (a bare tab passes
// its own configDir and always mirrors there, vidar.json unread); removes only files carrying its
// own writer marker; never throws.

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Mirrors ~\.claude\statusline\<session_id>.json (the file context-gate.mjs reads) from inside
// a Rendered/headless body, where the terminal statusline script never runs.
// session_id comes from system/init; context_window_size is the last max modelUsage[*].contextWindow
// seen on a result message so far, carried forward (omitted until the first result lands, matching
// the gate's own default). Fires on every top-level assistant message (parent_tool_use_id == null);
// streamed content-block assistant messages carry the same top-level id and a non-final usage, so
// this just keeps overwriting the same file with the latest number — cheap, and the last write
// before Stop is what the gate reads. Best effort, atomic (tmp+rename), never throws.
//
// Opt-in: nothing is written under ~\.claude unless vidar.json carries
// `"statuslineMirror": true`. vidar.json is found by walking up from this file to the Vidar root
// (the directory holding tools\claude-sidecar.mjs, the same marker paths.rs uses), so both the
// repo copy (<root>\tools\) and a Falcon bundle copy (<root>\bridge\falcon\bundles\<id>\sidecar\)
// resolve it. Read once per sidecar process: a toggle applies to the next session started.
// Reversible: every file written carries `"writer": "vidar-sidecar"`; with the key off, a start
// removes the marked files from ~\.claude\statusline\ and leaves everything else (the terminal
// statusline script's own files, files written before the marker existed) untouched.
const STATUSLINE_WRITER = "vidar-sidecar";

export function vidarRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "tools", "claude-sidecar.mjs"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// Shared with claude-sidecar.mjs (pluginDirs): the Vidar root and its parsed vidar.json, null when absent or bad.
export function readVidarConfig() {
  try {
    const root = vidarRoot();
    if (!root) return null;
    const cfg = JSON.parse(readFileSync(join(root, "vidar.json"), "utf8").replace(/^﻿/, ""));
    return { root, cfg };
  } catch { return null; }
}

function statuslineMirrorEnabled() {
  return readVidarConfig()?.cfg?.statuslineMirror === true; // absent or unparsable config: off
}

function removeOwnStatuslineFiles(base) {
  try {
    const dir = join(base, "statusline");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        if (JSON.parse(readFileSync(path, "utf8"))?.writer === STATUSLINE_WRITER) unlinkSync(path);
      } catch { /* unreadable or someone else's: leave it */ }
    }
  } catch { /* no dir: nothing was written */ }
}

// Reads the opt-in once, removes this writer's files when it is off, and returns the per-message
// observer. Called once by the sidecar after its arg validation (the old top-level position).
// A bare tab (claude-sidecar-bare.mjs) passes `{ configDir }`: the mirror is then always on and
// writes <configDir>\statusline\, the tab's own CLAUDE_CONFIG_DIR, and vidar.json is not read.
export function startStatuslineMirror(opts = {}) {
const base = opts.configDir ?? join(homedir(), ".claude");
const statuslineMirror = opts.configDir ? true : statuslineMirrorEnabled();
if (!statuslineMirror) removeOwnStatuslineFiles(base);

let statuslineSessionId = null;
let statuslineContextWindow;

function writeStatusline(sessionId, usage, contextWindowSize) {
  try {
    if (!statuslineMirror || !sessionId || !usage) return;
    const dir = join(base, "statusline");
    mkdirSync(dir, { recursive: true });
    const contextWindow = {
      current_usage: {
        input_tokens: Number(usage.input_tokens || 0),
        cache_read_input_tokens: Number(usage.cache_read_input_tokens || 0),
        cache_creation_input_tokens: Number(usage.cache_creation_input_tokens || 0),
      },
    };
    if (Number.isFinite(contextWindowSize) && contextWindowSize > 0) {
      contextWindow.context_window_size = contextWindowSize;
    }
    const payload = JSON.stringify({ session_id: sessionId, context_window: contextWindow, writer: STATUSLINE_WRITER });
    const tmp = join(dir, `${sessionId}.${process.pid}.tmp`);
    writeFileSync(tmp, payload, "utf8");
    try {
      renameSync(tmp, join(dir, `${sessionId}.json`));
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
  } catch { /* best effort: a missed statusline write just leaves the gate with no source */ }
}

function observeStatusline(msg) {
  try {
    if (msg?.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
      statuslineSessionId = msg.session_id;
      return;
    }
    if (msg?.type === "result" && msg.modelUsage && typeof msg.modelUsage === "object") {
      let max = 0;
      for (const mu of Object.values(msg.modelUsage)) {
        const cw = Number(mu?.contextWindow);
        if (Number.isFinite(cw) && cw > max) max = cw;
      }
      if (max > 0) statuslineContextWindow = max;
      return;
    }
    if (msg?.type === "assistant" && msg.parent_tool_use_id == null) {
      writeStatusline(statuslineSessionId, msg.message?.usage, statuslineContextWindow);
    }
  } catch { /* bookkeeping must never break the stream */ }
}

return observeStatusline;
}
