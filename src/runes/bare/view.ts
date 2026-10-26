// Runes View and Modify show the focused session's Rune Vault.
import { iconImg } from "../../icon-img";
import { fillCard, type CardCtx } from "../cards";
import { createBareFlow, agentFiles, codexTicks, defaultTicks, watchGenerating,
  type ActionResult, type BareFlowIo, type BareLocalFile, type BareLocalSources, type BareModuleBundles } from "./flow";
import { invoke, type VaultOp } from "../../ipc";
import { type SessionVault, type VaultIo, type VaultViewRune } from "./cake";
import { createAgentView, el, btn, type GenCtx } from "./agent-view";
import { filesView, generatable } from "./view-files";
import { addKit } from "./kit-add";
import { vaultModify } from "./view-vault";
import { vaultModifyState } from "./vault-modify-state";
import { lockButton, paintLock } from "./view-sets";
import { errorLine } from "./view-data";
import { doneGate, startView } from "./view-entry";
import { nameAndPath, isFileRow } from "./row-name";
import { mcpTickRow } from "./module-ticks";
import { moduleTicks } from "./module-ticks";
import { setAttachments } from "./set-attach";
import type { VaultEditIo } from "./vault-edit";

export { errorLine, hueOf } from "./view-data";
export { genLabel } from "./gen-label";

export interface BareViewCtx {
  agent: string; cwd: string; profile: string; traceParts?: HTMLElement[]; card?: CardCtx;
  gen?: () => GenCtx; modelsReady?: Promise<unknown>;
  start?: "files"; onDone?(): void;
  vault?: VaultIo; vaultEdit?: VaultEditIo;
  /** Waits before each re-read of an absent session record (tests shorten it). */
  retryMs?: number[];
  warningLine?: (warning: string) => HTMLElement | null;
}
export interface BareViewHandle {
  root: HTMLElement; modeButton: HTMLButtonElement; lockButton: HTMLButtonElement;
  setTrace(parts: HTMLElement[]): void; reload(): void; dispose(): void;
}
const LAYER_KINDS = [
  ["skill", "Skills", "skill"], ["agent", "Agents", "agent"], ["hook", "Hooks", "hook"], ["mcp", "MCP Servers", "proxy"],
] as const;
const NOTE_VAULT = "Changes this tab's vault; before the vault locks, the tab restarts as a fresh session.";
const NO_VAULT = "No Vault Session";
const RETRY_MS = [250, 500, 1000, 2000, 1250];

export function mountBareView(host: HTMLElement, ctx: BareViewCtx, io: BareFlowIo): BareViewHandle {
  const codex = ctx.agent === "codex";
  const root = el("div", "runes-bare");
  host.appendChild(root);
  const trace = el("div", "runes-bare-trace");
  trace.replaceChildren(...(ctx.traceParts ?? []));
  trace.hidden = !trace.childElementCount;
  const modeButton = el("button", "ws-btn runes-mode");
  modeButton.type = "button";
  const lock = lockButton();
  const vm = vaultModifyState(ctx.vaultEdit);
  const flow = createBareFlow(io, { cwd: ctx.cwd, codex, session: ctx.vault?.session, read: ctx.vault?.read });
  const card = ctx.card ?? { openInDocument: () => {}, note: () => {} };
  let vault: SessionVault | null = null;
  let modify = false, busy = false, disposed = false, loaded = false;
  let view: "actives" | "files" | "agent" = "actives";
  let error: ActionResult | null = null;
  let sources: BareLocalSources | null = null, sourcesErr: string | null = null;
  let bundles: BareModuleBundles | null = null;
  let ticked = new Set<string>();
  let kitNotice: { attached: boolean; skipped: number } | null = null, kitError: string | null = null;
  const open = new Map<string, boolean>();
  const gate = doneGate(ctx.onDone);
  const trackOpen = (det: HTMLDetailsElement, key: string, dflt: boolean): void => {
    det.open = open.get(key) ?? dflt;
    fillCard(det);
    det.addEventListener("toggle", () => open.set(key, det.open));
  };
  const agentV = createAgentView({
    codex, flow, gen: ctx.gen, paint, enter: () => { view = "agent"; gate.ran(); },
    ...(ctx.vaultEdit ? { addToVault: async (r: Parameters<typeof vm.addGenerated>[0]) => {
      await vaultWrite(() => vm.addGenerated(r));
      if (vm.pending) modify = true;
      return !error && !vm.pending;
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
  const delays = ctx.retryMs ?? RETRY_MS;
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
      sources = { ...sources, files: agentFiles(sources.files, codex) };
      sourcesErr = null;
      if (io.moduleBundles) bundles = await io.moduleBundles();
    } catch (e) { sourcesErr = String(e); }
  }
  modeButton.addEventListener("click", () => {
    modify = !modify;
    if (!modify) vm.reset();
    else if (!sources) void act(loadCandidates);
    paint();
  });
  lock.addEventListener("click", () => {
    if (vault && ctx.vault) void vaultWrite(async () => { await ctx.vault!.lock(vault!.session.vault.id, vault!.session.vault.hash); });
  });
  function runAddKit(): void {
    if (!vm.now) return;
    void act(async () => {
      kitError = null;
      try {
        const r = await addKit(io, ctx.cwd, bundles);
        kitNotice = { attached: !r.created, skipped: r.skipped };
        modify = true; view = "actives";
        await vm.edit(r.ops);
        await readVault();
      } catch (e) { kitError = String(e); }
    });
  }
  function tickRow(f: BareLocalFile, on: boolean, flip: () => void, off: boolean): HTMLButtonElement {
    const b = btn(f.shown, "rp-source", flip, off || !f.pickable);
    b.dataset.path = f.path;
    b.setAttribute("aria-pressed", String(on));
    if (isFileRow(f)) { b.replaceChildren(...nameAndPath(f)); b.title = f.path; }
    else if (f.kind === "mcp") mcpTickRow(b, f, bundles, "");
    return b;
  }
  async function openFiles(): Promise<void> {
    await act(async () => {
      try {
        await loadCandidates();
        ticked = codex ? codexTicks(sources?.files ?? []) : defaultTicks(sources?.files ?? []);
      } catch (e) { sourcesErr = String(e); }
      view = "files";
    });
  }
  function paint(): void {
    if (disposed) return;
    const parts: HTMLElement[] = [];
    if (view === "files") parts.push(...filesView({
      codex, sources, sourcesErr, kitError, ticked, busy, canAddKit: !!vm.now,
      layerKinds: LAYER_KINDS.filter(([kind]) => !codex || kind !== "hook") as never,
      trackOpen, tickRow, error: (text) => el("div", "rp-error", text),
      generateButton: () => sources ? agentV.generateButton(sources, ticked, generatable(sources.files, ticked)) : null,
      selects: () => agentV.selects(), addKit: runAddKit, back: () => { view = "actives"; paint(); }, paint,
    }));
    else if (view === "agent") parts.push(...agentV.generatingView());
    else {
      if (error) {
        const e = errorLine(error, "load");
        if (e) { const d = el("div", "rp-error", e.text); d.title = e.title ?? ""; parts.push(d); }
      } else if (loaded && !vault) parts.push(el("div", "runes-bare-note", NO_VAULT));
      if (kitError) { const d = el("div", "rp-error", "Add Kit Failed"); d.title = kitError; parts.push(d); }
      const doneLine = agentV.doneLine();
      if (doneLine) parts.push(doneLine);
      if (vault) {
        const displayed = modify ? vm.now : vault.view;
        for (const warning of displayed?.warnings ?? []) {
          const line = ctx.warningLine ? ctx.warningLine(warning) : el("div", "runes-err", warning);
          if (line) parts.push(line);
        }
        const attach = (set: { library: string; set: string }, runes: VaultViewRune[]): HTMLElement[] => {
          const common = {
            io, set, runes, sources, bundles, codex, busy, trackOpen,
            edit: async (ops: VaultOp[]) => { await vm.edit(ops, vm.takenOut(ops)); await readVault(); },
            act: (fn: () => Promise<void>) => { void act(async () => {
              try { await fn(); }
              catch (e) { error = { ok: false, reason: "failed", error: String(e) }; }
            }); },
          };
          return [...setAttachments(common), ...moduleTicks(common)];
        };
        if (displayed) parts.push(...vaultModify({
          view: displayed, removed: modify ? vm.removed : [], pending: modify ? vm.pending : null,
          busy, readOnly: !modify, card, trackOpen, kitNotice: modify ? kitNotice : null,
          attachments: modify ? attach : undefined,
          edit: (ops: VaultOp[]) => void vaultWrite(() => vm.edit(ops, vm.takenOut(ops))),
          pick: async (p) => { await vm.pick(p); await act(readVault); },
          ...(modify ? {
            addKit: runAddKit, library: vm.library,
            addRune: () => void vaultWrite(() => vm.toggleLibrary(async () =>
              (await invoke("rune_vault_library_runes", { agent: ctx.agent })).runes as VaultViewRune[])),
          } : {}),
        }));
      }
      if (!modify) parts.push(trace);
      else parts.push(btn("Add Local Files", "ws-btn", () => void openFiles(), busy));
    }
    root.dataset.bareView = view;
    root.replaceChildren(...parts);
    modeButton.hidden = view !== "actives" || !vault || !vm.now;
    modeButton.disabled = busy;
    modeButton.classList.toggle("is-editing", modify);
    modeButton.setAttribute("aria-pressed", String(modify));
    modeButton.replaceChildren(iconImg(modify ? "check-circle" : "document-edit"), el("span", "", modify ? "Done" : "Modify"));
    modeButton.title = NOTE_VAULT;
    paintLock(lock, view === "actives" && vault ? !!vault.view.vault.lockedUtc : null, busy);
    if (view === "actives") gate.atActives();
  }
  paint();
  const first = act(readVault);
  if (startView(ctx.start) === "files") void first.then(openFiles);
  return {
    root, modeButton, lockButton: lock,
    setTrace(parts) { trace.replaceChildren(...parts); trace.hidden = !parts.length; paint(); },
    reload() { if (!busy && view === "actives") void act(readVault); },
    dispose() { disposed = true; if (retryTimer) clearTimeout(retryTimer); agentV.dispose(); unwatch(); root.remove(); modeButton.remove(); lock.remove(); },
  };
}
