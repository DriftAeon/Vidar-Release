// vault-pick-view.ts — the Runes panel's Pick state for a Rendered Bare tab that waits for its Rune
// Vault (panels/rendered/vault-gate.ts). The one new component is the small Vault Card: a head with the safe icon and the vault's
// name, and Modify's checkbox in its left slot. Cards start expanded; clicking the head collapses or expands
// the card's interior; the checkbox picks it (single-select); the two are independent. The interior is the existing Runes read view,
// read-only: view-vault.ts `vaultModify({ readOnly })` over the vault read. Start hands the pick to `pickTabVault`.
// New Rune Vault (the green button under the cards) swaps the list for the Runes view's own Modify on a draft that
// starts from the Vidar Runeset alone (vault-draft.ts, mounted by the panel through `ctx.draft`): Done names and makes the
// vault (vault-create.ts) and returns here with it picked and expanded; Cancel returns here unchanged.
import type { VaultListed } from "../../ipc";
import { vaultIpc, type VaultIo } from "./vault-io";
import { titleWords } from "../../format";
import { fillCard, type CardCtx } from "../cards";
import { checkBox } from "../check-box";
import { iconImg } from "../../icon-img";
import { button, el } from "../../dom";
import type { VaultView } from "./cake";
import { vaultModify } from "./view-vault";
import { createFromDraft, type DraftCreate } from "./vault-create";
import type { VaultDraft } from "./vault-draft";
import { pickTabVault } from "../../launcher/vault-pick";
import { hiddenVault, vaultRows } from "../../launcher/start-vault";
import { defaultVault } from "../../launcher/roster";
import { errText } from "../../err-text";

/** The calls the Pick state makes (the vault ones from vault-io.ts); tests hand their own. */
export type VaultPickIo = Pick<VaultIo, "list" | "read"> & {
  /** The agent's Last Vault, preselected when the list still holds it; none yet = undefined. */
  last(agent: string): string | undefined;
  /** New Rune Vault's Done: the one create path (vault-create.ts). */
  create: DraftCreate;
  pick(tab: string, vault: string): boolean | Promise<boolean>;
};

const realIo: VaultPickIo = {
  list: vaultIpc.list,
  read: vaultIpc.read,
  last: defaultVault,
  create: createFromDraft,
  pick: pickTabVault,
};

/** The draft editor the panel mounts (view.ts on `draftIo(base)`): its root replaces the list until Done or Cancel. */
export interface DraftEditor { root: HTMLElement; dispose(): void }

export interface VaultPickCtx {
  tab: string;
  agent: string;
  card: CardCtx;
  /** The pick landed: the panel returns to its normal view. */
  onStarted(): void;
  /** Mounts Modify on a draft of the blank vault with `hooks` as its Done and Cancel (panels/runes.ts). */
  draft(hooks: VaultDraft): DraftEditor;
  io?: VaultPickIo;
}
export interface VaultPickHandle { root: HTMLElement; dispose(): void }

const TIP_PICK = "Picks this vault for the waiting tab.";
const TIP_EXPAND = "Shows or hides the runes this vault holds, read-only.";
const TIP_START = "Starts the tab with the picked vault.";
const NO_PICK = "Pick a Vault to Start";

export function mountVaultPick(host: HTMLElement, ctx: VaultPickCtx): VaultPickHandle {
  const io = ctx.io ?? realIo;
  const root = el("div", "vpick");
  host.appendChild(root);
  let vaults: VaultListed[] = [];
  const views = new Map<string, VaultView>();
  let picked: string | null = null;
  let busy = false, disposed = false, loaded = false;
  let error: string | null = null;
  let editor: DraftEditor | null = null;
  const collapsed = new Set<string>();
  const open = new Map<string, boolean>();
  const trackOpen = (det: HTMLDetailsElement, key: string, dflt: boolean): void => {
    det.open = open.get(key) ?? dflt;
    fillCard(det);
    det.addEventListener("toggle", () => open.set(key, det.open));
  };

  function interior(id: string): HTMLElement {
    const body = el("section", "runes-bare vpick-body");
    const view = views.get(id);
    if (view) {
      body.append(...vaultModify({ view, removed: [], pending: null, busy: false, readOnly: true, card: ctx.card, trackOpen,
        pick: async () => undefined }));
    }
    return body;
  }

  function vaultCard(id: string, name: string): HTMLElement {
    const card = el("details", "vpick-card");
    card.dataset.vault = id;
    const isPicked = picked === id;
    card.classList.toggle("is-picked", isPicked);
    const top = el("summary", "vpick-top");
    top.title = TIP_EXPAND;
    // left slot: Modify's checkbox, single-select. Ticking the picked vault keeps it ticked (a Start needs a pick;
    // today's card never clears one). check-box.ts stops the click, so it never toggles the expansion.
    const slot = el("span", "vpick-tick-slot");
    slot.append(checkBox({ state: isPicked ? "on" : "off", disabled: busy, label: name,
      title: `${isPicked ? "On" : "Off"}\n${TIP_PICK}`,
      flip: () => { picked = id; error = null; paint(); } }));
    const text = el("span", "vpick-text");
    const head = el("span", "vpick-name-row");
    const safe = iconImg("safe-gold");
    safe.classList.add("vpick-icon");
    head.append(safe, el("span", "vpick-name", name));
    text.append(head);
    top.append(slot, text);
    card.append(top);
    // cards start expanded; a collapse is remembered across repaints
    card.open = !collapsed.has(id);
    if (card.open) card.append(interior(id));
    // a click on the head expands or collapses the runes list like the inner set cards; it never changes the pick
    top.addEventListener("click", (e) => {
      e.preventDefault();
      card.open = !card.open;
      if (card.open) { collapsed.delete(id); card.append(interior(id)); }
      else { collapsed.add(id); card.querySelector(":scope > .vpick-body")?.remove(); }
    });
    return card;
  }

  async function start(): Promise<void> {
    if (!picked || busy || disposed) return;
    busy = true; error = null; paint();
    try {
      if (!(await io.pick(ctx.tab, picked))) throw new Error("This tab is no longer waiting for a vault.");
      // Start stays in its busy state: the host keeps this card on screen until the vault view has painted, then disposes it
      if (!disposed) ctx.onStarted();
      return;
    } catch (e) {
      error = errText(e);
    }
    busy = false;
    if (!disposed) paint();
  }

  // The draft leaves: its editor goes and the list paints again (the pick as it was, or the vault Done made)
  function closeDraft(): void {
    editor?.dispose();
    editor = null;
    if (!disposed) paint();
  }

  function newVault(): void {
    if (busy || disposed || editor) return;
    error = null;
    editor = ctx.draft({
      name: "",
      create: async (name, base, ops) => {
        const made = await io.create(name, base, ops);
        // the new vault joins the list picked and expanded; a failed read keeps its card with the name only
        try { vaults = await io.list(); } catch { vaults = [...vaults, { id: made.id, name, template: false, hash: "", lockedUtc: null }]; }
        try { views.set(made.id, await io.read(made.id, undefined, ctx.agent)); } catch { /* the card keeps its name */ }
        picked = made.id;
        collapsed.delete(made.id);
        error = made.error ?? null;
        closeDraft();
      },
      cancel: closeDraft,
    });
    root.replaceChildren(editor.root);
  }

  function paint(): void {
    if (disposed || editor) return;
    const list = el("div", "vpick-list");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Rune Vault");
    list.setAttribute("aria-busy", String(!loaded || busy));
    for (const v of vaultRows(vaults)) list.append(vaultCard(v.id, titleWords(v.name) || v.name));
    if (loaded) {
      // a card frame like the vaults', holding only the button, so it reads as "add a vault"
      const add = el("div", "vpick-add");
      const row = el("div", "vpick-add-row");
      row.append(button("New Rune Vault", "ws-btn ws-add vpick-new", newVault, busy));
      add.append(row);
      list.append(add);
    }
    const act = el("div", "vpick-act");
    if (error) {
      const note = el("div", "runes-err vpick-error", error);
      note.setAttribute("role", "alert");
      act.append(note);
    }
    const go = button("Start Session", "ws-btn ws-add vpick-start", () => void start(), !picked || busy);
    go.title = picked ? TIP_START : NO_PICK;
    act.append(go);
    root.replaceChildren(list, act);
  }

  async function load(): Promise<void> {
    try {
      vaults = await io.list();
      const rows = vaultRows(vaults);
      let last: string | undefined = io.last(ctx.agent);
      // Last Vault can be a copy (hidden from the cards): pre-pick the vault it was started from
      if (last && hiddenVault(last)) {
        try {
          const from = (await io.read(last, undefined, ctx.agent)).vault.from;
          last = from && "vault" in from ? from.vault : undefined;
        } catch { last = undefined; }
      }
      if (!picked && rows.some((v) => v.id === last)) picked = last ?? null;
      await Promise.all(rows.map(async (v) => { try { views.set(v.id, await io.read(v.id, undefined, ctx.agent)); } catch { /* the card keeps its name, no counts */ } }));
    } catch (e) {
      error = errText(e);
    }
    loaded = true;
    paint();
  }
  paint();
  void load();
  return { root, dispose() { disposed = true; editor?.dispose(); editor = null; root.remove(); } };
}
