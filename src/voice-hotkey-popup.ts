// The voice hotkey conflict popup: the update card's frame (startup-updates/shell.ts: a fixed
// nonmodal aside with a Close X, the .vs-confirm box) holding the Swap Confirm parts (head, sentence,
// Yes/No pair), so there is no new look. Change Hotkey opens the voice hotkey setting, Retry binds the
// chord again (a second refusal repaints the card), Dismiss removes it. One card at a time.

import { button, confirmRow } from "./dom";
import { iconImg } from "./icon-img";
import { openShortcutsModal } from "./shortcuts";
import { cardShell, type CardShell } from "./startup-updates/shell";
import { asHotkeyError, hotkeyHead, hotkeyNote, type HotkeyError } from "./voice-hotkey-error";

let shell: CardShell | null = null;

function close(): void {
  shell?.destroy();
  shell = null;
}

/** Shows the popup for a refused chord. `retry` binds it again and rejects with the new error. */
export function showHotkeyPopup(err: HotkeyError, retry: () => Promise<void>): void {
  close();
  const sh = cardShell(document, () => iconImg("close"));
  shell = sh;
  const paint = (e: HotkeyError, busy: boolean): void => {
    sh.card.setAttribute("aria-label", hotkeyHead(e));
    const head = document.createElement("div");
    head.className = "swap-confirm-head";
    head.textContent = hotkeyHead(e);
    const body = document.createElement("div");
    body.className = "swap-confirm-body";
    const note = document.createElement("p");
    note.className = "vs-confirm-text";
    note.textContent = hotkeyNote(e);
    const actions = document.createElement("div");
    actions.className = "swap-confirm-actions";
    actions.append(button("Change Hotkey", "swap-no", () => { close(); openShortcutsModal("keybinds"); }));
    confirmRow({
      root: body, note, acts: actions,
      yes: {
        label: "Retry", disabled: busy,
        run: () => {
          paint(e, true);
          retry().then(
            () => { if (shell === sh) close(); },
            (x: unknown) => { if (shell === sh) paint(asHotkeyError(x) ?? e, false); },
          );
        },
      },
      no: { label: "Dismiss", run: close },
    });
    sh.body.replaceChildren(head, body);
  };
  paint(err, false);
}
