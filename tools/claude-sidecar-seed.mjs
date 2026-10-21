// Status-bar seeds for the Claude sidecar: effort and 5H/7D, read once at start so a fresh tab
// shows them before a turn has been paid for. Read-only, same precedent as settingsModel().
// The statusline script mirrors its whole hook input to ~\.claude\statusline-latest.json, a
// SINGLETON written by whichever session rendered last, which decides what may be borrowed:
//   - `effort.level` and `rate_limits` are safe. Effort self-corrects on the first Stop hook, and
//     5H/7D are ACCOUNT-wide, so another session's reading is true for this tab.
//   - `context_window` and `prompt_cache` are NOT. They are session-scoped: a fresh tab has no
//     prefix and no context, so seeding them would state another session's numbers as this one's.
// Nothing here is present before a turn has run: a start-time mirror carries no `prompt_id`,
// no `prompt_cache` and no `rate_limits`. Absent seed, no event, no harm.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// `configDir` (a bare tab's own CLAUDE_CONFIG_DIR, claude-sidecar-bare.mjs) replaces ~\.claude as
// the folder the seed is read from; absent there means no seed. One process reads one folder.
const seedCache = new Map();
export function statuslineSeed(configDir = join(homedir(), ".claude")) {
  if (seedCache.has(configDir)) return seedCache.get(configDir);
  let seed;
  try {
    const raw = readFileSync(join(configDir, "statusline-latest.json"), "utf8");
    seed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch { seed = null; } // absent or unparsable: the first turn reports everything anyway
  seedCache.set(configDir, seed);
  return seed;
}

/* Effort is on no stream field and only on hook inputs that fire inside a turn, so without this
   a fresh tab shows no effort until a message has already been paid for. An explicit --effort
   argument (already validated by the caller) wins over the shared file. */
export function seededEffort(arg, configDir) {
  if (typeof arg === "string" && arg.trim()) return arg.trim();
  const level = statuslineSeed(configDir)?.effort?.level;
  return typeof level === "string" && level.trim() ? level.trim() : null;
}

/* Same problem for the account windows: `rate_limit_event` arrives with a turn's response, so a
   fresh tab's status line had no 5H/7D at all. Emitted in the SDK's OWN envelope so the adapter's
   rate_limit_event path (src/agents/claude.ts:182) handles it with no new code, and the first real
   event simply overwrites it. `utilization` is sent as the 0-1 fraction the API uses, not the
   file's percentage, because the adapter's `pct` helper treats any value <= 1 as a fraction. */
export function seededLimits(configDir) {
  const rl = statuslineSeed(configDir)?.rate_limits;
  if (!rl) return null;
  const nowSec = Date.now() / 1000;
  const unifiedWindows = {};
  for (const key of ["five_hour", "seven_day"]) {
    const used = rl[key]?.used_percentage;
    const resets = rl[key]?.resets_at;
    if (typeof used !== "number" || !Number.isFinite(used)) continue;
    // a window that has already rolled over makes the percentage a lie, not merely stale
    if (typeof resets === "number" && resets <= nowSec) continue;
    unifiedWindows[key] = { utilization: used / 100, resetsAt: typeof resets === "number" ? resets : null };
  }
  if (!Object.keys(unifiedWindows).length) return null;
  return { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows } };
}
