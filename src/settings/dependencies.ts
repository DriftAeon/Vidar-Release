// The Dependencies page: it opens as its own page tab in the session strip. This file
// mounts it into any root (one change subscriber per mount, removed on dispose), opens the tab, keeps
// one Settings row that opens it, and runs the launch-time open. The DOM is dependencies-view.ts;
// the report cache is deps/state.ts.
import { copyText } from "../clipboard";
import { CATALOG, depsError, depsReport, isDetecting, loadDeps, missingRequired, onDepsChange, shownDeps } from "../deps/state";
import { setupAgentBlocker, startSetupAgent } from "../deps/setup-agent";
import { iconImg } from "../icon-img";
import { lucide } from "../icons";
import { invoke } from "../ipc";
import { getPref, setPref } from "../prefs";
import { knownUpdates, onKnownUpdates, requestUpdate } from "../startup-updates/known";
import type { DepEntry } from "../deps/types";
import { brokenModules, loadModules, moduleListed, moduleViews, onModulesChange } from "../modules/registry";
import { renderDependencies, usedByLabels, type ModuleProblem } from "./dependencies-view";
// The pack Trust Current confirm reuses the Voice Slots box (.vs-confirm), whose rule lives there.
import "../styles/voice-slots.css";
import { asideForPage, backOnPageClose } from "../onboarding/aside";
import { closeShortcutsModal } from "./modal";
import { addSettingRow, registerCategory } from "./registry";

const DEPENDENCIES_CATEGORY = "dependencies";
const PAGE_ID = "dependencies";

/** shownDeps with each `usedBy` cut to the features the running set ships (moduleListed): a
 *  codex-set build's Node row names no Claude tab. */
function shippedDeps(): DepEntry[] {
  return shownDeps().map((d) => ({ ...d, usedBy: usedByLabels(d, moduleListed) }));
}

/** Setup stays disabled while a detection runs, whatever the setup agent's own blocker says. */
function setupBlocker(): string | null {
  return setupAgentBlocker() ?? (isDetecting() ? "Checking…" : null);
}

/** Rejected pack folders and inactive modules, as error rows. */
function moduleProblems(): ModuleProblem[] {
  return [
    ...brokenModules().map((b) => ({ name: b.folder, reason: b.reason, folder: b.folder })),
    ...moduleViews().filter((v) => !v.active && v.reason).map((v) => ({ name: v.row.label, reason: v.reason! })),
  ];
}

/** Paints the page into `root` now and repaints it on every deps change until the returned
 *  dispose runs. Each call owns its own container and action-error line, so several roots can be
 *  mounted at once. Paints before `root` is attached (no isConnected check). */
export function mountDependencies(root: HTMLElement): () => void {
  const page = root.ownerDocument.createElement("div");
  page.className = "deps-page";
  root.appendChild(page);
  let actionError = "";
  // Async actions (setup, copy, open) settle after a dispose too; their setError must not paint.
  let disposed = false;
  // Pack Trust Current: the folder awaiting confirm, and the one being re-pinned.
  let confirming: string | null = null;
  let trusting: string | null = null;
  // Check for Updates: running flag and the last result line.
  let checking = false;
  let checkNote = "";

  const setError = (msg: string): void => {
    actionError = msg;
    paint();
  };

  function paint(): void {
    if (disposed) return;
    // A release build lists no missing dep that ships inside Vidar (deps/state.ts shownDeps).
    renderDependencies(page, { ...CATALOG, deps: shippedDeps() }, depsReport(), depsError(), setupBlocker(), {
      recheck: () => {
        void loadDeps();
        // loadDeps set inFlight synchronously, so this repaint disables Setup until it settles.
        paint();
      },
      setup: () => {
        void startSetupAgent().then(() => setError(""), (e) => setError(`Setup Not Started: ${String(e)}`));
      },
      copy: (text) => {
        void copyText(text).then((ok) => setError(ok ? "" : "Copy Failed: Clipboard Refused"));
      },
      openUrl: (url) => {
        invoke("open_url", { url }).then(() => setError(""), (e) => setError(`Can't Open Link: ${String(e)}`));
      },
      openVoiceSlots: () => {
        // Lazy: the voice-slots module pulls its own IPC and view only when the link is used.
        void import("./voice-slots")
          .then((m) => m.openVoiceSlotsTab())
          .then(() => setError(""), (e) => setError(`Can't Open Voice Slots: ${String(e)}`));
      },
      checkUpdates: () => {
        if (checking) return;
        checking = true;
        checkNote = "";
        paint();
        // Lazy: the startup-updates card pulls sessions and toasts, needed only when the check runs.
        void import("../startup-updates")
          .then((m) => m.checkUpdatesNow())
          .then(
            (n) => { checkNote = n === 0 ? "All CLIs Up to Date" : ""; },
            (e) => { checkNote = `Check Failed: ${e instanceof Error ? e.message : String(e)}`; },
          )
          .then(() => { checking = false; paint(); });
      },
      updateCli: (u, skip) => {
        const why = requestUpdate(u, skip);
        setError(why ?? "");
      },
      askTrust: (folder) => {
        confirming = folder;
        paint();
      },
      cancelTrust: () => {
        confirming = null;
        paint();
      },
      trust: (folder) => {
        if (trusting) return;
        trusting = folder;
        actionError = "";
        paint();
        // On success the registry reloads through loadModules, so gateway rows and the launcher
        // update without a restart; onModulesChange repaints this page.
        invoke("module_trust_current", { folder }).then(
          () => {
            trusting = null;
            confirming = null;
            return loadModules().then(() => setError(""));
          },
          (e) => { trusting = null; setError(`Trust Failed: ${String(e)}`); },
        );
      },
    }, moduleProblems(), { confirming, trusting }, lucide, iconImg, { checking, note: checkNote }, knownUpdates());
    if (actionError) {
      const line = page.ownerDocument.createElement("div");
      line.className = "deps-error";
      line.textContent = actionError;
      page.insertBefore(line, page.children[1] ?? null);
    }
  }

  paint();
  const unsubscribe = onDepsChange(paint);
  const unsubscribeModules = onModulesChange(paint);
  const unsubscribeUpdates = onKnownUpdates(paint);
  return () => {
    disposed = true;
    unsubscribeUpdates();
    unsubscribe();
    unsubscribeModules();
    page.remove();
  };
}

/** Opens the Dependencies page tab, or activates it when it is already open; resolves its tab id.
 *  sessions is imported here so the settings bundle and tests never load xterm eagerly. */
async function openDependenciesTab(): Promise<string> {
  const { openPageTab } = await import("../panels/sessions");
  const id = await openPageTab({ id: PAGE_ID, title: "Dependencies", mount: backOnPageClose(mountDependencies) });
  asideForPage(); // onboarding overlay up: it steps aside until this tab closes
  return id;
}

let registered = false;

/** Adds the Dependencies category once, with one row whose button opens the page tab. */
export function registerDependencyRows(): void {
  if (registered) return;
  registered = true;
  registerCategory(DEPENDENCIES_CATEGORY, "Dependencies");
  addSettingRow({
    name: "Dependencies",
    category: DEPENDENCIES_CATEGORY,
    keywords: () => shippedDeps().map((d) => `${d.label} ${d.usedBy.join(" ")}`).join(" "),
    control: () => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ws-btn deps-open-page";
      b.textContent = "Open Dependencies";
      b.addEventListener("click", () => {
        // Close first: the modal's close refocuses the previously active tab, which would
        // otherwise pull focus back off the page tab.
        closeShortcutsModal();
        // the modal is closed by now, so a row error line would never be seen
        openDependenciesTab().catch((e) => console.error("Can't Open Dependencies:", e));
      });
      return b;
    },
  });
}

/** The launch rule for "a required dependency is missing", shared with onboarding's entry table. */
export function requiredMissing(): boolean {
  return missingRequired().length > 0;
}

/** After sessions are up: open the page tab on first launch, or whenever a required dependency
 *  is missing. A failed detection (null) opens nothing and leaves the pref unset. */
export async function maybeShowDependenciesAtLaunch(): Promise<void> {
  const report = depsReport() ?? (await loadDeps());
  if (!report) return;
  if (getPref("onboarding.dependenciesSeen") !== true || requiredMissing()) {
    await openDependenciesTab();
  }
  setPref("onboarding.dependenciesSeen", true);
}
