// Vidar-layer status line for bare Claude tabs: the bridge-write part of the global
// statusline-command.mjs (bare-mode inventory row 7), delivered by path from the generated
// settings of a bare home (profiles/bare/claude.settings.template.json).
//
// Usage (Claude's statusLine command; Claude pipes its statusLine JSON on stdin):
//   node "<root>\tools\agent-layer\statusline-bridge.mjs" --root "<root>" --home "<home>"
//
// Writes the stdin payload verbatim to <root>\runtime\bridge\sessions\<VIDAR_TAB>.json (the paths
// contract's `sessions` id), temp file then rename, the shape src-tauri/src/status.rs reads: it
// forwards the whole JSON to the status bar and reads `session_id` and `transcript_path` itself.
// Prints the status line text to stdout (dir, model, context, 5H/7D, effort, cache).
// Refuses: a missing or relative --root/--home (one stderr line, nothing written, exit 0 like every
// hook-side script: tools-ps1.md). Never
// reads USERPROFILE, HOME, os.homedir() or `~`; writes nothing into the real profile. No mkdir:
// Vidar wipes and recreates the sessions dir at startup (status.rs reset_dir), and a mkdir between
// those two calls would survive the wipe. A bad payload or a failed write exits 0 silently.
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { absoluteArgs, vidarTab } from "../lib/agent-env.mjs";
import { resolve as resolvePath } from "../lib/paths.mjs";

const args = absoluteArgs(process.argv.slice(2), ["root", "home"]);
if (args.error) {
  process.stderr.write(`statusline-bridge: ${args.error}\n`);
  process.exit(0);
}
const { root } = args.values;

try {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { process.exit(0); }
  raw = raw.replace(/^﻿/, "").trim(); // pwsh 7 can hand a BOM on; JSON.parse rejects it
  if (!raw) process.exit(0);
  const d = JSON.parse(raw);

  const tab = vidarTab();
  if (tab) {
    const sessDir = resolvePath("sessions", { root });
    let isDir = false;
    try { isDir = statSync(sessDir).isDirectory(); } catch {}
    if (isDir) {
      const tmp = join(sessDir, `${tab}.${process.pid}.tmp`);
      try {
        writeFileSync(tmp, raw, "utf8");
        renameSync(tmp, join(sessDir, `${tab}.json`)); // replaces an existing target on Windows
      } catch {
        // a sharing violation while status.rs reads the target: stale for one refresh, no temp left
        try { unlinkSync(tmp); } catch {}
      }
    }
  }

  process.stdout.write(statusText(d) + "\n");
} catch {
  // silent by design: a status line showing a stack trace is worse than none
}

function statusText(d) {
  const ESC = "\x1b";
  const CYAN = `${ESC}[36m`, GREEN = `${ESC}[32m`, YELLOW = `${ESC}[33m`, RED = `${ESC}[31m`;
  const ORANGE = `${ESC}[38;5;172m`, RESET = `${ESC}[0m`;
  const DARKRED = `${ESC}[38;2;255;26;26m`;
  const colorForPct = (pct) => (pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN);
  // banker's rounding, as the global script (it matched .NET [Math]::Round)
  const roundHalfEven = (x) => {
    const f = Math.floor(x), diff = x - f;
    if (diff !== 0.5) return Math.round(x);
    return f % 2 === 0 ? f : f + 1;
  };
  const pad2 = (n) => String(n).padStart(2, "0");

  const dir = win32.basename(String(d.workspace?.current_dir ?? ""));
  const model = String(d.model?.display_name ?? "");
  const parts = [`${CYAN}[${dir}]${RESET}`, `${CYAN}[${model}]${RESET}`];

  const used = d.context_window?.used_percentage != null ? Number(d.context_window.used_percentage) : 0;
  const usedInt = Math.min(100, Math.max(0, roundHalfEven(used)));
  parts.push(`${usedInt >= 75 ? RED : ORANGE}Context ${usedInt}%${RESET}`);

  const formatLimit = (limit, label, stampFormat) => {
    if (limit == null || limit.used_percentage == null) return null;
    const pct = roundHalfEven(Number(limit.used_percentage));
    let suffix = "";
    if (limit.resets_at) {
      const local = new Date(Number(limit.resets_at) * 1000);
      if (stampFormat === "time") suffix = ` (${pad2(local.getHours())}:${pad2(local.getMinutes())})`;
      else suffix = " " + local.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
    }
    return `${colorForPct(pct)}${pct}% / ${label}${suffix}${RESET}`;
  };
  const five = formatLimit(d.rate_limits?.five_hour, "5H", "time");
  if (five) parts.push(five);
  const week = formatLimit(d.rate_limits?.seven_day, "7D", "day");
  if (week) parts.push(week);

  if (d.effort?.level) {
    const e = String(d.effort.level);
    parts.push(`${DARKRED}${e.charAt(0).toUpperCase()}${e.slice(1)}${RESET}`);
  }

  // prompt cache time left: green above two minutes, yellow in the last two, red in the last 30 s
  const pc = d.prompt_cache;
  if (pc && pc.caching_observed) {
    const left = pc.warm && pc.expires_at ? Number(pc.expires_at) - Date.now() / 1000 : 0;
    let cell;
    if (left <= 0) cell = `${RED}0s${RESET}`;
    else if (left <= 30) cell = `${RED}${Math.ceil(left)}s${RESET}`;
    else if (left <= 120) cell = `${YELLOW}${Math.ceil(left / 60)}m${RESET}`;
    else cell = `${GREEN}${Math.floor(left / 60)}m${RESET}`;
    parts.push(cell);
  }
  return parts.join(" | ");
}
