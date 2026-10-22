// Status bar of a Rendered body: the statusline-shaped parts (dir, model, context, 5H/7D,
// effort), the permission-mode, model and effort pickers with their commit-on-ack setters.

import type { Effort, PermissionMode } from "../../agents/protocol";
import { codexEffort } from "../../agents/codex-settings";
import { AGENT_PROFILE } from "./agent-profile";
import { titleCase, prettyModel } from "../../format";
import { currentModelIndex, groupModels, menuLabel } from "./model-groups";
import { createCommandCabinet } from "./command-cabinet";
import { el } from "./dom";
import { effortSegments, type EffortGroup } from "./effort-segments";
import { statusPill, statusTag, statusValue } from "./status-control";
import { statusReadouts } from "./status-readouts";
import type { RenderedOpts } from "./opts";
import type { RenderedState, StatusLine } from "./state";
import type { LoginReach } from "./login";
import { NOT_LOGGED_IN } from "./state-chip";

export const modeLabel = (m: string, agent?: string) => m === "auto" && agent === "codex" ? "Auto Review" :
  ({ default: "Default", acceptEdits: "Accept Edits", plan: "Plan", auto: "Auto" } as Record<string, string>)[m] ?? m;

/** What the status bar closes over in createRenderedBody. */
export interface StatusBarDeps {
  opts: RenderedOpts;
  send: (line: string) => Promise<boolean>;
  noticeBlock: (text: string, level: "info" | "warn" | "error", quiet?: boolean) => void;
  refreshState: () => void;
  emitCharacterStatus: (fresh: boolean) => void;
  /** the composer, which the command cabinet (Claude only) fills on a pick */
  textarea: HTMLTextAreaElement;
  openStMenu: (anchor: HTMLElement, items: { label: string; value: string; current?: boolean }[], onPick: (value: string) => void) => void;
  /** the logins the model pill offers while the tab is logged out (rendered.ts): Codex's menu, or
   *  Claude's card (claude-login.ts), which sets `offered` (no adapter login) and `open` (the pill's press) */
  login?: {
    chatgpt: () => void; apiKey: () => void; ready: () => boolean; offer?: () => void; settle?: () => void; fail?: (text: string) => boolean; url?: (url: string) => void;
    offered?: () => boolean; reach?: () => LoginReach; open?: () => void; dispose?: () => void;
  };
}

export function createStatusBar(S: RenderedState, deps: StatusBarDeps) {
  const { opts, send, noticeBlock, refreshState, emitCharacterStatus, openStMenu, textarea } = deps;
  // the command cabinet button sits right of the effort segments (Claude only)
  const cabinet = opts.agent === "claude" ? createCommandCabinet(S, { textarea }) : null;
  // Status bar: dir, model pill, effort segments, then Con / 5H / 7D readouts as chunk bars
  // (status-readouts.ts), same colour thresholds as Claude Code's own statusline
  // (the user's statusline-command.ps1). Headless Claude never runs the
  // statusline hook, so the numbers come from the stream: result.modelUsage
  // for the context window, rate_limit_event for the account windows.
  const profile = AGENT_PROFILE[opts.agent];
  const slParts = el("span", "sl-parts");
  // the permission mode sits at the right, just left of the state dot: the two
  // read as one "how the agent is running" cell
  const modeSlot = el("span", "sl-mode-slot");
  const sl: StatusLine = {
    dir: titleCase(opts.cwd.split(/[\\/]/).filter(Boolean).pop() ?? opts.cwd),
    model: "Starting…",
    mode: "",
    ctxPct: null as number | null,
    ctxTokens: 0,
    contextWindow: null as number | null,
    limits: new Map<string, { pct: number; resetsAt: number | null }>(),
    /** Claude's reported effort, or Codex's selection for the next turn. */
    effort: "",
  };
  // Permission mode as a control. `mode` is the last CONFIRMED value: a
  // click shows the target dimmed and only the agent's ack commits it (a
  // pipe write is not an applied policy). Codex applies locally
  // for its next turn (encoder returns null) — that counts as confirmed.
  // Cycle per agent: Codex also offers its app-server Auto Review policy.
  const MODE_CYCLE: readonly PermissionMode[] = AGENT_PROFILE[opts.agent].permissionModes;
  // Claude takes a mode change mid-turn (the CLI's Shift+Tab path; it applies from the next tool
  // call), so only an open permission card blocks it there (2026-10-06: accept-edits locked
  // the button through a long tool run). Codex applies per turn, so it keeps the whole-turn block.
  const modeBtnBlocked = () => !S.isAlive || (S.inTurn && opts.agent !== "claude") || !!S.pendingApproval || S.switchPending || sl.model === "Starting…";
  function settleSwitch(confirmed: PermissionMode | null) {
    if (S.switchTimer !== undefined) { clearTimeout(S.switchTimer); S.switchTimer = undefined; }
    S.switchPending = false;
    if (confirmed) S.mode = confirmed;
    sl.mode = modeLabel(S.mode, opts.agent);
    redrawStatus();
    if (confirmed && !S.hydrating) opts.onModeChange?.();
  }
  function pickModeMenu() {
    if (modeBtnBlocked() || !S.modeBtn) return;
    openStMenu(S.modeBtn, MODE_CYCLE.map((m) => ({ label: modeLabel(m, opts.agent), value: m, current: m === S.mode })), (v) => setMode(v as PermissionMode));
  }
  function setMode(next: PermissionMode) {
    if (modeBtnBlocked() || next === S.mode) return;
    const line = S.adapter.encodeSetPermissionMode(next);
    if (line === null) { settleSwitch(next); return; }
    S.switchPending = true;
    sl.mode = modeLabel(next, opts.agent);
    redrawStatus();
    // a Codex setter line goes to the host, which answers Applied or Failed: send() true is that
    // Applied (Claude settles on its own ack event instead)
    void send(line).then((ok) => {
      if (!S.switchPending) return;
      if (!ok) settleSwitch(null);
      else if (opts.agent === "codex") settleSwitch(next);
    });
    S.switchTimer = window.setTimeout(() => {
      if (!S.switchPending) return;
      settleSwitch(null);
      noticeBlock(`Mode change to ${modeLabel(next, opts.agent)} was not acknowledged`, "warn");
    }, 10_000);
  }
  /* -- Claude commits on ack; Codex stages an override for the next turn.
        Each agent supplies its own model catalog. -- */
  const modelBtnBlocked = () => !S.isAlive || !S.models.length || S.inTurn || !!S.pendingApproval || S.modelPending !== null || sl.model === "Starting…";
  function settleModel(confirmed: string | null) {
    if (S.modelTimer !== undefined) { clearTimeout(S.modelTimer); S.modelTimer = undefined; }
    const shownBefore = S.modelPending;
    S.modelPending = null;
    const want = S.modelWant;
    S.modelWant = null;
    if (confirmed) {
      if (shownBefore !== null) S.pickedModel = want; // the menu value, not the CLI's resolved id; a replayed change has no pick
      sl.model = prettyModel(confirmed);
      S.modelHinted = false;
      S.characterModel = confirmed;
      S.characterModelLive = true;
      if (!S.hydrating) emitCharacterStatus(true);
      // the new model may not offer the level showing: Codex clamps to the nearest it does
      if (opts.agent === "codex" && !S.hydrating && sl.effort) {
        const clamped = codexEffort(sl.effort as Effort, effortLevels());
        if (clamped && clamped !== sl.effort) { redrawStatus(); setEffort(sl.effort as Effort); return; }
      }
    }
    else if (shownBefore !== null) sl.model = prettyModel(shownBefore); // revert to what was shown before the pick
    redrawStatus();
  }
  function setModel(want: string) {
    if (modelBtnBlocked()) return;
    const line = S.adapter.encodeSetModel(want);
    if (line === null && opts.agent !== "codex") return;
    S.modelWant = want;
    S.modelPending = sl.model; // remember the label to revert to (already pretty; prettyModel is idempotent enough)
    if (line === null) {
      settleModel(want);
      return;
    }
    sl.model = prettyModel(want);
    redrawStatus();
    void send(line).then((ok) => {
      if (S.modelPending === null) return;
      if (!ok) settleModel(null);
      else if (opts.agent === "codex") settleModel(want); // the host's Applied (Claude settles on its model_set ack)
    });
    S.modelTimer = window.setTimeout(() => {
      if (S.modelPending === null) return;
      settleModel(null);
      noticeBlock(`Model change to ${prettyModel(want)} was not acknowledged`, "warn");
    }, 10_000);
  }
  /** logged out with an agent that logs in itself (Codex) or a Claude tab that can run its login:
   *  the pill offers the login, not the models */
  const loginOffered = () => S.loggedOut && !!deps.login
    && (deps.login.offered ? deps.login.offered() : !!S.adapter.encodeLogin);
  function pickLoginMenu() {
    const login = deps.login;
    if (login?.open) { login.open(); return; } // Claude: one action, the card is the menu
    if (!S.modelBtn || !login?.ready()) return; // offered once the initialize reply has landed
    openStMenu(S.modelBtn, [
      { label: "Log In With ChatGPT", value: "chatgpt" },
      { label: "Log In With API Key", value: "apiKey" },
    ], (v) => (v === "chatgpt" ? login.chatgpt() : login.apiKey()));
  }
  function pickModelMenu() {
    if (loginOffered()) { pickLoginMenu(); return; }
    if (modelBtnBlocked() || !S.modelBtn) return;
    // the menu offers aliases ("opus[1m]") while the status line carries the resolved id's
    // pretty name ("Opus 5"), so the two never matched and nothing was ever marked.
    // `resolved` is the CLI's own answer to which row covers which id.
    // More than one row can resolve to the running model — "Default" and the explicit row
    // both do when the default IS that model — and two ticks read as a
    // bug. First match wins, so an unswitched session marks Default.
    // Before the first turn the row of the model the tab will use is ticked (the hint, else what
    // Default resolves to); Default itself only once it is the confirmed pick.
    // Rows from a CLI too old to send `resolved` keep the name comparison.
    // Exactly one row: the menu value of the last confirmed pick (S.pickedModel; the CLI's ack
    // carries a resolved id, so S.characterModel cannot say which row was picked) wins, then an
    // explicit row resolving to the running id, Default only as the last resort.
    const rows = S.models.map((m) => ({
      label: m.label,
      value: m.value,
      resolved: m.resolved,
      nameMatch: prettyModel(m.value) === sl.model,
    }));
    const first = currentModelIndex(rows, S.characterModel, S.characterModelLive, S.pickedModel);
    const marked = rows.map((r, i) => ({ label: menuLabel(r.label), value: r.value, resolved: r.resolved, current: i === first }));
    const items = opts.agent === "codex" ? marked : groupModels(marked);
    openStMenu(S.modelBtn, items, setModel);
  }
  /* -- Session-scoped effort: Claude uses applyFlagSettings and reports its applied level;
        Codex stages turn/start.effort locally. Both survive Retry/Resume in the body. -- */
  let effortBtn: EffortGroup | null = null;
  let effortPending = false;
  const effortLevels = () => opts.agent === "codex"
    ? S.models.find((m) => m.value === S.characterModel)?.effortLevels ?? profile.effortLevels : profile.effortLevels;
  const effortBlocked = () => effortDead() || effortPending;
  // segments disable only when the agent cannot take a pick; a pick in flight leaves them enabled
  // (setEffort's effortBlocked() guard drops a second pick) so the row does not dim and focus stays put
  const effortDead = () => !S.isAlive || sl.model === "Starting…" || (opts.agent === "codex" && S.inTurn);
  function setEffort(level: Effort) {
    if (effortBlocked()) return;
    if (opts.agent === "codex") {
      const selected = codexEffort(level, effortLevels());
      if (!selected) return;
      level = selected;
    }
    const line = S.adapter.encodeSetEffort(level);
    if (line === null) {
      if (opts.agent !== "codex") return;
      sl.effort = level;
      S.liveEffort = level;
      opts.effort = level;
      redrawStatus();
      return;
    }
    effortPending = true;
    redrawStatus();
    void send(line).then((ok) => {
      effortPending = false;
      if (ok) {
        opts.effort = level;
        if (opts.agent === "codex") { sl.effort = level; S.liveEffort = level; } // the host's Applied
      }
      redrawStatus();
    });
  }
  function pickEffortMenu() {
    const anchor = effortBtn ?? S.modelBtn;
    if (effortBlocked() || !anchor) return;
    openStMenu(anchor, effortLevels().map((l) => ({ label: titleCase(l), value: l, current: l === sl.effort })), (v) => setEffort(v as Effort));
  }
  /* -- the model and mode pills: built once, re-marked in place by syncControls, so focus, hover
        and an open menu's aria-expanded survive every redraw -- */
  const modelPill = profile.modelMenu ? statusPill({ icon: "cpu", cls: "st-model sl-cyan", onPress: pickModelMenu }) : null;
  const modePill = statusPill({ cls: "st-mode", onPress: pickModeMenu });
  modePill.set({ title: "Change Mode" });
  S.modelBtn = modelPill?.el ?? null;
  const dirEl = el("span", "sl-dir sl-cyan", sl.dir);
  /** a pill's state: dead or starting = disabled (drops focus); a turn or card open = blocked
   *  (aria-disabled, keeps focus, full strength); a change in flight = pending (aria-busy, dimmed) */
  function pillMarks(pending: boolean) {
    const dead = !S.isAlive || sl.model === "Starting…";
    const blocked = dead ? false : S.pendingApproval ? "card" : S.inTurn ? "turn" : false;
    return { disabled: dead, blocked, pending };
  }
  /** the model pill stays pressable while it offers the login, even before a session opened */
  function modelMarks() {
    // Claude's login runs outside the session, so it needs no live process
    // Codex's menu opens only once the initialize reply has landed (pickLoginMenu): pending until then
    if (loginOffered()) return { disabled: !deps.login?.open && !S.isAlive, blocked: false as const, pending: !deps.login?.open && S.isAlive && !deps.login?.ready() };
    return { ...pillMarks(S.modelPending !== null), disabled: !S.models.length || !S.isAlive || sl.model === "Starting…" };
  }
  /** re-sync the controls' state without a rebuild (refreshState runs on exit, turn and card changes) */
  function syncControls() {
    modelPill?.set(modelMarks());
    modePill.set(pillMarks(S.switchPending));
    if (effortBtn) for (const b of effortBtn.querySelectorAll<HTMLButtonElement>(".eff-seg")) b.disabled = effortDead();
  }
  function redrawStatus() {
    // left to right: dir, model pill, effort, then the readouts pushed right (Con, 5H, 7D)
    const parts: HTMLElement[] = [];
    if (dirEl.textContent !== sl.dir) dirEl.textContent = sl.dir;
    parts.push(dirEl);
    // Both agents reuse the model pill; their setters apply through their own protocol.
    const modelSummary = `${sl.model}${sl.mode ? ` · ${sl.mode}` : ""}`;
    // logged out, the pill says so in place of the model (sl.model keeps the model for the driver)
    const modelText = S.loggedOut ? NOT_LOGGED_IN : sl.model;
    const modelTitle = S.loggedOut ? profile.loginTip(deps.login?.reach?.() ?? "card") : profile.modelMenu
      ? S.models.length ? `Model (click to change) · ${modelSummary}` : `Model List Loading · ${modelSummary}`
      : modelSummary;
    if (modelPill) {
      modelPill.set({ text: modelText, title: modelTitle, ...modelMarks() });
      parts.push(modelPill.el);
    } else {
      parts.push(statusTag({ icon: "cpu", text: modelText, cls: "st-model sl-cyan", title: modelTitle }));
    }
    // the login card sits at the transcript end while logged out (before a first turn too) and folds
    // once the account state flips; the pill above keeps its text and menu
    if (loginOffered()) deps.login?.offer?.(); else deps.login?.settle?.();
    const levels = effortLevels();
    if (levels.length) {
      // built once, then re-marked in place: a pick moves the fill without redrawing the row
      const marks = { current: sl.effort, blocked: effortDead(), pending: effortPending };
      if (effortBtn && effortBtn.levels === levels) effortBtn.update(marks);
      else effortBtn = effortSegments({ levels, ...marks, onPick: setEffort });
      parts.push(effortBtn);
    } else if (sl.effort) {
      effortBtn = null;
      parts.push(statusValue(titleCase(sl.effort), "st-value sl-effort", `Effort: ${titleCase(sl.effort)}`));
    }
    if (cabinet) parts.push(cabinet.button);
    if (sl.mode) {
      modePill.set({ text: sl.mode, ...pillMarks(S.switchPending) });
      if (modePill.el.parentElement !== modeSlot) modeSlot.appendChild(modePill.el);
      S.modeBtn = modePill.el;
    } else {
      modePill.el.remove();
      S.modeBtn = null;
    }
    const rd = statusReadouts(sl);
    if (rd) parts.push(rd);
    // drop the stale children, then insert the new ones around the kept pills and effort group,
    // so those (and a focused control among them) are never detached
    for (const c of Array.from(slParts.children)) if (!parts.includes(c as HTMLElement)) c.remove();
    parts.forEach((p, i) => { if (slParts.children[i] !== p) slParts.insertBefore(p, slParts.children[i] ?? null); });
    refreshState();
  }
  return { login: deps.login, sl, slParts, modeSlot, settleSwitch, settleModel, setModel, pickModelMenu, setEffort, pickEffortMenu, redrawStatus, syncControls, modeBtnBlocked, modelBtnBlocked, closeCabinet: () => cabinet?.close() };
}
