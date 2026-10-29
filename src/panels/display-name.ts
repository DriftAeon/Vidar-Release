// Display-only file name: drops one leading date prefix (and an optional time token) so the
// Document/Display pickers and title bars read cleanly. Files keep the prefix on disk.
// Never use it for paths, keys, sorting or IPC.

// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { label } from "../format.ts";

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}[-_ ](?:\d{4}[-_ ])?/;

export function shownName(fileName: string): string {
  const rest = fileName.replace(DATE_PREFIX, "");
  if (rest === fileName) return fileName;
  // nothing left, or only an extension (".md"): keep the original
  if (!rest || /^\.[^.]*$/.test(rest)) return fileName;
  return rest;
}

/** Picker label: shownName, then the extension dropped, `-`/`_` as spaces, each word capitalised,
 *  known acronyms upper-cased ("mcp-flow-test-mock.html" → "MCP Flow Test Mock"). Display only. */
export function prettyName(fileName: string): string {
  const base = shownName(fileName).replace(/\.[^.]+$/, "");
  const words = base.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return fileName;
  return words.map((w) => label(w)).join(" ");
}
