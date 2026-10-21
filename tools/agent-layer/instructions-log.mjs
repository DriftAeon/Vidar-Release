// Vidar-layer InstructionsLoaded hook for bare Claude tabs: one JSON line per instruction file
// Claude loads, the hook-side evidence for the bare trial (the transcript stays the primary
// evidence: AGENTS.md through the plugin and some lazy loads are silent here, levers C17/C18).
//
// Usage (hook command in the bare home's generated settings; Claude pipes the hook JSON on stdin):
//   node "<root>\tools\agent-layer\instructions-log.mjs" --root "<root>" --home "<home>"
//
// Appends to <home>\logs\instructions.jsonl:
//   {"time":"<ISO>","tab":"<VIDAR_TAB>|null","file_path":…,"memory_type":…,"load_reason":…}
// Never prints to stdout (hook output can reach the model). Refuses: a missing or relative
// --root/--home (one stderr line, nothing written, exit 0 like every hook: tools-ps1.md). Never reads USERPROFILE, HOME,
// os.homedir() or `~`. A bad payload or a failed write exits 0 without output.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { absoluteArgs, vidarTab } from "../lib/agent-env.mjs";

const args = absoluteArgs(process.argv.slice(2), ["root", "home"]);
if (args.error) {
  process.stderr.write(`instructions-log: ${args.error}\n`);
  process.exit(0);
}
const { home } = args.values;

try {
  const raw = readFileSync(0, "utf8").replace(/^﻿/, "").trim();
  if (raw) {
    const d = JSON.parse(raw);
    const field = (k) => (typeof d[k] === "string" ? d[k] : null);
    const line = JSON.stringify({
      time: new Date().toISOString(),
      tab: vidarTab(),
      file_path: field("file_path"),
      memory_type: field("memory_type"),
      load_reason: field("load_reason"),
    });
    const logs = join(home, "logs");
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, "instructions.jsonl"), line + "\n", "utf8");
  }
} catch {
  // silent: a hook failure must never surface inside the agent
}
process.exit(0);
