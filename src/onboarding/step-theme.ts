// src\onboarding\step-theme.ts — onboarding step 4, Theme (mock primary-agent-variants A, frames 7 and 8).
// Four buttons, one per mode, the current one marked selected. A click applies the theme live (the same
// applyTheme the CAS dial uses); going Back does not revert it. Next is always enabled.
import { MODES, MODE_ORDER, applyTheme, currentMode, onThemeChange, type ModeName } from "../theme";
import { registerStep, type StepCtx } from "./steps";

registerStep({
  id: "theme",
  title: "Theme",
  mount(body: HTMLElement, _ctx: StepCtx) {
    const root = document.createElement("div");
    root.className = "ob-theme";
    body.appendChild(root);
    const buttons = new Map<ModeName, HTMLButtonElement>();
    for (const name of MODE_ORDER) {
      const m = MODES[name];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ws-btn ob-theme-btn";
      b.style.setProperty("--ob-theme-c", m.plate ?? m.xterm.cursor);
      const swatch = document.createElement("i");
      const label = document.createElement("span");
      label.textContent = m.label;
      b.append(swatch, label);
      b.addEventListener("click", () => { if (name !== currentMode()) applyTheme(name); });
      buttons.set(name, b);
      root.append(b);
    }
    function mark(): void {
      for (const [name, b] of buttons) {
        const on = name === currentMode();
        b.classList.toggle("selected", on);
        b.setAttribute("aria-pressed", String(on));
      }
    }
    mark();
    let disposed = false;
    // onThemeChange has no unsubscribe; the flag turns the listener into a no-op after unmount
    onThemeChange(() => { if (!disposed) mark(); });
    return () => { disposed = true; };
  },
});
