// Pure mapping from a persisted `bridge\workbench\<name>.json` entry to what
// it becomes on restore (workbench.ts `restoreTray`/`restoreOne`). Kept
// separate from workbench.ts — which pulls in ipc/DOM/sessions/document/
// display — so this is testable via `node --test` with no relative imports
// to resolve, the same leaf-module pattern as rendered-drive.ts and
// rendered-settle.ts.

/** Mirrors workbench.ts's own `Source` union; duplicated rather than imported
 *  so this file stays a dependency-free leaf. */
export type Source = "paste" | "drop" | "marquee" | "log crop";
const KNOWN_SOURCES: readonly Source[] = ["paste", "drop", "marquee", "log crop"];
function asSource(v: unknown): Source {
  return typeof v === "string" && (KNOWN_SOURCES as readonly string[]).includes(v) ? (v as Source) : "paste";
}

/** What a persisted entry becomes on restore. */
export interface RestoreEntry {
  name: string;
  at: number;
  source: Source;
  mode: "text" | "file" | "png";
  /** mode "file" only */
  path?: string;
  /** mode "text" only */
  text?: string;
  truncated?: boolean;
  /** tray fold state; absent = expanded */
  collapsed?: boolean;
  /** the user's saved annotation */
  annotation?: string;
}

/** The subset of workbench.ts's `Block` that publishBlock reads. Kept local
 *  (not imported) so this file stays a dependency-free leaf. */
export interface BlockLike {
  name: string;
  kind: "text" | "png";
  source: Source;
  at: number;
  previewBytes: number;
  fileBytes?: number;
  path?: string;
  text?: string;
  collapsed?: boolean;
  annotation?: string;
}

const PUBLISH_TEXT_CAP = 64 * 1024;

/** Pure: what a block becomes as a `bridge\workbench\<name>.json` entry.
 *  workbench.ts's publishBlock is a thin wrapper over this. */
export function blockToEntry(b: BlockLike): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: b.name, kind: b.kind, source: b.source, at: b.at,
    previewBytes: b.previewBytes,
  };
  if (b.fileBytes !== undefined) entry.fileBytes = b.fileBytes;
  if (b.path) entry.path = b.path;
  if (b.collapsed) entry.collapsed = true;
  if (b.annotation) entry.annotation = b.annotation;
  if (b.kind === "text" && b.text !== undefined && !b.path) {
    entry.text = b.text.slice(0, PUBLISH_TEXT_CAP);
    if (b.text.length > PUBLISH_TEXT_CAP) entry.truncated = true;
  }
  return entry;
}

/** Pure: decides what a published entry becomes on restore, or null to leave
 *  it untouched. Only `text` and `png` are tray blocks — `document` (the
 *  Document tab's own entry) and any other/unknown kind are the caller's to
 *  ignore, not delete. A `path` wins over `kind` for mode:
 *  a dropped file published as either kind restores by re-reading the path. */
export function entryToRestore(entry: unknown): RestoreEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.kind !== "text" && e.kind !== "png") return null;
  if (typeof e.name !== "string" || !e.name) return null;
  if (typeof e.at !== "number") return null;
  const source = asSource(e.source);
  const fold = {
    ...(e.collapsed === true ? { collapsed: true } : {}),
    ...(typeof e.annotation === "string" && e.annotation ? { annotation: e.annotation } : {}),
  };
  if (typeof e.path === "string" && e.path) {
    return { name: e.name, at: e.at, source, mode: "file", path: e.path, ...fold };
  }
  if (e.kind === "png") {
    return { name: e.name, at: e.at, source, mode: "png", ...fold };
  }
  return { name: e.name, at: e.at, source, mode: "text", text: typeof e.text === "string" ? e.text : "", truncated: e.truncated === true, ...fold };
}
