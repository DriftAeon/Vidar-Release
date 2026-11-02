// Display-only text formatting shared across panels. Config keys and wire values stay
// exactly as written; only what the user reads is touched.
// @ts-ignore TS5097: node --test loads this pure module directly
import { AGENTS } from "./agents/descriptor.ts";

// The one display-case home: every visible capitalisation in src/ goes through label, titleWords or a
// function below (tools/gate/one-home.mjs refuses a hand-rolled copy elsewhere).
// Words that read as acronyms or fixed spellings in the UI. Anything not listed falls back to title case,
// so a new transport or scope still renders sanely without editing this table.
const ACRONYMS: Record<string, string> = {
  http: "HTTP",
  https: "HTTPS",
  sse: "SSE",
  stdio: "stdio",
  url: "URL",
  mcp: "MCP",
  api: "API",
  pty: "PTY",
  cwd: "CWD",
  ctx: "CTX",
  ue: "UE",
  llm: "LLM",
  gpt: "GPT",
  ui: "UI",
  ux: "UX",
  cli: "CLI",
  json: "JSON",
  dom: "DOM",
  npm: "npm",
  rg: "rg",
  exe: "EXE",
  md: "MD",
  rs: "RS",
  ps1: "PS1",
  ps51: "PS 5.1",
  utf8: "UTF-8",
  css: "CSS",
  git: "Git",
  vs: "vs",
  powershell: "PowerShell",
  readme: "README",
  textcontent: "textContent",
  html: "HTML",
  svg: "SVG",
  png: "PNG",
  id: "ID",
  pr: "PR",
  ci: "CI",
  e2e: "E2E",
  ts: "TS",
  js: "JS",
  ai: "AI",
  ipc: "IPC",
  sdk: "SDK",
  gui: "GUI",
  tts: "TTS",
  stt: "STT",
  vad: "VAD",
};
// Shown as written for a config value ("stdio"), plain title case inside a name ("Stdio").
const NAME_PLAIN = new Set(["stdio"]);
// Small words stay lower case after the first word of a name (lint-copy-note.mjs SMALL; src/ never imports tools/).
const SMALL = new Set(["a", "an", "the", "and", "or", "nor", "but", "of", "to", "in", "on", "for", "at", "by", "vs", "via", "per", "as", "from", "with"]);

/** "—": every empty state and count 0 ("(none)", "No X" and scope notes are never shown instead). */
export const DASH = "—";

/** First line of a string, trimmed, capped at 120 chars. For clipping OS-error tails
 *  before they land in a title or a status line. */
export const firstLine = (s: string): string => {
  const line = (s.split(/\r?\n/, 1)[0] ?? "").trim();
  return line.length > 120 ? line.slice(0, 120) : line;
};

/** A value as display text: strings as-is, anything else as indented JSON (String() if that fails). */
export function pretty(v: unknown): string {
  try { return typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}

const titleCase = (v: string): string => (v ? v[0].toUpperCase() + v.slice(1) : v);

/** "http" → "HTTP", "sse" → "SSE", "local" → "Local". Use for one word or one config value shown as a label
 *  (a state, role, kind, scope, effort level). Acronyms and fixed spellings come from the table. */
export const label = (v: string): string => ACRONYMS[v.toLowerCase()] ?? titleCase(v);

// One word of a name: as label, except a transport word ("stdio") reads as plain title case.
const nameWord = (w: string): string => (NAME_PLAIN.has(w.toLowerCase()) ? titleCase(w) : label(w));

/** An id or name as Title Case words: "vidar-drive" → "Vidar Drive", "my_server" → "My Server", "mcp-gate" → "MCP Gate",
 *  "vidarDriveDocs" → "Vidar Drive Docs". Splits on - _ space and camelCase; small words stay lower case
 *  after the first. Use for any file, server, set or rune name; empty when the id holds no word. Display only. */
export const titleWords = (id: string): string =>
  id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/).filter(Boolean)
    .map((w, i) => (i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : nameWord(w)))
    .join(" ");

/** Codex catalog name to a picker label: "gpt-6-sol" and "gpt 6 sol" → "GPT 6 Sol", "gpt-5.4-codex-mini" →
 *  "GPT 5.4 Codex Mini". Every word Title Case, acronyms upper case, versions kept. Display only. */
export const codexModelLabel = (name: string): string => {
  const words = name.trim().split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return name;
  return words.map((w) => (/^[A-Z0-9.]+$/.test(w) && !ACRONYMS[w.toLowerCase()] ? w : label(w.toLowerCase()))).join(" ");
};

// Tool names the camel-case split would mangle. Everything else falls through to the
// heuristic, so a tool we have never met still reads as words.
const TOOL_NAMES: Record<string, string> = {
  PowerShell: "PowerShell",
  BashOutput: "Bash Output",
};

/** Words of one MCP name part, split on _ and - and on camelCase: "executeRead" → "Execute Read". */
export const toolWords = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean).map(label).join(" ");

/** "AskUserQuestion" → "Ask User Question", "Bash" → "Bash",
 *  "mcp__playwright__browser_click" → "Playwright: Browser Click". Display only —
 *  the raw name stays the wire value and the icon-table key. */
export const prettyTool = (name: string): string => {
  if (!name) return name;
  const known = TOOL_NAMES[name];
  if (known) return known;
  if (name.startsWith("mcp__")) {
    const [, server = "", tool = ""] = name.split("__");
    return [toolWords(server), toolWords(tool)].filter(Boolean).join(": ") || name;
  }
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
};

// Model ids the UI is known to meet, named the way the vendors write them. Checked
// before the heuristic so a date-stamped or oddly-dashed id cannot come out mangled.
// Unlisted ids still get a readable name from the heuristic below.
const MODEL_NAMES: ReadonlyMap<string, string> = new Map([
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-opus-5", "Opus 5"],
  ["claude-sonnet-5", "Sonnet 5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
  ["claude-haiku-4-5-20251001", "Haiku 4.5"],
  ["gpt-5.6-terra", "GPT 5.6 Terra"],
  ["gpt-6-astra", "GPT 6 Astra"],
]);

function stripModelAgentPrefix(id: string, separators: string, ignoreCase = false): string {
  for (const agent of Object.values(AGENTS)) {
    const stem = agent.modelPrefix?.slice(0, -1);
    if (!stem) continue;
    const head = id.slice(0, stem.length);
    const separator = id[stem.length];
    if ((ignoreCase ? head.toLowerCase() === stem.toLowerCase() : head === stem)
      && separator !== undefined && separators.includes(separator)) return id.slice(stem.length + 1);
  }
  return id;
}

/** Left-bar row model line: any id or alias to a Title Case display name. "claude-sonnet-5-5" and
 *  "sonnet-5.5" → "Sonnet 5.5", "gpt-5.4-codex" → "GPT 5.4 Codex", "opus-5.5[1m]" → "Opus 5.5 1M".
 *  Numeric tokens join with dots; unknown words get Title Case; idempotent on its own output. */
export const modelRowName = (id: string): string => {
  const tokens = stripModelAgentPrefix(id.trim().replace(/\[1m\]$/i, " 1M"), "-_ ", true).split(/[-_\s]+/)
    .filter((t) => t && !/^\d{8}$/.test(t));
  if (!tokens.length) return "";
  const isVer = (t: string) => /^\d+(\.\d+)*$/.test(t);
  const ver = tokens.filter(isVer).join(".");
  const words = tokens.filter((t) => !isVer(t)).map((t) => (/^[A-Z0-9]+$/.test(t) ? t : label(t.toLowerCase())));
  if (words[0]?.toLowerCase() === "gpt") return ["GPT", ver, ...words.slice(1)].filter(Boolean).join(" ");
  return [words[0], ver, ...words.slice(1)].filter(Boolean).join(" ");
};

/** "claude-opus-5" → "Opus 5", "opus[1m]" → "Opus 1M", "Opus 5" → "Opus 5" (idempotent on
 *  an already-pretty name, so display names can be passed through unchanged). */
export const prettyModel = (id: string): string => {
  // Normalize spaces to dashes before the lookup: a pretty name fed back in
  // (e.g. "GPT 5.6 Terra") lowercases to "gpt 5.6 terra", which otherwise
  // misses the "gpt-5.6-terra" map key and breaks idempotency.
  const known = MODEL_NAMES.get(id.toLowerCase().replace(/\s+/g, "-"));
  if (known) return known;
  // any GPT id (case, - _ or space separated) reads like the Codex picker row
  if (/^gpt[-_\s]/i.test(id.trim())) return codexModelLabel(id);
  // settings aliases: "opus[1m]" → "Opus 1M"
  const parts = stripModelAgentPrefix(id.replace(/\[1m\]$/i, "-1M"), "-").split("-").filter((p) => !/^\d{8}$/.test(p));
  if (!parts.length) return id;
  const name = label(parts[0]);
  const nums = parts.slice(1).filter((p) => /^\d+$/.test(p)).join(".");
  const rest = parts.slice(1).filter((p) => !/^\d+$/.test(p)).join(" ");
  return [name, nums, rest].filter(Boolean).join(" ");
};

// Number and time text shared by panels (non-case formatting).

/** A whole number as at least two digits. */
export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local "HH:MM" for an epoch-millisecond time. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Milliseconds as mm:ss, or h:mm:ss past an hour. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}` : `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

/** Age in seconds as "42s ago" / "5m ago" / "3h ago" (launcher rows, status). */
export function agoSecs(secs: number): string {
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

/** Age of an epoch-millisecond time as "just now" / "5m ago" / "3h ago", then the local date (comment cards). */
export function agoSince(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}
