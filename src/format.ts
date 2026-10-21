// Display-only text formatting shared across panels. Config keys and wire values stay
// exactly as written; only what the user reads is touched.

// Words that read as acronyms in the UI. Anything not listed falls back to title case,
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
  ue: "UE",
  llm: "LLM",
};

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

/** "http" → "Http". Plain title case, no acronym awareness. */
export const titleCase = (v: string): string => (v ? v[0].toUpperCase() + v.slice(1) : v);

/** "vidar-drive" → "Vidar Drive", "my_server" → "My Server", "proxy" → "Proxy". Display only. */
export const titleWords = (v: string): string => v.split(/[-_]+/).filter(Boolean).map(label).join(" ") || v;

/** "http" → "HTTP", "sse" → "SSE", "local" → "Local". Use for any config value shown as a label. */
export const label = (v: string): string => ACRONYMS[v.toLowerCase()] ?? titleCase(v);

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
  ["claude-haiku-4-5-20251001", "Haiku 4.5"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["gpt-6-astra", "GPT-6 Astra"],
]);

/** Left-bar row model line: any id or alias to a Title Case display name. "claude-sonnet-5-5" and
 *  "sonnet-5.5" → "Sonnet 5.5", "gpt-5.4-codex" → "GPT-5.4 Codex", "opus-5.5[1m]" → "Opus 5.5 1M".
 *  Numeric tokens join with dots; unknown words get Title Case; idempotent on its own output. */
export const modelRowName = (id: string): string => {
  const tokens = id.trim().replace(/\[1m\]$/i, " 1M").replace(/^claude[-_ ]/i, "").split(/[-_\s]+/)
    .filter((t) => t && !/^\d{8}$/.test(t));
  if (!tokens.length) return "";
  const isVer = (t: string) => /^\d+(\.\d+)*$/.test(t);
  const ver = tokens.filter(isVer).join(".");
  const words = tokens.filter((t) => !isVer(t)).map((t) => (/^[A-Z0-9]+$/.test(t) ? t : label(t.toLowerCase())));
  if (words[0]?.toLowerCase() === "gpt") return [ver ? `GPT-${ver}` : "GPT", ...words.slice(1)].join(" ");
  return [words[0], ver, ...words.slice(1)].filter(Boolean).join(" ");
};

/** "claude-opus-5" → "Opus 5", "opus[1m]" → "Opus 1M", "Opus 5" → "Opus 5" (idempotent on
 *  an already-pretty name, so display names can be passed through unchanged). */
export const prettyModel = (id: string): string => {
  // Normalize spaces to dashes before the lookup: a pretty name fed back in
  // (e.g. "GPT-5.6 Terra") lowercases to "gpt-5.6 terra", which otherwise
  // misses the "gpt-5.6-terra" map key and breaks idempotency.
  const known = MODEL_NAMES.get(id.toLowerCase().replace(/\s+/g, "-"));
  if (known) return known;
  // settings aliases: "opus[1m]" → "Opus 1M"
  const parts = id.replace(/\[1m\]$/i, "-1M").replace(/^claude-/, "").split("-").filter((p) => !/^\d{8}$/.test(p));
  if (!parts.length) return id;
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const nums = parts.slice(1).filter((p) => /^\d+$/.test(p)).join(".");
  const rest = parts.slice(1).filter((p) => !/^\d+$/.test(p)).join(" ");
  return [name, nums, rest].filter(Boolean).join(" ");
};
