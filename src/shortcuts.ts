// User-rebindable shortcuts: one document-level capture listener dispatching into the
// registry (`./settings/registry.ts`) and the modal (`./settings/modal.ts`).
//
// Capture at document is the whole trick: xterm registers its keydown on the
// helper textarea (CoreBrowserTerminal.ts, capture on that element), so a
// chord stopped here never reaches the pty. The xterm custom key handler in
// sessions.ts keeps owning Ctrl+F and the zoom keys — those chords are
// refused by the recorder rather than fought over.

import { cycleTab } from "./panels/sessions";
import { chordOf, matchShortcut } from "./shortcuts-core";
import {
  addShortcut,
  addSettingRow,
  getCurrent,
  getRegistry,
  initRegistry,
  type Shortcut,
} from "./settings/registry";
import {
  closeShortcutsModal,
  escapeShortcutsModal,
  handleRecordingKey,
  isRecording,
  isShortcutsModalOpen,
  openShortcutsModal,
} from "./settings/modal";

export type { Shortcut,  } from "./settings/registry";
export { addShortcut, addSettingRow, openShortcutsModal, closeShortcutsModal, isShortcutsModalOpen };

export function initShortcuts(defs: Shortcut[], overrides: Record<string, string>) {
  const cycling: Shortcut[] = [
    { id: "cycle-tab", name: "Next Tab", tip: "Wraps at the end.", defaultKeys: "Ctrl+Tab", run: () => cycleTab(1) },
    { id: "cycle-tab-back", name: "Previous Tab", tip: "Wraps at the start.", defaultKeys: "Ctrl+Shift+Tab", run: () => cycleTab(-1) },
  ];
  initRegistry([...defs, ...cycling], overrides);
  document.addEventListener("keydown", onKeyDown, true);
}

function onKeyDown(e: KeyboardEvent) {
  if (isRecording()) {
    handleRecordingKey(e);
    return;
  }
  if (isShortcutsModalOpen()) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      escapeShortcutsModal(); // reverts a focused setting field instead of blur-saving it
    }
    return; // no shortcuts fire behind the modal
  }
  // inspect mode owns the keyboard (its own capture listener handles Escape)
  if (document.body.classList.contains("inspect-mode")) return;
  const chord = chordOf(e);
  if (!chord) return;
  const s = matchShortcut(chord, getRegistry(), getCurrent());
  if (!s) return;
  e.preventDefault();
  e.stopPropagation();
  s.run();
}
