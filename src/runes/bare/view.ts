// Runes View and Modify show the focused session's Rune Vault.
import { iconImg, type ColorIcon } from "../../icon-img";
import { KIND_ICON } from "../kind-icons";
import { fillCard, type CardCtx } from "../cards";
import { createBareFlow, agentFiles, nonSdkTicks, defaultTicks, watchGenerating,
  type ActionResult, type BareFlowIo, type BareLocalFile, type BareLocalSources, type BareModuleBundles } from "./flow";
import { invoke } from "../../ipc";
import { type SessionVault, type VaultViewRune } from "./cake";
import type { VaultIo } from "./vault-io";
import { createAgentView, type GenCtx } from "./agent-view";
import { button, el } from "../../dom";
import { filesView, generatable } from "./view-files";
import { without, type DeleteTarget } from "./library-delete";
import { vaultModify } from "./view-vault";
import { libraryPane } from "./view-library";
import { vaultModifyState } from "./vault-modify-state";
import {
  effectiveOn, flip, isPending, forget, forgetSet, pendingOps, setTarget, setWanted, styleTargets as stylesOf,
  type Based, type PendingCtl,
} from "./vault-pending";
import { lockButton, paintLock } from "./view-sets";
import { errorLine } from "./view-data";
import { doneGate, startView } from "./view-entry";
import { nameAndPath, isFileRow } from "./row-name";
import { mcpTickRow } from "./module-ticks";
import type { VaultEditIo } from "./vault-edit";
import type { VaultDraft } from "./vault-draft";
import { createVault } from "./vault-create";
import type { AgentId } from "../../agents/id";
// @ts-ignore TS5097: node --test loads this module directly
import { AGENTS } from "../../agents/descriptor.ts";
import { titleWords } from "../../format";
import { captureField, restoreField, type FieldFocus } from "./field-focus";
import { checkBox, checkRow } from "../check-box";
import type { RunesLoaded } from "../types";
import { errText } from "../../err-text";

export { errorLine, hueOf } from "./view-data";
export { genLabel } from "./gen-label";

export interface BareViewCtx {
  agent: AgentId; cwd: string; profile: string; trustParts?: HTMLElement[]; card?: CardCtx;
  gen?: () => GenCtx; modelsReady?: Promise<unknown>;
  start?: "files"; onDone?(): void;
  vault?: Pick<VaultIo, "session" | "read" | "lock">; vaultEdit?: VaultEditIo;
  /** Waits before each re-read of an absent session record (tests shorten it). */
  retryMs?: number[];
  /** False when the tab launched without a vault: an absent record then paints No Vault Session at once. */
  retry?: boolean;
  /** Fires once, at the first paint after the session record resolved (read, absent for good, or failed). */
  onReady?: () => void;
  warningLine?: (warning: string) => HTMLElement | null;
  /** The Make Variant notice, handed to the pane head (null clears it); absent, it draws as a note line in the body. */
  headNote?: (text: string | null) => void;
  headName?: (text: string | null) => void;
  /** Delete Rune / Delete Runeset (`rune` names the rune or the runeset); absent, the `bare_library_delete` command. Resolves the vault names that dropped it. */
  libraryDelete?: (library: string, rune: string) => Promise<{ vaults: string[] }>;
  /** Modify opened (true) or closed (false); Done's click closes it at once for the caller (the left cover drops). */
  onModifyChange?: (on: boolean) => void;
  /** The caller places `libraryRoot` (the left cover); absent, the Rune Library draws above the vault in `root`. */
  placesLibrary?: boolean;
  /** New Rune Vault (vault-draft.ts): the view opens straight into Modify on a vault not yet made (`vault` and
   *  `vaultEdit` come from `draftIo`). Done asks the name (Save Vault As's prompt) and hands it with the staged ops
   *  to `draft.create`; dismissing the prompt stays in Modify; Cancel runs `draft.cancel`. */
  draft?: VaultDraft;
}
export interface BareViewHandle {
  root: HTMLElement; modeButton: HTMLButtonElement; lockButton: HTMLButtonElement;
  /** Modify's Cancel: drops the staged changes, sends nothing. Hidden outside Modify. */
  cancelButton: HTMLButtonElement;
  /** The Rune Library pane, filled while Modify is open (empty and hidden otherwise). */
  libraryRoot: HTMLElement;
  setTrust(parts: HTMLElement[]): void; setLoads(loads: RunesLoaded | null): void; reload(): void; dispose(): void;
}
const LAYER_KINDS = [
  ["skill", "Skills", KIND_ICON.skill], ["agent", "Agents", KIND_ICON.agent], ["hook", "Hooks", KIND_ICON.hook],
  ["mcp", "MCPs", KIND_ICON.mcp],
] as const;
const NOTE_VAULT = "Changes this tab's vault; before the vault locks, the tab restarts as a fresh session.";
const NOTE_MODIFY = "Opens this tab's vault for changes.";
const NOTE_CANCEL = "Drops this Modify's changes; nothing is sent to the vault.";
const NO_VAULT = "No Vault Session";
/** Why a Local Files row can't be ticked (local.rs reasons); unlisted reasons read the general line. */
const UNPICKABLE: Partial<Record<string, string>> = {
  notModule: "Not a Vidar MCP module, so a Bare tab can't carry it.",
  stdio: "A local (stdio) MCP server; a Bare tab carries hosted ones only.",
  notHosted: "Not a hosted server, so a Bare tab can't carry it.",
  tooLarge: "Too large for a Bare tab to carry.",
  shadowed: "Shadowed by an override file, so it never loads.",
  pathScoped: "Path-scoped, so a Bare tab doesn't load it.",
};
const UNPICKABLE_ANY = "A Bare tab can't carry this.";
const RETRY_MS = [250, 500, 1000, 2000, 1250];

export function mountBareView(host: HTMLElement, ctx: BareViewCtx, io: BareFlowIo, loads?: RunesLoaded | null): BareViewHandle {
  let loadsNow = loads ?? null;
  const agent = ctx.agent;
  const root = el("div", "runes-bare");
  host.appendChild(root);
  const trace = el("div", "runes-bare-trace");
  trace.replaceChildren(...(ctx.trustParts ?? []));
  trace.hidden = !trace.childElementCount;
  const modeButton = el("button", "ws-btn runes-mode");
  modeButton.type = "button";
  const cancel = button("Cancel", "ws-btn runes-cancel", () => cancelModify(), false);
  cancel.title = NOTE_CANCEL;
  cancel.hidden = true;
  const libraryRoot = el("div", "runes-bare runes-library");
  libraryRoot.hidden = true;
  const lock = lockButton();
  const vm = vaultModifyState(ctx.vaultEdit, agent);
  const flow = createBareFlow(io, { cwd: ctx.cwd, agent, session: ctx.vault?.session, read: ctx.vault?.read });
  const card = ctx.card ?? { openInDocument: () => {}, note: () => {} };
  let vault: SessionVault | null = null;
  let modify = false, busy = false, disposed = false, loaded = false, readyFired = false;
  let view: "actives" | "files" | "agent" = "actives";
  let error: ActionResult | null = null;
  let sources: BareLocalSources | null = null, sourcesErr: string | null = null;
  let bundles: BareModuleBundles | null = null;
  let ticked = new Set<string>();
  let deleting: DeleteTarget | null = null;
  const open = new Map<string, boolean>();
  // an open Save Vault As form focuses its Name once; a repaint keeps the focused field and caret
  let wantField: FieldFocus | null = null;
  const gate = doneGate(ctx.onDone);
  // every output-style target the vault, a staged runeset or the library offers, with its saved state: a style switched
  // on in Modify switches these off over the staged changes (vault-pending.ts setWanted)
  const styleTargets = (): Based[] => vm.now ? stylesOf(vm.now, vm.changes, vm.library ?? []) : [];
  // Modify's checkboxes read and flip the staged changes; a flip while busy or while the choice card asks is dropped
  const pend: PendingCtl = {
    on: (t, base) => effectiveOn(vm.changes, t, base),
    pending: (t) => isPending(vm.changes, t),
    flip: (t, base) => { if (busy || vm.pending) return; flip(vm.changes, t, base, styleTargets()); paint(); },
    set: (ts, on) => {
      if (busy || vm.pending) return;
      const styles = styleTargets();
      for (const b of ts) setWanted(vm.changes, b.target, b.base, on, styles);
      paint();
    },
    get count() { return vm.changes.size; },
    staged: () => [...vm.changes.values()],
  };
  const trackOpen = (det: HTMLDetailsElement, key: string, dflt: boolean): void => {
    det.open = open.get(key) ?? dflt;
    fillCard(det);
    det.addEventListener("toggle", () => open.set(key, det.open));
  };
  const agentV = createAgentView({
    agent, flow, gen: ctx.gen, paint, enter: () => { view = "agent"; gate.ran(); },
    // Add to Vault stages the generated runeset as one addRuneset and opens Modify on the vault view: Done sends it
    // with the rest, Cancel drops it. The card's button stays, since nothing is in the vault yet.
    ...(ctx.vaultEdit ? { addToVault: async (r: { library: string; set: string }) => {
      if (!vm.now || busy) return false;
      const source = { library: r.library, set: r.set };
      const base = vm.now.vault.runesets.some((x) => x.source.library === source.library && x.source.set === source.set);
      if (!modify) openModify();
      setWanted(vm.changes, setTarget(source, vm.librarySets, vm.library ?? []), base, true, styleTargets());
      view = "actives";
      paint();
      return false;
    } } : {}),
    done: () => { view = "actives"; loaded = true; paint(); },
  });
  const unwatch = watchGenerating(paint);
  void ctx.modelsReady?.then(paint);

  async function act(fn: () => Promise<void>): Promise<void> {
    if (busy || disposed) return;
    busy = true; root.setAttribute("aria-busy", "true"); paint();
    try { await fn(); }
    finally { busy = false; root.removeAttribute("aria-busy"); if (!disposed) paint(); }
  }
  // A new tab can be read before its launch has written the session record: an absent record is re-read on a bounded
  // backoff and shows nothing meanwhile; NO_VAULT paints only once the backoff has run out.
  const delays = ctx.retry === false ? [] : ctx.retryMs ?? RETRY_MS;
  let attempt = 0, retryTimer: ReturnType<typeof setTimeout> | null = null;
  async function readVault(): Promise<void> {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    let failed = false;
    try {
      vault = await flow.load();
      await vm.read(vault?.session.vault.id ?? null);
      error = null;
    } catch (e) {
      vault = null; vm.now = null; failed = true;
      error = { ok: false, reason: "failed", error: String(e) };
    }
    if (vault || failed || attempt >= delays.length) { loaded = true; attempt = 0; return; }
    loaded = false;
    const run = (): void => {
      retryTimer = null;
      if (disposed) return;
      if (busy) retryTimer = setTimeout(run, 50);
      else void act(readVault);
    };
    retryTimer = setTimeout(run, delays[attempt++]);
  }
  async function vaultWrite(run: () => Promise<void>): Promise<void> {
    await act(async () => {
      let failed: ActionResult | null = null;
      try { await run(); }
      catch (e) { failed = { ok: false, reason: "failed", error: String(e) }; }
      await readVault();
      if (failed) error = failed;
    });
  }
  async function loadCandidates(): Promise<void> {
    try {
      sources = await io.localSources(ctx.cwd);
      sources = { ...sources, files: agentFiles(sources.files, agent) };
      sourcesErr = null;
      if (io.moduleBundles) bundles = await io.moduleBundles();
    } catch (e) { sourcesErr = String(e); }
  }
  async function loadLibrary(): Promise<void> {
    try {
      await vm.loadLibrary(async () => {
        const r = await invoke("rune_vault_library_runes", { agent });
        return { runes: r.runes as VaultViewRune[], warnings: r.warnings, runesets: r.runesets ?? [] };
      });
    } catch (e) { error = { ok: false, reason: "failed", error: String(e) }; }
  }
  // Modify opens on the saved vault with nothing staged, and reads the Rune Library (and Generate Runes from Local's candidates)
  function openModify(): void {
    modify = true;
    vm.reset();
    vm.notice = null;
    ctx.onModifyChange?.(true);
    void act(async () => { if (!sources) await loadCandidates(); await loadLibrary(); });
  }
  // Leaving Modify (Done landed, Cancel, a Make Variant) drops whatever is staged
  function closeModify(): void {
    if (!modify) return;
    modify = false;
    vm.reset();
    deleting = null;
    ctx.onModifyChange?.(false);
  }
  function cancelModify(): void {
    if (busy) return;
    if (ctx.draft) { ctx.draft.cancel(); return; }
    closeModify();
    paint();
  }
  // A draft's Done: the name prompt opens (focused); with it open and a name typed, the draft is made from the blank
  // vault (`from: null`) plus the staged ops. The store's refusal (a taken name) shows on the prompt, the draft kept.
  function draftDone(): void {
    if (busy || !ctx.draft) return;
    // a name set from the head's pencil skips the prompt; the prompt opens only for an unnamed draft (or after a refusal)
    const preset = ctx.draft.name?.trim() ?? "";
    if (!vm.saveAs.open && !preset) {
      vm.saveAs.open = true; vm.saveAs.error = null;
      wantField = { key: "saveas-name", start: null, end: null };
      paint();
      return;
    }
    const name = vm.saveAs.open ? vm.saveAs.name.trim() : preset;
    if (!name || !vm.now) return;
    const draft = ctx.draft;
    void act(async () => {
      vm.saveAs.error = null;
      try {
        const ops = pendingOps(vm.changes);
        await draft.create(name, null, ops);
      } catch (e) {
        // the refusal shows on the prompt: open it holding the head's name
        if (!vm.saveAs.open) { vm.saveAs.open = true; vm.saveAs.name = name; }
        vm.saveAs.error = errText(e);
      }
    });
  }
  // Done: nothing staged closes Modify with no IPC; otherwise a fresh read re-baselines the changes and the batch
  // goes as one vault edit. Landed, Modify closes; a locked vault parks the batch on
  // the choice card (Modify stays, boxes still); a refusal shows on the error line, the changes kept.
  async function done(): Promise<void> {
    if (busy) return;
    if (ctx.draft) { draftDone(); return; }
    if (!vm.changes.size) { closeModify(); paint(); return; }
    // the caller's left cover drops on the click, not when the write lands
    ctx.onModifyChange?.(false);
    await act(async () => {
      try {
        await readVault();
        if (!vm.now) return;
        const ops = pendingOps(vm.changes);
        if (!ops.length) { closeModify(); return; }
        const r = await vm.commit(ops);
        if (r.kind === "ask") return;
        closeModify();
        await readVault();
        if (r.error) error = { ok: false, reason: "failed", error: r.error };
      } catch (e) { error = { ok: false, reason: "failed", error: String(e) }; }
    });
    // parked on the choice card or refused: Modify stays, and so does the caller's cover
    if (modify && !disposed) ctx.onModifyChange?.(true);
  }
  modeButton.addEventListener("click", () => {
    if (modify) { void done(); return; }
    openModify();
    paint();
  });
  lock.addEventListener("click", () => {
    if (vault && ctx.vault) void vaultWrite(async () => { await ctx.vault!.lock(vault!.session.vault.id, vault!.session.vault.hash); });
  });
  function runDelete(): void {
    const t = deleting;
    if (!t) return;
    deleting = null;
    void act(async () => {
      try {
        await (ctx.libraryDelete ?? ((library, rune) => invoke("bare_library_delete", { library, rune })))(t.library, t.id);
        if (t.runeset) {
          // a runeset leaves alone: its runes stay in the library and the reread drops them into the Rune Satchel
          const s = { library: t.library, set: t.id };
          vm.removed = vm.removed.filter((r) => !r.set || r.set.library !== s.library || r.set.set !== s.set);
          forgetSet(vm.changes, s);
        } else {
          vm.removed = without(vm.removed, t);
          if (vm.library) vm.library = without(vm.library, t);
          // a staged change naming a deleted rune has nothing left to switch
          forget(vm.changes, t.library, t.id);
        }
        await loadLibrary();
        await readVault();
      } catch (e) { error = { ok: false, reason: "failed", error: String(e) }; }
    });
  }
  function tickRow(f: BareLocalFile, on: boolean, flip: () => void, off: boolean, icon?: ColorIcon | null): HTMLElement {
    const b = button(f.shown, "rp-source", flip, off || !f.pickable);
    b.dataset.path = f.path;
    b.setAttribute("aria-pressed", String(on));
    if (isFileRow(f)) { b.replaceChildren(...nameAndPath(f)); b.title = f.path; }
    else if (f.kind === "mcp") mcpTickRow(b, f, bundles, "");
    // the kind head's icon leads the row, in a Kind slot lined up under the head's (runes-bare.css .rp-kslot)
    if (icon) { const slot = el("span", "rp-kslot"); slot.appendChild(iconImg(icon)); b.prepend(slot); b.classList.add("has-kicon"); }
    const row = checkRow(checkBox({ state: on ? "on" : "off", disabled: off || !f.pickable,
      title: on ? "Chosen" : "Not Chosen", label: `${f.shown}: ${on ? "Chosen" : "Not Chosen"}`, flip }), b);
    // an unpickable row stays dimmed and says why on hover: a disabled box alone read as broken
    if (!f.pickable) { const why = UNPICKABLE[f.reason ?? ""] ?? UNPICKABLE_ANY; row.title = why; b.title = b.title ? `${b.title}\n${why}` : why; }
    return row;
  }
  async function openFiles(): Promise<void> {
    await act(async () => {
      try {
        await loadCandidates();
        ticked = AGENTS[agent].flowSdk ? defaultTicks(sources?.files ?? []) : nonSdkTicks(sources?.files ?? [], agent);
      } catch (e) { sourcesErr = String(e); }
      view = "files";
    });
  }
  // the Rune Library: filled while Modify shows the vault, empty and hidden otherwise
  function paintLibrary(): void {
    const show = modify && view === "actives" && !!vault && !!vm.now;
    libraryRoot.hidden = !show;
    if (!show || !vm.now) { libraryRoot.replaceChildren(); return; }
    libraryRoot.replaceChildren(...libraryPane({
      runes: vm.library, runesets: vm.librarySets, view: vm.now, changes: vm.changes, pend, still: busy || !!vm.pending, busy, card, loads: loadsNow, trackOpen,
      deleting, askDelete: (t: DeleteTarget) => { deleting = t; paint(); },
      confirmDelete: runDelete, cancelDelete: () => { deleting = null; paint(); },
    }));
  }
  function paint(): void {
    if (disposed) return;
    ctx.headName?.(vault ? vault.view.vault.name || titleWords(vault.view.vault.id) : null);
    const parts: HTMLElement[] = [];
    if (view === "files") parts.push(...filesView({
      agent, sources, sourcesErr, ticked, busy,
      layerKinds: LAYER_KINDS.filter(([kind]) => AGENTS[agent].flowSdk || kind !== "hook") as never,
      trackOpen, tickRow, error: (text) => el("div", "rp-error", text),
      generateButton: () => sources ? agentV.generateButton(sources, ticked, generatable(sources.files, ticked)) : null,
      selects: () => agentV.selects(), back: () => { view = "actives"; paint(); }, paint,
    }));
    else if (view === "agent") parts.push(...agentV.generatingView());
    else {
      if (error) {
        const e = errorLine(error, "load");
        if (e) { const d = el("div", "rp-error", e.text); d.title = e.title ?? ""; parts.push(d); }
      } else if (loaded && !vault) parts.push(el("div", "runes-bare-note", NO_VAULT));
      const notice = vm.notice && !modify ? vm.notice : null;
      if (ctx.headNote) ctx.headNote(notice);
      else if (notice) parts.push(el("div", "runes-bare-note", notice));
      const doneLine = agentV.doneLine();
      if (doneLine) parts.push(doneLine);
      if (vault) {
        const displayed = modify ? vm.now : vault.view;
        const shown = displayed?.warnings ?? [];
        const picker = modify && vm.library ? vm.libraryWarnings.filter((w) => !shown.includes(w)) : [];
        for (const warning of [...shown, ...picker]) {
          const line = ctx.warningLine ? ctx.warningLine(warning) : el("div", "runes-err", warning);
          if (line) parts.push(line);
        }
        if (modify && displayed && !ctx.placesLibrary) parts.push(libraryRoot);
        if (displayed) parts.push(...vaultModify({
          view: displayed, removed: modify ? vm.removed : [], pending: modify ? vm.pending : null,
          busy, readOnly: !modify, card, trackOpen, loads: loadsNow,
          pend: modify ? pend : undefined,
          libraryRunes: vm.library, librarySets: vm.librarySets,
          pick: async (p) => {
            // throws the store's refusal onto the choice card, Modify and the batch kept
            const late = await vm.pick(p);
            // the pick landed (Edit Original, or Make Variant with its notice): Modify closes
            closeModify();
            await act(readVault);
            if (late) { error = { ok: false, reason: "failed", error: late }; paint(); }
          },
          ...(modify ? {
            files: () => void openFiles(),
            // a draft shows the prompt only once Done opened it (Escape closes it, Modify stays), and its Save is Done's
            ...(!ctx.draft || vm.saveAs.open ? { saveAs: {
              state: vm.saveAs,
              toggle: () => { vm.saveAs.open = !vm.saveAs.open; vm.saveAs.saved = false; vm.saveAs.error = null;
                if (vm.saveAs.open) wantField = { key: "saveas-name", start: null, end: null };
                paint();
              },
              save: ctx.draft ? draftDone : () => void act(() => vm.saveVaultAs(createVault)),
              ...(ctx.draft ? { held: false } : {}),
            } } : {}),
          } : {}),
        }));
      }
      if (!modify) parts.push(trace);
    }
    root.dataset.bareView = view;
    // Modify's panes draw a settled tick grey and a staged one accent (runes-bare.css `.is-modifying`)
    root.classList.toggle("is-modifying", modify);
    libraryRoot.classList.toggle("is-modifying", modify);
    const kept = captureField(root) ?? captureField(libraryRoot) ?? wantField;
    wantField = null;
    paintLibrary();
    root.replaceChildren(...parts);
    restoreField(root, kept);
    restoreField(libraryRoot, kept);
    modeButton.hidden = view !== "actives" || !vault || !vm.now;
    modeButton.disabled = busy;
    // no aria-pressed: the label already says Modify or Done, and `.ws-btn[aria-pressed="true"]` (settings-modal.css)
    // painted Done with the accent edge and text for the whole of Modify, a lit look that read as a stuck hover
    modeButton.replaceChildren(iconImg(modify ? "check-circle" : "document-edit"), el("span", "", modify ? "Done" : "Modify"));
    modeButton.title = modify ? NOTE_VAULT : NOTE_MODIFY;
    // Cancel sits beside Done while Modify is open; it waits while Done (or any write) runs
    cancel.hidden = modeButton.hidden || !modify;
    cancel.disabled = busy;
    paintLock(lock, view === "actives" && vault ? !!vault.view.vault.lockedUtc : null, busy);
    // Lock is a write outside Modify only: in Modify the head holds Done and Cancel
    if (modify) lock.hidden = true;
    if (view === "actives") gate.atActives();
    if (loaded && !readyFired) { readyFired = true; ctx.onReady?.(); }
  }
  paint();
  const first = act(readVault);
  if (startView(ctx.start) === "files") void first.then(openFiles);
  // a draft has no read view of its own: it opens in Modify once its base has been read
  else if (ctx.draft) void first.then(() => { if (!disposed && vault && vm.now) { openModify(); paint(); } });
  return {
    root, modeButton, lockButton: lock, cancelButton: cancel, libraryRoot,
    setLoads(l) { loadsNow = l; },
    setTrust(parts) { trace.replaceChildren(...parts); trace.hidden = !parts.length; paint(); },
    reload() { if (!busy && view === "actives") void act(readVault); },
    dispose() { if (modify && !disposed) ctx.onModifyChange?.(false); disposed = true; if (retryTimer) clearTimeout(retryTimer); agentV.dispose(); unwatch(); root.remove(); modeButton.remove(); lock.remove(); cancel.remove(); libraryRoot.remove(); },
  };
}
