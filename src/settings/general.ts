// General settings rows: the
// scalar vidar.json keys, each saved through `patch_settings`, whose server-side allowlist and
// validators (src-tauri/src/settings/commands.rs) are the authority; a refusal is shown on the row.
// fontSize and defaultCwd are read once by initSessions, so those rows are
// restartRequired. The Editor row (`editor` {exe, args}, and the legacy `riderPath` fallback with
// its Clear) is its own module, editor.ts, registered at the end of this page.

import { invoke } from "../ipc";
import { loadConfig, type VidarConfig } from "../config";
import { addSettingRow, registerCategory } from "./registry";
import { isShortcutsModalOpen, REVERT_EVENT } from "./modal";
import { registerDocumentAppRow } from "./document-app";
import { registerEditorRow } from "./editor";
import { registerWindowTrayRows } from "./window-tray";
import { registerReleaseRow } from "./release";
import { registerBuildPage } from "./build/page";
import { registerSetupRow } from "./setup-row";

export const GENERAL_CATEGORY = "general";

type Key = "fontSize" | "defaultCwd";

interface GeneralRow {
  key: Key;
  name: string;
  description: string;
  tip: string;
  restartRequired: boolean;
  /** Numeric input bounds; mirror commands.rs validate_font_size (8..=48, whole numbers). */
  numeric?: { min: number; max: number; step: number };
  placeholder?: string;
}

const ROWS: GeneralRow[] = [
  { key: "fontSize", name: "Font Size", description: "8 to 48.", tip: "Terminal base size. Zoom is an offset on top.", restartRequired: true, numeric: { min: 8, max: 48, step: 1 } },
  { key: "defaultCwd", name: "Default Folder", description: "Empty = your home folder.", tip: "Working folder for a new tab with no location.", restartRequired: true, placeholder: "D:\\Projects" }, // note-ok: user, 2026-10-01 (states the empty value)
];

// A refusal that lands after the modal closed (blur-save on a backdrop click or ×) would be
// written into a hidden row and lost; it is kept here and shown when the row is next built.
const pendingErrors = new Map<Key, string>();

function currentValue(cfg: VidarConfig, key: Key): string {
  const v = cfg[key];
  return v === undefined || v === null ? "" : String(v);
}

function control(row: GeneralRow, setError: (msg: string) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = row.numeric ? "number" : "text";
  if (row.numeric) {
    input.min = String(row.numeric.min);
    input.max = String(row.numeric.max);
    input.step = String(row.numeric.step);
  }
  input.className = "sc-input";
  input.spellcheck = false;
  if (row.placeholder) input.placeholder = row.placeholder;
  const pending = pendingErrors.get(row.key);
  if (pending) {
    pendingErrors.delete(row.key);
    setError(`Not saved: ${pending}`);
  }
  // Read on every open: a save drops config.ts's memo (settings-changed), so this is the file.
  let saved = "";
  void loadConfig().then(({ config }) => {
    saved = currentValue(config, row.key);
    input.value = saved;
  });
  const revert = () => {
    input.value = saved;
    setError("");
  };
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    // Unchanged (including the blur that follows an Escape revert): nothing to save.
    if (raw === saved) return;
    // An emptied number field would reach Rust as 0; there is no "clear" for fontSize.
    if (row.numeric && raw === "") {
      revert();
      return;
    }
    const value = row.numeric ? Number(raw) : raw;
    void invoke("patch_settings", { key: row.key, value }).then(
      () => { saved = raw; setError(""); },
      (e) => {
        const msg = String(e);
        setError(msg);
        if (!isShortcutsModalOpen()) {
          pendingErrors.set(row.key, `${raw}: ${msg}`);
          console.warn(`settings: ${row.key} not saved: ${msg}`);
        }
      },
    );
  });
  // Escape while the modal is open is taken by shortcuts.ts's capture listener, which closes
  // the modal through escapeShortcutsModal(); that dispatches REVERT_EVENT on the focused
  // input first, so the blur-change that follows sees the saved value and saves nothing.
  input.addEventListener(REVERT_EVENT, revert);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    // Reached only while a chord recording is armed (the recorder lets input typing through).
    if (e.key === "Escape") revert();
    // Keeps typing from bubbling to document-level bubble listeners. The document CAPTURE
    // listener (shortcuts.ts) has already run by now; it is the recorder's own input check
    // (modal.ts handleRecordingKey) that lets these keys through.
    e.stopPropagation();
  });
  return input;
}

let registered = false;

/** Adds the General category and its rows once. */
export function registerGeneralRows(): void {
  if (registered) return;
  registered = true;
  registerCategory(GENERAL_CATEGORY, "General", "keybinds");
  for (const row of ROWS) {
    addSettingRow({
      name: row.name,
      description: row.description,
      tip: row.tip,
      category: GENERAL_CATEGORY,
      restartRequired: row.restartRequired,
      control: (setError) => control(row, setError),
    });
  }
  registerWindowTrayRows(GENERAL_CATEGORY);
  registerEditorRow(GENERAL_CATEGORY);
  registerDocumentAppRow(GENERAL_CATEGORY);
  registerReleaseRow(GENERAL_CATEGORY);
  registerSetupRow(GENERAL_CATEGORY);
  registerBuildPage();
}
