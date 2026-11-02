// Changes tab Asset Diff, pure half: which rows get the button and how a result maps to slot lines
// (DOM and the expanded-slot store: asset-slots.ts). No runtime imports, so node tests load it.
import type { UnrealAssetDiff } from "../ipc";

export const ASSET_DIFF_TIP = "Shows the asset's changed properties, read through Rider.";

export function isAssetFile(path: string): boolean {
  return /\.(uasset|umap)$/i.test(path);
}

export interface DiffLine { text: string; tip: string | null; dim: boolean }

/** One line per changed property, `name: old → new`; a missing side shows empty. */
export function diffLines(d: UnrealAssetDiff): DiffLine[] {
  const out: DiffLine[] = [];
  if (d.status === "noChanges") out.push({ text: "No Property Changes", tip: null, dim: false });
  else if (d.status === "unknown") out.push({ text: "Changes Unknown", tip: null, dim: false });
  for (const r of d.rows) out.push({ text: `${r.name}: ${r.old ?? ""} → ${r.new ?? ""}`, tip: r.typeName, dim: false });
  for (const n of d.notes) out.push({ text: n, tip: null, dim: true });
  return out;
}

export const slotKey = (staged: boolean, path: string) => `${staged ? "staged" : "changes"}:${path}`;
