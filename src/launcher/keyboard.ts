// src\launcher\keyboard.ts — the keyboard path through the ＋ launcher: the kbNav hover gate, the
// "new-tab" chord's open and the arrow/Enter walk across columns. Split from main.ts; the
// menu's elements arrive through initLauncherKeyboard, so this module never imports menu.ts.
import { onboardingOpen } from "../onboarding/shell";

export interface LauncherKeyboardDeps {
  launcherMenu: HTMLElement;
  launcherSub: HTMLElement;
  launcherCols: HTMLElement[];
  col: (depth: number) => HTMLElement;
  openLauncher: () => void;
}
let launcherMenu!: HTMLElement;
let launcherSub!: HTMLElement;
let launcherCols!: HTMLElement[];
let col!: (depth: number) => HTMLElement;
let openLauncher!: () => void;

/* ---- keyboard path through the launcher (the "new-tab" shortcut) ----
   Open as if ＋ was clicked, land on row 0, then arrows walk the list:
   Down/Up within a column, Right/Enter into the locations flyout, Left back
   out, Enter on a location spawns (native button activation). Escape closes
   through the popover core (modules/popover.ts), opened by launcher/menu.ts. */

// True from a keyboard open until the pointer genuinely moves; gates the
// hover-opens-flyout behaviour so a synthetic mouseenter can't retarget it.
export let kbNav = false;
let kbPointer: { x: number; y: number } | null = null;

/** mousemove on the root menu and on every flyout column (columns.ts): the second move at a new
 *  spot ends keyboard mode. On the root alone, a pointer that went straight to a column after a
 *  keyboard walk found every hover there dead until it crossed the root menu. */
export function kbPointerMove(e: MouseEvent): void {
  if (!kbNav) return;
  if (kbPointer && (e.clientX !== kbPointer.x || e.clientY !== kbPointer.y)) endKbNav();
  else kbPointer = { x: e.clientX, y: e.clientY };
}

/** Back to pointer mode; the launcher's close calls it so keyboard mode never outlives an opening. */
export function endKbNav(): void {
  kbNav = false;
  kbPointer = null;
}

export function openLauncherByKeyboard() {
  if (onboardingOpen()) return; // onboarding gate: no new tab chord while the overlay is up
  // mid-edit in "Add new…": the chord must not yank focus out of the form
  if (launcherCols.some((c) => c.contains(document.activeElement))) return;
  if (launcherMenu.classList.contains("hidden")) openLauncher();
  kbNav = true;
  kbPointer = null;
  launcherMenu.querySelector<HTMLButtonElement>(":scope > button")?.focus();
}

function moveFocus(container: HTMLElement, delta: number) {
  const btns = [...container.querySelectorAll<HTMLButtonElement>(":scope > button")];
  if (!btns.length) return;
  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
  btns[i < 0 ? 0 : (i + delta + btns.length) % btns.length].focus();
}

// one keyboard handler for every column: Down/Up within it, Right/Enter into
// the next column from a has-sub row, Left back to the parent's open row
export function colKeydown(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement) return; // add-form has its own keys
  const c = e.currentTarget as HTMLElement;
  const depth = Number(c.dataset.depth);
  const row = e.target as HTMLElement;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveFocus(c, e.key === "ArrowDown" ? 1 : -1);
  } else if ((e.key === "ArrowRight" || e.key === "Enter") && row.classList.contains("has-sub")) {
    e.preventDefault(); // Enter would also fire the native click and open twice
    kbNav = true;
    row.click();
    col(depth + 1).querySelector<HTMLButtonElement>(":scope > button")?.focus();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    (depth === 0 ? launcherMenu : col(depth - 1)).querySelector<HTMLButtonElement>("button.open")?.focus();
  }
}

export function initLauncherKeyboard(deps: LauncherKeyboardDeps): void {
  ({ launcherMenu, launcherSub, launcherCols, col, openLauncher } = deps);
  launcherMenu.addEventListener("mousemove", kbPointerMove);

  launcherMenu.addEventListener("keydown", (e) => {
    const row = e.target as HTMLElement;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(launcherMenu, e.key === "ArrowDown" ? 1 : -1);
    } else if ((e.key === "ArrowRight" || e.key === "Enter") && row.classList.contains("has-sub")) {
      // preventDefault: Enter would also fire the native click and open twice
      e.preventDefault();
      kbNav = true;
      row.click();
      launcherSub.querySelector<HTMLButtonElement>(":scope > button")?.focus();
    }
  });
  // (the columns' keyboard walk is colKeydown, attached as each column is created)
}
