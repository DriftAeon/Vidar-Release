import { activate, createSession, getActiveSessionId, initSessions, openFalconSessionIds, openRenderedSessionIds, setTerminalTheme, toggleWorkbench } from "./panels/sessions";
import { codexSaveGate } from "./panels/sessions/codex-save";
import { beginTabOrderRestore, endTabOrderRestore } from "./panels/sessions/tab-order";
import { initTabState } from "./panels/sessions/tab-state-feeds";
import { invoke } from "./ipc";
import { readoptHostedSessions } from "./launcher/readopt";
import { restoreCodexTabs } from "./launcher/codex-restore";
import { initDrive } from "./drive/drive";
import "./control/listen";
import { initAskGate } from "./control/open-ask";
import { loadConfig, onSettingsChanged } from "./config";
import { overlayAgents } from "./config-agents";
import { setLauncherLead } from "./launcher/body-order";
import { builtinAgents, setGatewayModules, spawnFrom, spawnAstra, rosterView, shownRoots, shownVariants } from "./launcher/roster";
import { createFixOpener } from "./launcher/fix-tab";
import { setFixOpener } from "./panels/rendered/fix-seam";
import { showSessionsToast } from "./panels/sessions/zoom";
import { gatewayKey, gatewayModules } from "./launcher/gateways";
import { initLauncherMenu, launcherMenu, launcherSub, buildTypeMenu, openLauncher } from "./launcher/menu";
import { launcherCols, col } from "./launcher/columns";
import { adoptHosted } from "./launcher/hosted";
import { hostedNames } from "./launcher/hosted-names-pref";
import { initLauncherKeyboard, openLauncherByKeyboard } from "./launcher/keyboard";
import { openLocations } from "./launcher/locations";
import { initRecent } from "./launcher/recent";
import { reopenHere, reopenInWorkspace, reopenInWorktree } from "./launcher/reopen-workspace";
import { bindReopenInWorkspace } from "./panels/sessions/rendered-body";
import { GENERAL_CATEGORY, registerGeneralRows } from "./settings/general";
import { registerWorkspaceRows } from "./settings/workspaces";
import { registerCharacterRows } from "./settings/characters";
import { registerCardRows } from "./settings/cards";
import { registerFlowRows } from "./settings/flow";
import { registerDependencyRows } from "./settings/dependencies";
import { startOnboarding } from "./onboarding/start";
import { startStartupUpdates } from "./startup-updates";
import { registerAgentRows } from "./settings/agents";
import { registerVoiceSlotRows } from "./settings/voice-slots";
import { registerModuleRows } from "./settings/modules";
import "./settings/modules.css";
import { loadDeps } from "./deps/state";
import { onInspectEnter } from "./panels/inspect";
import { mountPanels } from "./panels/index";
import { mountCapabilities } from "./capabilities/registry";
import { loadModules, moduleOn, onModulesChange } from "./modules/registry";
import { setModuleNames } from "./modules/names";
import { effectivePrimary } from "./agents/primary";
import { initToolbench, setActiveCanvas, type Canvas } from "./panels/toolbench";
import { createToolRegistry } from "./tools/registry";
import { initMacros, BUILTIN_MACROS } from "./panels/macros";
import { initShortcuts, openShortcutsModal, closeShortcutsModal } from "./shortcuts";
import {
  initTheme,
  onThemeChange,
  syncCaption,
} from "./theme";
import { initCasDial } from "./cas-dial";
import { initCaption } from "./caption";
import { getPref, initPrefs, onPrefsError } from "./prefs";
import { initFlowStorage } from "./flow/file-storage";

import { setBanner, clearBanner } from "./config-banners";

// UI state (vidar-state.json) must be in the prefs cache before anything below reads it:
// theme, rightbar width, split, zoom, panel orders all read synchronously at init.
// Flow's file store (state\flow\) the same way: its accessors throw until it is hydrated.
await Promise.all([initPrefs(), initFlowStorage()]);
performance.mark("vidar:prefs");
// Dependency detection starts before the launcher menu is built; the menu and the
// launch-time Dependencies page share this in-flight promise.
void loadDeps();
// Review finding 6: persistence failures were console-only. No keys = the file could not be
// read at boot (replayed on subscribe); keys = a refused write. Neither is retried. One alert
// line, replaced per failure kind rather than appended per flush; pref keys stay in the log.
onPrefsError((keys) => {
  setBanner("prefs-error", keys.length
    ? "UI State Not Saved: some UI changes could not be written to vidar-state.json. Check the file, then restart Vidar."
    : "UI State Not Saved: vidar-state.json could not be read, so changes last until restart. Fix or remove the file, then restart Vidar.");
});

// One rail view: sessions. The type stays so the view plumbing reads the
// same if a second rail view ever comes back.
type ViewName = "sessions";

// AgentType / Location / VidarConfig live in config.ts, the one owner of
// vidar.json on the TS side.

// Which surface a tool can act on while each view is up. The tray (workbench)
// lives inside the sessions view and is an input of its own. Every shipped
// tool declares canvas "none", so no display surface needs a canvas of its own.
const VIEW_CANVAS: Record<ViewName, Canvas> = {
  sessions: "terminal",
};

const views: Record<ViewName, HTMLElement> = {
  sessions: document.getElementById("view-sessions")!,
};

function setViewClasses(name: ViewName) {
  for (const [n, el] of Object.entries(views)) {
    el.classList.toggle("active", n === name);
  }
  setActiveCanvas(VIEW_CANVAS[name]);
}

/* ---- theme + dial (synchronous, pre-paint state already set by head script) ---- */

initTheme();
syncCaption();
initCaption();
onThemeChange(() => setTerminalTheme());

initCasDial();

/* ---- static panels ---- */

// Registry in panels/index.ts: status, inspect, close lock, swap, rightbar grip, the rack/loadout
// modules half (independent of config, so it loads in parallel with it). Character is
// a capability, mounted by mountCapabilities below.
const disposePanels = mountPanels();
window.addEventListener("pagehide", disposePanels, { once: true });
if (import.meta.hot) import.meta.hot.dispose(disposePanels);
initAskGate({ adoptHosted, spawnAstra });
setViewClasses("sessions");

/* ---- launcher menu ---- */

initLauncherMenu({ openLocations });
initRecent();
bindReopenInWorkspace(reopenInWorkspace, reopenHere, reopenInWorktree);
initLauncherKeyboard({ launcherMenu, launcherSub, launcherCols, col, openLauncher });

/* ---- settings ---- */

// The button opens the settings modal straight on General; the modal's own rail and search
// reach every other page (no Shortcuts/General menu in between).
const settingsBtn = document.getElementById("settings-btn")!;

// Registered before any open: the modal builds its category rail once, on first open.
registerGeneralRows();
registerWorkspaceRows();
registerCharacterRows();
registerDependencyRows();
startStartupUpdates();
registerCardRows();
registerFlowRows();
registerAgentRows();
registerVoiceSlotRows();
registerModuleRows();
// Inspect mode suppresses clicks, which would leave the modal's backdrop
// un-closable — shut it on the way in, like the launcher menu.
onInspectEnter(closeShortcutsModal);

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  openShortcutsModal(GENERAL_CATEGORY);
});

// window.__vidarDrive, extracted into src\drive\drive.ts:
// spawnFrom/rosterView are src\launcher\roster.ts exports the drive
// module needs, injected once here; rosterView is read per call, after the config lands.
initDrive({ spawnFrom, roster: rosterView });
setGatewayModules(gatewayModules);
// Ask Agent to Fix on a Rendered notice card opens its fix tab through this opener (launcher/fix-tab.ts).
setFixOpener(createFixOpener({ roots: shownRoots, variants: shownVariants, spawn: spawnFrom, toast: showSessionsToast }));

/* ---- config-gated init: config MUST land before the first session spawns
   (agents, fontSize, defaultCwd, rider gating) ---- */

void (async () => {
  // loadConfig never rejects: an IPC failure arrives as `error`.
  // loadModules never rejects either: a failed modules_list falls back to the core modules plus the bundled Codex agent.
  const [{ config: cfg, error: cfgError, notice: cfgNotice }] = await Promise.all([loadConfig(), loadModules()]);
  performance.mark("vidar:config");
  // Capability gating: not awaited, so core UI never waits on dependency detection.
  const disposeCapabilities = mountCapabilities(cfg);
  window.addEventListener("pagehide", disposeCapabilities, { once: true });
  if (import.meta.hot) import.meta.hot.dispose(disposeCapabilities);
  const agentWarnings: string[] = [];
  setLauncherLead(cfg.launcherLead);
  setModuleNames(cfg.moduleNames);
  buildTypeMenu(overlayAgents(builtinAgents(), cfg.agents, agentWarnings), cfg.locations ?? []);
  for (const w of agentWarnings) console.warn(w);
  // Gateway rows follow the module set: rebuild when a gateway module appears or goes.
  let gatewaysSeen = gatewayKey();
  let primarySeen = effectivePrimary();
  onModulesChange(() => {
    const now = gatewayKey();
    const primary = effectivePrimary();
    if (now === gatewaysSeen && primary === primarySeen) return;
    gatewaysSeen = now;
    primarySeen = primary;
    void loadConfig().then(({ config: c }) => buildTypeMenu(overlayAgents(builtinAgents(), c.agents), c.locations ?? []));
  });
  // Toolbench init is config-gated: log roots are the tool's only authority to
  // read anything, so it must not mount before they land.
  void initToolbench(
    document.getElementById("tool-grid")!,
    document.getElementById("tool-options")!,
    createToolRegistry(moduleOn),
  );
  initMacros(
    document.getElementById("macro-strip")!,
    cfg.macros?.length ? cfg.macros : BUILTIN_MACROS,
  );
  // Live apply: Settings › Agents writes through patch_settings; the launcher and the macro
  // strip rebuild from the fresh file without a restart. initMacros clears the strip itself.
  onSettingsChanged(({ keys }) => {
    if (!keys.includes("agents") && !keys.includes("macros")) return;
    void loadConfig().then(({ config: c }) => {
      if (keys.includes("agents")) {
        const w: string[] = [];
        buildTypeMenu(overlayAgents(builtinAgents(), c.agents, w), c.locations ?? []);
        for (const m of w) console.warn(m);
        // The notice follows the live overlay: fixing the entry in Settings clears it.
        if (!cfgError) {
          const notice = [cfgNotice, ...w].filter(Boolean).join(" ");
          if (notice) setBanner("config-notice", notice);
          else clearBanner("config-notice");
        }
      }
      if (keys.includes("macros")) {
        initMacros(document.getElementById("macro-strip")!, c.macros?.length ? c.macros : BUILTIN_MACROS);
      }
    });
  });
  initShortcuts(
    [{
      id: "new-tab",
      name: "New Tab",
      defaultKeys: "Ctrl+T",
      run: openLauncherByKeyboard,
    }, {
      id: "toggle-workbench",
      name: "Toggle Workbench",
      defaultKeys: "Ctrl+\\",
      run: toggleWorkbench,
    }],
    cfg.shortcuts ?? {},
  );
  if (cfgError) {
    setBanner("config-error", cfgError);
  } else if (cfgNotice || agentWarnings.length) {
    // A real (non-no-op) settings migration ran, or an agents entry could not be
    // applied (a `disabled` that matches no row) — informational, not a
    // problem, so it gets the neutral sibling of #config-error rather than
    // the alert styling.
    setBanner("config-notice", [cfgNotice, ...agentWarnings].filter(Boolean).join(" "));
  }
  await initSessions(views.sessions, document.getElementById("session-strip")!, () =>
    setViewClasses("sessions"), {
    // Same rule as editor.rs::resolve: `editor.exe` wins, legacy `riderPath` is the fallback.
    riderEnabled: !!(cfg.editor?.exe?.trim() || cfg.riderPath?.trim()),
    fontSize: cfg.fontSize,
  });
  performance.mark("vidar:sessions");
  initTabState();
  // After sessions: the onboarding entry table runs the overlay, or falls back to the Dependencies tab (onboarding/start.ts).
  void startOnboarding().catch((e) => console.error(e));
  // Hosted Claude tabs a swap or a webview reload left behind come back on their own
  // (launcher/readopt.ts), in the background so they never take focus; with no tab selected,
  // the first one is. A reload's views are this process's own, so they come back in every
  // build; a previous Vidar's only outside a dev build, which must never pull the release
  // instance's sessions.
  beginTabOrderRestore();
  const readopt = readoptHostedSessions({
    available: () => invoke("falcon_available"),
    list: () => invoke("falcon_list").then((p) => { hostedNames.prune(p.sessions.map((x) => x.session)); return p; }),
    openIds: openFalconSessionIds,
    held: () => invoke("falcon_hosted_held"),
    detach: (tab, gen) => invoke("falcon_detach", { id: tab, gen }),
    relaunch: !import.meta.env.DEV,
    adopt: (s) => adoptHosted(s, undefined, { background: true, restoreSlot: true }),
    activeId: getActiveSessionId,
    select: activate,
  });
  // Codex has no host: a swap ended its agents, so the saved tabs reopen as resumed threads
  // (launcher/codex-restore.ts). Never in a dev build, which must not touch the release list.
  const codexRestore = !import.meta.env.DEV
    ? restoreCodexTabs({
      records: (getPref("rendered.codexTabs") ?? []).map((rec) => ({ ...rec, tabKey: rec.tabKey ?? crypto.randomUUID() })),
      reap: () => invoke("agent_reap_all"),
      openThreadIds: openRenderedSessionIds,
      open: (rec) => createSession({
        agent: "codex", body: "rendered", cwd: rec.cwd, model: rec.model ?? undefined,
        permissionMode: rec.mode, rules: rec.rules ? { file: rec.rules, codex: null, warnings: [] } : undefined,
        resume: rec.threadId ?? undefined, title: rec.title, art: rec.art, background: true,
        tabKey: rec.tabKey, restoreSlot: true,
        ...(rec.profile ? { profile: rec.profile, ...(rec.rowKey ? { rowKey: rec.rowKey } : {}) } : {}),
      }),
      // A Bare tab whose row was deleted or renamed stays saved and unopened, with a note.
      resolves: (rec) => shownRoots().flatMap((r) => [r, ...shownVariants(r)])
        .some((x) => x.profile === rec.profile && x.id === "codex" && x.body === "rendered" && (!rec.rowKey || x.key === rec.rowKey)),
      stale: (recs) => setBanner("codex-restore-notice", `${recs.length === 1 ? "A Bare Codex Tab" : `${recs.length} Bare Codex Tabs`} Not Restored: Launcher Row Missing (${recs.map((r) => r.title).join(", ")})`),
      activeId: getActiveSessionId,
      select: activate,
      gate: codexSaveGate,
    }) : Promise.resolve();
  void Promise.allSettled([readopt, codexRestore]).then(() => { performance.mark("vidar:restored"); endTabOrderRestore(); });
})();
