// Asset card and Find: pure mapping from the unreal_asset_card / unreal_find replies to display rows.
import type { UnrealAssetCard, UnrealFindMode, UnrealFindResult } from "../ipc";

export interface CardRow { label: string; value: string; tooltip?: string; dim?: boolean }
interface FindRowView { assetPath: string; name: string; detail: string }
export interface FindView { message: string | null; rows: FindRowView[] }

export const FIND_MODES: { mode: UnrealFindMode; label: string }[] = [
  { mode: "assetName", label: "Asset Name" },
  { mode: "childBlueprintsOf", label: "Child Blueprints Of" },
  { mode: "overridesOf", label: "Overrides Of" },
];

const EMPTY_PROPS_NOTE = "Rider Read No Properties";
const EMPTY_PROPS_TIP = "Rider's empty reply does not prove the asset has no properties.";

/** "Class.field": exactly one dot, both sides non-empty after trimming the whole query. */
export function parseOverrideQuery(q: string): { cls: string; field: string } | null {
  const parts = q.trim().split(".");
  if (parts.length !== 2) return null;
  const [cls, field] = parts;
  return cls && field ? { cls, field } : null;
}

export function cardRows(card: UnrealAssetCard): CardRow[] {
  const rows: CardRow[] = [
    { label: "Path", value: card.path },
    { label: "Object", value: card.objectName ?? "" },
    { label: "Parent Class", value: card.parentClass ?? "" },
    { label: "Asset Class", value: card.assetClass ?? "" },
  ];
  const change = card.lastChange;
  rows.push({
    label: "Last Change",
    value: change ? `${change.sha} · ${change.author} · ${change.when}` : "",
  });
  for (const p of card.props) rows.push({ label: p.name, value: p.value, tooltip: p.typeName });
  for (const note of card.notes) {
    rows.push({ label: "", value: note, dim: true, tooltip: note === EMPTY_PROPS_NOTE ? EMPTY_PROPS_TIP : undefined });
  }
  return rows;
}

/** noMatches reads "No Matches"; verifiedNone and checkDidntRun show the backend message above any rows. */
export function findView(result: UnrealFindResult): FindView {
  const rows = result.rows.map((r) => ({ assetPath: r.assetPath, name: r.name, detail: r.detail ?? "" }));
  switch (result.status) {
    case "noMatches":
      return { message: "No Matches", rows };
    case "verifiedNone":
    case "checkDidntRun":
      return { message: result.message ?? "No Matches", rows };
    default:
      return { message: null, rows };
  }
}
