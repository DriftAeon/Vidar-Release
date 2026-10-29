// src\launcher\set-pick.ts — the launcher's per-launch Rune Vault pick (a session
// loads exactly one vault). A Bare body row carries a Runes icon; it expands the pick inline under the
// row (Raw / Rendered / Resume move down). One row is ticked: the agent's stock vault, a saved vault
// (`rune_vault_list`), or Custom, which lists the library's sets to tick and makes a vault from them at Launch
// (`rune_vault_create`, an identical pick reuses its vault). The pre-pick is the last vault launched (roster.ts
// defaultVault). A plain click on the row still launches the pre-pick. The set-row helpers stay exported for
// Settings > Workspaces.
import { invoke } from "../ipc";
import type { SetRef, SetSource, Vault, VaultListed } from "../ipc";
import type { AgentType } from "../config";
import { loadConfig } from "../config";
import { iconImg } from "../icon-img";
import { agentKind, defaultVault } from "./roster";
import { libraryLabel } from "../runes/bare/gen-label";
import { showSessionsToast } from "../panels/sessions/zoom";

export interface PickRow {
  ref: SetRef;
  /** From the workspace's add-ons (below the divider), not the row's own sets or the library. */
  addon: boolean;
}

/** One set's identity, deduped case-blind. */
export const refKey = (ref: SetRef): string => `${(ref.library ?? "").toLowerCase()}/${ref.set.toLowerCase()}`;

/** How a set reads in the list: `library/set` for a named import library (named as the Runes view heads it,
 *  libraryLabel), else the bare set id. */
export const refLabel = (ref: SetRef): string => (ref.library ? `${libraryLabel(ref.library)}/${ref.set}` : ref.set);

const GEN_LIB = /^gen-.+-[0-9a-f]{8}$/;

const refs = (list: readonly SetRef[] | undefined): SetRef[] => list?.map((r) => ({ ...r })) ?? [];

/** Pure: the rows to offer. The given sets first, then every other library set, then the workspace's
 *  add-ons (those not already listed) behind the divider. */
export function pickRows(own: readonly SetRef[] | undefined, workspace: readonly SetRef[] | undefined, library: readonly SetRef[] | undefined, agent?: string): PickRow[] {
  const seen = new Set<string>();
  const take = (list: readonly SetRef[] | undefined): SetRef[] => refs(list).filter((r) => {
    const k = refKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const main = take(own);
  const addon = take(workspace);
  // Another agent's generated library stays out (matched by agent, so claude-bare and claude-rendered-bare
  // see each other's); own and workspace sets were taken above, so a chosen one is never dropped.
  const hidden = (r: SetRef): boolean => agent !== undefined && !!r.library && GEN_LIB.test(r.library) && !r.library.startsWith(`gen-${agent}-`);
  const rest = take(library).filter((r) => !hidden(r)).sort((a, b) => refLabel(a).localeCompare(refLabel(b)));
  return [
    ...main.map((ref) => ({ ref, addon: false })),
    ...rest.map((ref) => ({ ref, addon: false })),
    ...addon.map((ref) => ({ ref, addon: true })),
  ];
}

/** Pure: the ticked refs in list order. */
export function pickedRefs(rows: readonly PickRow[], ticked: ReadonlySet<string>): SetRef[] {
  return rows.filter((r) => ticked.has(refKey(r.ref))).map((r) => ({ ...r.ref }));
}

/** Every set the resolver can name (`bare_sets_list`: the rules library and each import library);
 *  empty when it cannot be read. */
export async function librarySets(): Promise<SetRef[]> {
  try {
    return await invoke("bare_sets_list");
  } catch (e) {
    console.error("set pick library:", e);
    return [];
  }
}

/** Pure: the vaults a row of `agent` offers, its stock vault first, then saved vaults by name. Another
 *  agent's stock vault stays out; a stock vault listed both as a template and as a store copy shows once. */
export function vaultRows(list: readonly VaultListed[], agent: string): VaultListed[] {
  const stock = `stock-${agent}`;
  const seen = new Set<string>();
  const keep = list.filter((v) => {
    if (v.id.startsWith("stock-") && v.id !== stock) return false;
    if (seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });
  return [...keep.filter((v) => v.id === stock), ...keep.filter((v) => v.id !== stock).sort((a, b) => a.name.localeCompare(b.name))];
}

/** Pure: the Custom vault's runesets. A rules-library set (no `library`) names the library by its folder,
 *  as Rust does (set_override::library_name); with no rulesLibrary it is dropped. */
export function customSources(picked: readonly SetRef[], rulesLibrary: string | undefined): SetSource[] {
  const lib = rulesLibrary?.split(/[\\/]/).filter(Boolean).pop();
  return picked.flatMap((r) => (r.library ? [{ library: r.library, set: r.set }] : lib ? [{ library: lib, set: r.set }] : []));
}

/** Makes (or reuses, D-i) the Custom vault for the ticked sets on top of the agent's stock runes. */
async function createCustom(agent: string, picked: readonly SetRef[]): Promise<string> {
  const { config } = await loadConfig();
  // The floor is the stock vault's runesets and runes (model: the floor lives in the template); Custom adds the
  // picks on top. A failed read of the stock vault surfaces as the launch error.
  const floor: Vault = (await invoke("rune_vault_read", { id: `stock-${agent}` })).vault;
  const picks = customSources(picked, config.rulesLibrary);
  const runesets = [...floor.runesets.map((c) => c.source), ...picks.filter((p) => !floor.runesets.some((c) => c.source.library === p.library && c.source.set === p.set))];
  const v = await invoke("rune_vault_create", { name: null, runesets, runes: floor.runes, agent });
  return v.id;
}

export interface SetPickOptions {
  variant: AgentType;
  /** Launch on this vault id. */
  launch: (vault: string) => void;
  /** Re-place the body column after the tray changed its height. */
  place: () => void;
}

const CUSTOM = "\u0000custom";

function tickRow(label: string, on: boolean, role: "radio" | "checkbox", toggle: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sp-row";
  b.setAttribute("role", role);
  const text = document.createElement("span");
  text.textContent = label;
  b.append(iconImg(on ? "check-circle" : "dismiss-circle"), text);
  setTick(b, on);
  b.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  return b;
}

function setTick(b: HTMLElement, on: boolean): void {
  b.setAttribute("aria-checked", String(on));
  b.classList.toggle("off", !on);
  if (b.firstChild) b.replaceChild(iconImg(on ? "check-circle" : "dismiss-circle"), b.firstChild);
}

/** Adds the Runes icon to a Bare body row; its click opens or closes the vault pick under the row. */
export function attachSetPick(rowEl: HTMLButtonElement, o: SetPickOptions): void {
  const agent = agentKind(o.variant.id);
  rowEl.classList.add("sp-host");
  const icon = document.createElement("span");
  icon.className = "sp-ico";
  icon.setAttribute("role", "button");
  icon.tabIndex = 0;
  icon.title = "Pick Vault";
  icon.setAttribute("aria-label", "Pick Vault");
  icon.setAttribute("aria-expanded", "false");
  icon.appendChild(iconImg("rules"));
  rowEl.appendChild(icon);

  let tray: HTMLElement | null = null;
  const close = () => {
    tray?.remove();
    tray = null;
    icon.setAttribute("aria-expanded", "false");
    o.place();
  };
  const open = () => {
    let vaults: VaultListed[] = [];
    let sets: PickRow[] = [];
    let picked = defaultVault(agent);
    const ticked = new Set<string>();
    const box = document.createElement("div");
    box.className = "sp-inline";
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", "Rune Vault");
    const list = document.createElement("div");
    list.className = "sp-list";
    const act = document.createElement("div");
    act.className = "sp-act";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "ws-btn";
    go.textContent = "Launch";
    go.addEventListener("click", (e) => {
      e.stopPropagation();
      if (picked !== CUSTOM) { o.launch(picked); return; }
      go.disabled = true;
      createCustom(agent, pickedRefs(sets, ticked))
        .then((id) => o.launch(id))
        .catch((err) => showSessionsToast(`Custom Vault Not Created: ${err instanceof Error ? err.message : String(err)}`, 6000))
        .finally(() => { go.disabled = false; });
    });
    act.appendChild(go);
    const draw = () => {
      // A pre-pick the list no longer holds (a deleted vault) falls back to the stock vault.
      if (picked !== CUSTOM && vaults.length && !vaults.some((v) => v.id === picked)) picked = vaults[0].id;
      const pick = (id: string) => { picked = id; draw(); };
      const rows = [
        ...vaults.map((v) => tickRow(v.name, picked === v.id, "radio", () => pick(v.id))),
        tickRow("Custom", picked === CUSTOM, "radio", () => pick(CUSTOM)),
      ];
      if (picked === CUSTOM) {
        sets.forEach((r, i) => {
          const k = refKey(r.ref);
          const b = tickRow(refLabel(r.ref), ticked.has(k), "checkbox", () => {
            if (ticked.has(k)) ticked.delete(k); else ticked.add(k);
            setTick(b, ticked.has(k));
          });
          if (i === 0) b.classList.add("addon"); // the divider row: Custom's sets sit behind it
          rows.push(b);
        });
      }
      list.replaceChildren(...rows);
      o.place();
    };
    box.append(list, act);
    // Up and Down walk the tray; the launcher's own walk only sees a column's direct rows.
    box.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation();
      const stops = [...box.querySelectorAll<HTMLButtonElement>("button")];
      const at = stops.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      stops[(at + step + stops.length) % stops.length]?.focus();
    });
    rowEl.after(box);
    tray = box;
    icon.setAttribute("aria-expanded", "true");
    draw();
    // The vault list and the library's sets arrive after the first draw; the pick the user made stays.
    void invoke("rune_vault_list").catch((e) => { console.error("vault pick:", e); return [] as VaultListed[]; }).then((all) => {
      if (tray !== box) return;
      vaults = vaultRows(all, agent);
      draw();
    });
    void librarySets().then((library) => {
      if (tray !== box) return;
      sets = pickRows(undefined, undefined, library, o.variant.id);
      if (picked === CUSTOM) draw();
    });
  };
  const toggle = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    if (tray) close(); else open();
  };
  icon.addEventListener("click", toggle);
  icon.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
  });
}
