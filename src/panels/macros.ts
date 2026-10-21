import { writeToActive, focusActive } from "./sessions";

export interface Macro {
  label: string;
  command: string;
  submit?: boolean;
}

// Emptied: the launcher flyouts made the four starter
// macros redundant. The strip, this type and the vidar.json key stay wired —
// add entries there when a button earns its place.
export const BUILTIN_MACROS: Macro[] = [];

// Macros type into the active pty — same trust tier as config launchers
// (vidar.json is same-principal as the exe); nothing executes outside the
// user-visible terminal.
export function initMacros(container: HTMLElement, macros: Macro[]) {
  container.replaceChildren(); // re-run on a live macros save (main.ts onSettingsChanged)
  for (const m of macros) {
    const b = document.createElement("button");
    b.className = "macro-btn";
    b.textContent = m.label;
    // tooltip only earns its place when it adds something the label doesn't
    if (m.command.trim().toLowerCase() !== m.label.trim().toLowerCase()) b.title = m.command;
    b.addEventListener("click", async () => {
      // no failure UI on the strip: a page or dead tab refusing the bytes only logs; a Rendered tab
      // not ready to submit keeps the text unsent in its composer, where the user sees it
      if (!(await writeToActive(m.command + (m.submit ? "\r" : "")))) {
        console.warn(`macro "${m.label}": active tab took no input or could not submit it`);
        return;
      }
      focusActive();
    });
    container.appendChild(b);
  }
}
