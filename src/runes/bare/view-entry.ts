// src\runes\bare\view-entry.ts — the Bare view's entry points for a caller other than the Runes tab
// (onboarding's First Runeset step): which view it opens on and the done notification. Pure, no imports,
// so `node --test` loads it. view.ts is at its line cap; the logic lives here.

export type StartView = "actives" | "files";

/** Pure: the view a mount opens on; anything but "files" is the Runes tab's own Actives. */
export function startView(start?: string): StartView {
  return start === "files" ? "files" : "actives";
}

/** Fires `onDone` once when the user is back on Actives after a run (an import, Import Raw or an agent
 *  generate) was started. `ran` marks the start, `atActives` is called on every Actives paint. */
export function doneGate(onDone?: () => void): { ran(): void; atActives(): void } {
  let ran = false;
  return {
    ran() { ran = true; },
    atActives() {
      if (!ran) return;
      ran = false;
      onDone?.();
    },
  };
}
