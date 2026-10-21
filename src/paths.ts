// Frontend reader for contracts/paths.json: the new-layout path relative to the install root.
// No fs access; the shell resolves it against its own root (and any legacy fallback).
import contract from "../contracts/paths.json" with { type: "json" };

type Node = { under: string; rel: string };
const ids = contract.ids as Record<string, Node>;

export function rel(id: string): string {
  const n = ids[id];
  if (!n) throw new Error(`paths: unknown id "${id}"`);
  const base = n.under === "root" ? "" : rel(n.under);
  return [base, n.rel].filter(Boolean).join("/");
}
