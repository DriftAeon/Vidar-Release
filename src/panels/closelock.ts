/* Close lock: one switch in the bottom bar, global to the window,
   off by default. A marker for agents, not an enforcement. Locked means "do not
   close Vidar for a release swap — ask the user"; unlocked means
   tools\release\swap-release.ps1 may close it itself. The file
   bridge\close-lock.json is the only truth: read on mount, written on every
   flip, so scripts can check it without the UI. The glyph is a colour lock
   image (public/icons/color) that follows the state: closed when locked, open
   when unlocked. */
import { iconImg } from "../icon-img";
import { initSwitch } from "./toggle-switch";

export async function initCloseLock(host: HTMLElement, signal?: AbortSignal) {
  const img = iconImg("unlock");
  img.classList.add("close-lock-icon");
  await initSwitch(host, {
    name: "close-lock",
    label: "Close lock",
    titles: { on: "Locked", off: "Unlocked" },
    stateClass: "locked",
    glyph: img,
    onState: (on) => { img.src = `/icons/color/${on ? "lock" : "unlock"}.svg`; },
    signal,
  });
}
