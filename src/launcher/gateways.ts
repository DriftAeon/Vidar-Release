// src\launcher\gateways.ts — the gateway modules (agent.gateway in a pack's module block) as the
// launcher sees them: which are present, their root order, and their art. Re-syncs on every module
// change; roster.ts builds the rows from gatewayModules(), agent-kind.ts answers isGateway
// from the ids written here.
import { invoke } from "../ipc";
import { gatewayModuleRows, onModulesChange, type ModuleRow } from "../modules/registry";
import { setGatewayIds } from "./agent-kind";
import { gatewayMark, setGatewayMarks, type VendorMark } from "./menu-rows";
import { setGatewayRootOrder } from "./roster-shown";

/** Present gateway modules (dropped ones excluded; an unmet `when` still counts, `requires` hides
 *  the rows), by agent.order then id. */
export function gatewayModules(): ModuleRow[] {
  return gatewayModuleRows()
    .sort((a, b) => (a.agent?.order ?? 1e9) - (b.agent?.order ?? 1e9) || a.id.localeCompare(b.id));
}

/** Ids, in order, as one comparable string (callers rebuild the launcher when it changes). */
export function gatewayKey(): string {
  return gatewayModules().map((m) => m.id).join(",");
}

const urls = new Map<string, string>();
const failed = new Set<string>();
let sheet: CSSStyleSheet | null = null;

async function artUrl(id: string): Promise<string | undefined> {
  const hit = urls.get(id);
  if (hit) return hit;
  if (failed.has(id)) return undefined;
  try {
    const bytes = await invoke("module_art", { id });
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    urls.set(id, url);
    return url;
  } catch (e) {
    failed.add(id);
    console.warn(`module art for ${id} failed`, e);
    return undefined;
  }
}

// One constructed stylesheet holds the tab and rune marks of every gateway module (leftbar.css and
// runes.css carry the core agents' own). Ids match the module idPattern, so the selector is safe.
async function paintArt(mods: ModuleRow[]): Promise<void> {
  const rules: string[] = [];
  const marks: VendorMark[] = [];
  for (const m of mods) {
    const art = m.agent?.art;
    if (!art) continue;
    const url = await artUrl(m.id);
    if (!url) continue;
    rules.push(`.session-btn[data-art="${m.id}"] .session-wheel { --tab-art: url("${url}"); }`);
    rules.push(`.runes-mark[data-art="${m.id}"] { background-image: url("${url}"); }`);
    marks.push(gatewayMark(m.id, url, art.tint));
  }
  setGatewayMarks(marks);
  sheet ??= new CSSStyleSheet();
  sheet.replaceSync(rules.join("\n"));
  if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

let lastKey = "";
export function syncGateways(): void {
  const mods = gatewayModules();
  setGatewayIds(mods.map((m) => m.id));
  setGatewayRootOrder(mods.map((m) => m.id));
  const key = mods.map((m) => m.id).join(",");
  if (key === lastKey) return;
  lastKey = key;
  void paintArt(mods);
}

onModulesChange(syncGateways);
