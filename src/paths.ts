// Frontend reader for contracts/paths.json: the new-layout path relative to the install root.
// No fs access; the shell resolves it against its own root (and any legacy fallback).
import contract from "../contracts/paths.json" with { type: "json" };

type Node = { under: string; rel: string };
const ids = contract.ids as Record<string, Node>;

/** The last segment of a Windows path (the path itself when it has no backslash). */
export function basename(path: string): string {
  return path.split("\\").pop() ?? path;
}

/** A Windows path with forward slashes and no trailing slash; case is kept (callers lowercase). */
export function normWin(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The last segment of a path split on either separator. */
export function baseAny(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function rel(id: string): string {
  const n = ids[id];
  if (!n) throw new Error(`paths: unknown id "${id}"`);
  const base = n.under === "root" ? "" : rel(n.under);
  return [base, n.rel].filter(Boolean).join("/");
}
