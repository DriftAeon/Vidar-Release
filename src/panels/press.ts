/** src\panels\press.ts — act on press, not release, for disclosure toggles.
 *  `click` fires on mouse-up, so a toggle waits for the release (Loadout rows
 *  felt ~0.1 s late, Unreal's Pressed vs Clicked). The primary pointer button acts on
 *  pointerdown; the click that follows it is swallowed; keyboard (Enter/Space) still arrives
 *  as a click with no pointerdown before it and acts there. */
let lastPress: { el: HTMLElement; act: () => void } | null = null;

/** Run the last pointer press on `el` again — its toggle undone — when that press turned into
 *  something else (a drag, reorder.ts). No-op for any other element. */
export function repeatPress(el: HTMLElement): void {
  if (lastPress?.el !== el) return;
  const { act } = lastPress;
  lastPress = null;
  act();
}

export function onPress(el: HTMLElement, act: () => void): void {
  let pressed = false;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (el as HTMLButtonElement).disabled) return;
    pressed = true;
    lastPress = { el, act };
    act();
  });
  el.addEventListener("click", () => {
    if (pressed) { pressed = false; return; }
    act();
  });
  // a press dragged off the element never produces its click; don't eat the next keyboard one
  el.addEventListener("pointercancel", () => { pressed = false; });
  el.addEventListener("pointerleave", () => { pressed = false; });
}
