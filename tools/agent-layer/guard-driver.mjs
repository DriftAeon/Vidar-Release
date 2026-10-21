// Driver Mode guard for bare Claude tabs: the Vidar-layer copy of the global PreToolUse hook
// ~\.claude\hooks\guard-driver.mjs, delivered by path from the generated settings of a bare home
// (profiles/bare/claude.settings.template.json). A Falcon-hosted session that is only meant to
// drive lanes must not build or edit the install itself.
//
// Usage (Claude's PreToolUse command; Claude pipes the hook JSON on stdin):
//   node "<root>\tools\agent-layer\guard-driver.mjs" --root "<root>"
//
// Active only when FALCON_SESSION is set AND <root>\runtime\bridge\driver\<session>.json (the paths
// contract's `driverMode` id, written by src-tauri/src/driver_mode.rs) holds { "on": true }.
// Denies, exit 2 + "driver mode: spawn a lane" on stderr:
//   - Edit/Write/MultiEdit/NotebookEdit on a path inside <root> but outside its docs\runs (`runs` id)
//   - Bash/PowerShell when a pipeline segment (split on | ; && || newline, quoted strings and heredoc
//     bodies blanked) starts with cargo npm npx pnpm tsc vite, including pwsh/powershell -c|-Command
//     "..." and cmd /c ... (the wrapped string is checked recursively)
//   - Bash/PowerShell that invokes a tools\release\*.ps1 (first token, `&` + path, or -File path)
// Allows: a `node ... tools/control/vidar.mjs` segment, and any call whose payload carries `agent_id`
// (a subagent: in-session delegation is intended).
// Fails open (exit 0) on everything else: no FALCON_SESSION (every Raw bare tab), a missing or
// relative --root, no truth file, unreadable or bad JSON, an empty or non-object payload. It is a
// nudge, not a boundary: the global hook's header lists the deliberate bypasses.
// Never reads USERPROFILE, HOME, os.homedir() or `~`; writes nothing.

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { absoluteArgs } from "../lib/agent-env.mjs";
import { resolve as resolvePath } from "../lib/paths.mjs";

const MESSAGE = "driver mode: spawn a lane\n";

// Read everything first so an early exit never leaves the writer with EPIPE.
let raw = "";
try { raw = readFileSync(0, "utf8").replace(/^\uFEFF/, ""); } catch { /* unreadable: treated as empty */ }

const args = absoluteArgs(process.argv.slice(2), ["root"]);
if (args.error) process.exit(0);
const ROOT = resolve(args.values.root);

const session = process.env.FALCON_SESSION;
if (!session || !/^[A-Za-z0-9-]{1,64}$/.test(session)) process.exit(0);

let on = false;
try {
  const truth = JSON.parse(
    readFileSync(resolve(resolvePath("driverMode", { root: ROOT }), `${session}.json`), "utf8").replace(/^\uFEFF/, ""),
  );
  on = truth?.on === true;
} catch { process.exit(0); }
if (!on) process.exit(0);

if (!raw.trim()) process.exit(0);
let d;
try { d = JSON.parse(raw); } catch { process.exit(0); }
if (!d || typeof d !== "object" || Array.isArray(d)) process.exit(0);

if (d.agent_id) process.exit(0);

const tool = String(d.tool_name ?? "");
const input = d.tool_input && typeof d.tool_input === "object" ? d.tool_input : {};

function block() {
  process.stderr.write(MESSAGE);
  process.exit(2);
}

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = input.file_path ?? input.notebook_path ?? input.path;
  if (!p) process.exit(0);
  const abs = norm(resolve(ROOT, String(p)));
  const root = norm(ROOT);
  const runs = norm(resolvePath("runs", { root: ROOT }));
  const inside = abs === root || abs.startsWith(root + sep);
  const inRuns = abs === runs || abs.startsWith(runs + sep);
  if (inside && !inRuns) block();
  process.exit(0);
}

if (tool !== "Bash" && tool !== "PowerShell") process.exit(0);
const cmd = String(input.command ?? "");
if (!cmd.trim()) process.exit(0);

const BUILDERS = new Set(["cargo", "npm", "npx", "pnpm", "tsc", "vite"]);
const RELEASE = /tools[\\/]release[\\/][^\s"']*\.ps1/i;

// Newlines inside a masked span go too, or a multi-line body would split into fake segments.
const blank = (s) => s.replace(/[\s\S]/g, " ");

// Length-preserving mask: heredoc bodies and quoted strings become spaces (quotes kept), so
// separators inside them are invisible but indices still line up with the original text.
function mask(s) {
  return s
    .replace(/<<-?\s*'?"?([A-Za-z_]\w*)'?"?[\s\S]*?^\1\s*$/gm, blank)
    .replace(/'"'"'|'\\''/g, blank)
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => `"${blank(m.slice(1, -1))}"`)
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => `'${blank(m.slice(1, -1))}'`);
}

function segments(text) {
  const m = mask(text);
  const out = [];
  let last = 0;
  for (const x of m.matchAll(/\|\||&&|[|;\n]/g)) {
    out.push(text.slice(last, x.index));
    last = x.index + x[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function rawFirst(seg) {
  const s = seg.trim().replace(/^(?:&\s*)+/, "").trim();
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    return end === -1 ? s.slice(1) : s.slice(1, end);
  }
  return s.split(/\s+/)[0] ?? "";
}

function firstToken(seg) {
  const tok = rawFirst(seg).replace(/["']/g, "").split(/[\\/]/).pop().toLowerCase();
  return tok.replace(/\.(exe|cmd)$/, "");
}

const stripQuotes = (s) => s.trim().replace(/^["']/, "").replace(/["']$/, "");

function denied(text, depth = 0) {
  if (depth > 4) return false;
  for (const seg of segments(text)) {
    const name = firstToken(seg);
    if (name === "node" && /tools[\\/]control[\\/]vidar\.mjs/i.test(seg)) continue;
    if (BUILDERS.has(name)) return true;
    if (RELEASE.test(rawFirst(seg)) && /\.ps1$/i.test(rawFirst(seg))) return true;
    let m;
    if (name === "pwsh" || name === "powershell") {
      if ((m = seg.match(/\s-file\s+["']?([^\s"']+)/i)) && RELEASE.test(m[1])) return true;
      if ((m = seg.match(/\s-(?:c|command)\s+([\s\S]*)$/i)) && denied(stripQuotes(m[1]), depth + 1)) return true;
    } else if (name === "cmd" && (m = seg.match(/\s\/[ck]\s+([\s\S]*)$/i))) {
      if (denied(stripQuotes(m[1]), depth + 1)) return true;
    }
  }
  return false;
}

if (denied(cmd)) block();
process.exit(0);
