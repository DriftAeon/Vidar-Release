// Settings › General › Close to Tray and Summon Shortcut: the two fields of the vidar.json `window`
// object, `{ closeToTray, summonHotkey }`. Each row saves the whole object through `patch_settings`;
// commands.rs validate_window (tray_config::parse_chord) is the authority and its refusal is shown on
// the row. Both are read once at start by `tray::install`, so both rows are restartRequired.
// The chord recorder mirrors modal.ts's (button, `recording` class, Escape cancels): that one is
// bound to the shortcut registry (rowRefs, commitChord), which this key is not part of.

import { invoke } from "../ipc";
import { loadConfig } from "../config";
import { chordOf } from "../shortcuts-core";
import { REVERT_EVENT } from "./modal";
import { addSettingRow } from "./registry";

interface WindowCfg { closeToTray: boolean; summonHotkey: string }

async function readWindow(): Promise<WindowCfg> {
  const { config } = await loadConfig();
  const w = config.window as { closeToTray?: unknown; summonHotkey?: unknown } | null | undefined;
  return {
    closeToTray: w?.closeToTray === true,
    summonHotkey: typeof w?.summonHotkey === "string" ? w.summonHotkey : "",
  };
}

async function saveWindow(patch: Partial<WindowCfg>): Promise<WindowCfg> {
  const next = { ...(await readWindow()), ...patch };
  await invoke("patch_settings", { key: "window", value: next });
  return next;
}

/** parse_chord's grammar spells the Windows key "Win"; chordOf says "Meta". */
function tidy(chord: string): string {
  return chord.split("+").map((p) => (p === "Meta" ? "Win" : p)).join("+");
}

function switchControl(setError: (msg: string) => void): HTMLElement {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "module-settings__switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", "Close to Tray");
  toggle.setAttribute("aria-checked", "false");
  void readWindow().then((w) => toggle.setAttribute("aria-checked", String(w.closeToTray)));
  toggle.addEventListener("click", () => {
    const want = toggle.getAttribute("aria-checked") !== "true";
    toggle.disabled = true;
    saveWindow({ closeToTray: want }).then(
      () => { toggle.setAttribute("aria-checked", String(want)); setError(""); },
      (e) => setError(String(e)),
    ).finally(() => { toggle.disabled = false; });
  });
  return toggle;
}

function chordControl(setError: (msg: string) => void): HTMLElement {
  const bind = document.createElement("div");
  bind.className = "sc-bind";
  const key = document.createElement("button");
  key.type = "button";
  key.className = "sc-key";
  key.title = "Press a New Shortcut";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "sc-reset";
  clear.textContent = "Clear";
  clear.title = "Clear";
  let saved = "";
  let recording = false;
  const paint = () => {
    key.textContent = recording ? "Press keys…" : saved || "Unbound"; // copy-ok: same prompt as modal.ts's shortcut recorder
    key.classList.toggle("recording", recording);
    clear.hidden = saved === "";
  };
  const stop = () => { recording = false; paint(); };
  const commit = (chord: string) => {
    recording = false;
    saveWindow({ summonHotkey: chord }).then(
      () => { saved = chord; setError(""); },
      (e) => setError(`${chord || "Unbound"}: ${String(e)}`),
    ).finally(paint);
    paint();
  };
  paint();
  void readWindow().then((w) => { saved = w.summonHotkey; paint(); });
  key.addEventListener("click", () => {
    recording = !recording;
    paint();
    if (recording) key.focus();
  });
  key.addEventListener("blur", () => { if (recording) stop(); });
  key.addEventListener(REVERT_EVENT, stop);
  // Eats every key while armed, like modal.ts handleRecordingKey: a rejected chord must not
  // reach the WebView2 shortcuts (find bar and the like).
  key.addEventListener("keydown", (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      stop();
      return;
    }
    const chord = chordOf(e);
    if (chord) commit(tidy(chord));
  });
  clear.addEventListener("click", () => commit(""));
  bind.append(key, clear);
  return bind;
}

let registered = false;

/** Adds the two rows once, after the scalar General rows and before the Editor row. */
export function registerWindowTrayRows(category: string): void {
  if (registered) return;
  registered = true;
  addSettingRow({
    name: "Close to Tray",
    description: "Off = the X quits.", // note-ok: user, 2026-10-18 (states the off value)
    tip: "On: the X, Close and Alt+F4 hide Vidar to the tray. Tray Quit still exits.",
    category,
    restartRequired: true,
    control: switchControl,
  });
  addSettingRow({
    name: "Summon Shortcut",
    description: "Empty = unbound.", // note-ok: user, 2026-10-18 (states the empty value)
    tip: "A global shortcut that brings Vidar back from the tray or from behind other windows.",
    category,
    restartRequired: true,
    control: chordControl,
  });
}
