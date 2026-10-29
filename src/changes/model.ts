// Changes tab model: pure, no DOM and no IPC, so tests/changes-model.test.mjs loads it as is.
// Splits porcelain v2 records (changes.rs `ChangedFile`) into the Staged and Changes groups,
// maps a path to its file-type glyph and tint, shortens a path while keeping the filename, and
// picks the rows Revert All may send (the backend refuses the rest; this keeps one refused path
// from failing the whole batch).
import type { ChangedFile } from "../ipc";
import type { LucideName } from "../icons";
// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { label, titleWords } from "../format.ts";

export type Group = "staged" | "changes";
/** Drives the status letter's tint (changes.css `.cx-st-<kind>`, the --git-* tokens). */
export type StatusKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

export interface Row {
  file: ChangedFile;
  group: Group;
  /** the letter drawn: x for Staged, y for Changes, U for untracked, ! for a merge conflict */
  letter: string;
  kind: StatusKind;
  /** null = binary (no counts drawn) */
  adds: number | null;
  dels: number | null;
}

export interface Groups { staged: Row[]; changes: Row[] }

/** Porcelain v2 unmerged pairs: a `u` record (DD AU UD UA DU AA UU). */
export function isUnmerged(f: ChangedFile): boolean {
  return f.x === "U" || f.y === "U" || (f.x === "A" && f.y === "A") || (f.x === "D" && f.y === "D");
}

function kindOf(letter: string): StatusKind {
  switch (letter) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": case "C": return "renamed";
    default: return "modified"; // M, T (type change)
  }
}

/** One file can sit in both groups: staged edits (x) and later worktree edits (y). */
export function groupFiles(files: ChangedFile[]): Groups {
  const staged: Row[] = [];
  const changes: Row[] = [];
  for (const f of files) {
    if (f.untracked) {
      changes.push({ file: f, group: "changes", letter: "U", kind: "untracked", adds: f.workAdds, dels: f.workDels });
      continue;
    }
    if (isUnmerged(f)) {
      changes.push({ file: f, group: "changes", letter: "!", kind: "conflict", adds: f.workAdds, dels: f.workDels });
      continue;
    }
    if (f.x !== "." && f.x !== "") {
      staged.push({ file: f, group: "staged", letter: f.x, kind: kindOf(f.x), adds: f.stagedAdds, dels: f.stagedDels });
    }
    if (f.y !== "." && f.y !== "") {
      changes.push({ file: f, group: "changes", letter: f.y, kind: kindOf(f.y), adds: f.workAdds, dels: f.workDels });
    }
  }
  return { staged, changes };
}

/** Paths Revert All may send: the Changes rows `restore --source=HEAD` can put back without losing
 *  data. Mirrors changes.rs `check_paths`: no untracked record for the path (after an unstage of a
 *  new file one path has a tracked and an untracked record), not unmerged, not added or
 *  intent-to-add (A in either column), not a rename or copy destination. A deleted file whose path
 *  is now a folder is only visible on disk, so the backend refuses that one. */
export function revertablePaths(files: ChangedFile[], rows: Row[]): string[] {
  const untracked = new Set(files.filter((f) => f.untracked).map((f) => f.path));
  const out: string[] = [];
  for (const r of rows) {
    const f = r.file;
    if (r.group !== "changes" || f.untracked || untracked.has(f.path)) continue;
    if (isUnmerged(f)) continue;
    if (f.x === "A" || f.y === "A") continue;
    if ((f.x === "R" || f.x === "C") && f.origPath !== undefined) continue;
    if (!out.includes(f.path)) out.push(f.path);
  }
  return out;
}

/** Where a Stage / Unstage click was: a row's button (`path` set) or a group's head button (`path`
 *  null). `index` is the row's place in its group at click time. */
export type FocusMark = { group: Group; path: string | null; index: number };
export type FocusTarget = { group: Group; index: number } | { group: Group; head: true };

/** Where keyboard focus goes once the list is redrawn after the click `m`: the same row if its path
 *  is still in the group, else the row now at its place (clamped to the last), else the other
 *  group's first row; a head mark keeps its group's head, else the other's. null = nothing left. */
export function focusAfter(m: FocusMark, g: Groups): FocusTarget | null {
  const other: Group = m.group === "staged" ? "changes" : "staged";
  const rows = g[m.group];
  if (m.path === null) {
    if (rows.length) return { group: m.group, head: true };
    return g[other].length ? { group: other, head: true } : null;
  }
  const at = rows.findIndex((r) => r.file.path === m.path);
  if (at >= 0) return { group: m.group, index: at };
  if (rows.length) return { group: m.group, index: Math.min(m.index, rows.length - 1) };
  return g[other].length ? { group: other, index: 0 } : null;
}

/** A header control a Sync or Rename click came from; the head redraws on the busy flip and drops it. */
export type HeadMark = "sync" | "more" | "rename";

/** The header button focus returns to after the redraw, as its class; null when it is not drawn
 *  (detached HEAD draws no rename pen and disables the sync pair). */
export function headFocusClass(m: HeadMark, detached: boolean): string | null {
  if (detached) return null;
  return m === "sync" ? "cx-split-main" : m === "more" ? "cx-split-more" : "cx-rename";
}

/** The mock's map: extension family → Lucide glyph and tint class (changes.css `.cx-ft-<tint>`). */
export interface FileType { icon: LucideName; tint: string }

const TYPES: Array<[string[], FileType]> = [
  [["ts", "tsx", "mts", "cts"], { icon: "file-code", tint: "ts" }],
  [["js", "mjs", "cjs", "jsx"], { icon: "file-code", tint: "js" }],
  [["rs"], { icon: "file-code", tint: "rs" }],
  [["css"], { icon: "file-type", tint: "css" }],
  [["json"], { icon: "file-json", tint: "cfg" }],
  [["toml", "yaml", "yml"], { icon: "file-cog", tint: "cfg" }],
  [["md", "txt"], { icon: "file-text", tint: "md" }],
  [["ps1", "psm1", "cmd", "bat", "sh"], { icon: "file-terminal", tint: "sh" }],
  [["svg", "png", "jpg", "jpeg", "gif", "webp", "ico"], { icon: "file-image", tint: "img" }],
];
const OTHER: FileType = { icon: "file", tint: "other" };

export function fileType(path: string): FileType {
  const name = splitPath(path).name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return OTHER;
  const ext = name.slice(dot + 1).toLowerCase();
  for (const [exts, t] of TYPES) if (exts.includes(ext)) return t;
  return OTHER;
}

/** "src/panels/a.ts" → { name: "a.ts", dir: "src/panels" }; a top-level file has dir "". */
export function splitPath(path: string): { name: string; dir: string } {
  const p = path.replace(/[\\/]+$/, "");
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut < 0 ? { name: p, dir: "" } : { name: p.slice(cut + 1), dir: p.slice(0, cut) };
}

/** Fits a path in `max` characters, never cutting the filename: the folder part loses whole
 *  leading segments first ("…/panels"), then its own head ("…nels"), then goes. */
export function truncatePath(path: string, max: number): { name: string; dir: string } {
  const { name, dir } = splitPath(path);
  const room = max - name.length - 1; // the gap between name and folder
  if (!dir || dir.length <= room) return { name, dir };
  if (room < 2) return { name, dir: "" };
  const segs = dir.split(/[\\/]/);
  for (let i = 1; i < segs.length; i++) {
    const tail = "…/" + segs.slice(i).join("/");
    if (tail.length <= room) return { name, dir: tail };
  }
  return { name, dir: "…" + dir.slice(dir.length - (room - 1)) };
}

/** A Perforce opened-file action as the row's status slot draws it: add/branch/move/add → A,
 *  edit/integrate → M, delete/move/delete → D, anything else its first letter upper-cased. `title`
 *  is the action word in Title Case ("move/delete" → "Move/Delete"). */
export function p4ActionLetter(action: string): { letter: string; kind: StatusKind; title: string } {
  const title = action.split("/").map((part) => titleWords(part) || part).join("/");
  switch (action) {
    case "add": case "branch": case "move/add": return { letter: "A", kind: "added", title };
    case "edit": case "integrate": return { letter: "M", kind: "modified", title };
    case "delete": case "move/delete": return { letter: "D", kind: "deleted", title };
    default: return { letter: label(action.charAt(0)), kind: "untracked", title };
  }
}

/** A pending changelist's group head: "Default", else "#<change> <first line of description>"; the
 *  full description is the head's title. */
export function p4ChangeLabel(change: string, description: string): { label: string; title: string } {
  if (change === "default") return { label: "Default", title: "Default" };
  const first = description.trim().split(/\r?\n/)[0] ?? "";
  return { label: first ? `#${change} ${first}` : `#${change}`, title: description.trim() || `#${change}` };
}
