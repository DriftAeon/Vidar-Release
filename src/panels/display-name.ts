// Display-only file name: drops one leading date prefix (and an optional time token) so the
// Document/Display pickers and title bars read cleanly. Files keep the prefix on disk.
// Never use it for paths, keys, sorting or IPC.

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}[-_ ](?:\d{4}[-_ ])?/;

export function shownName(fileName: string): string {
  const rest = fileName.replace(DATE_PREFIX, "");
  if (rest === fileName) return fileName;
  // nothing left, or only an extension (".md"): keep the original
  if (!rest || /^\.[^.]*$/.test(rest)) return fileName;
  return rest;
}

// Upper-cased whole when they appear as a word in a pretty name.
const ACRONYMS = new Set(["mcp", "ui", "ux", "api", "html", "svg", "png", "css", "json", "url", "id", "pr", "ci", "ts", "js", "llm", "ai", "ue", "pty", "ipc", "sdk", "cli", "md", "gui", "tts", "stt", "vad"]);

/** Picker label: shownName, then the extension dropped, `-`/`_` as spaces, each word capitalised,
 *  known acronyms upper-cased ("mcp-flow-test-mock.html" → "MCP Flow Test Mock"). Display only. */
export function prettyName(fileName: string): string {
  const base = shownName(fileName).replace(/\.[^.]+$/, "");
  const words = base.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return fileName;
  return words.map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");
}
