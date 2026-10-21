// Workbench tray admission: every size and count limit a new block must pass.
// No imports; workbench.ts passes the live block count in.

const MIB = 1024 * 1024;
const MAX_TEXT = 2 * MIB; // UTF-8 bytes
const MAX_PNG = 8 * MIB;
export const MAX_PIXELS = 32_000_000; // decoded
const MAX_BLOCKS = 24; // must stay below the 26 spoken names in workbench-names.ts
export const TEXT_EXT = new Set(["md", "txt", "log", "json", "ps1", "ts", "rs", "toml", "yaml", "yml", "css", "html"]);

/* ---- admission: one function owns every limit ---- */

export function admit(kind: "text" | "png", previewBytes: number, count: number): string | null {
  if (count >= MAX_BLOCKS) return `tray full (${MAX_BLOCKS} blocks) — remove one first`;
  if (kind === "text" && previewBytes > MAX_TEXT) return `text over ${MAX_TEXT / MIB} MiB`;
  if (kind === "png" && previewBytes > MAX_PNG) return `image over ${MAX_PNG / MIB} MiB`;
  return null;
}
