// src\onboarding\step-modules.ts — onboarding step 5, Modules (mock onboarding-shell-modules M1, One List).
// One list of the bench modules the release ships: icon, name and the Settings switch. A flip goes through
// setModuleVisible (the Settings path), so it writes `modules.hidden` and the app follows live. Next is
// always enabled. The shell re-reads the Runes listing on `vidar-modules-change`, so hiding Runes here
// turns this step into the last one.
import { iconImg, type ColorIcon } from "../icon-img";
import { moduleListed, onModulesChange } from "../modules/registry";
import { moduleName, onModuleNamesChange } from "../modules/names";
import { SURFACE_ICONS, WORKBENCH_MODULES } from "../panels/workbench-modules";
import { getPref } from "../prefs";
import { setModuleVisible } from "../settings/modules";
import { moduleRows, rowOn } from "./modules-list";
import { registerStep, type StepCtx } from "./steps";

registerStep({
  id: "modules",
  title: "Modules",
  mount(body: HTMLElement, _ctx: StepCtx) {
    const root = document.createElement("div");
    root.className = "ob-modules";
    const list = document.createElement("div");
    list.className = "ob-mod-list";
    root.append(list);
    body.appendChild(root);

    function paint(): void {
      const hidden = getPref("modules.hidden") ?? [];
      list.replaceChildren(...moduleRows(WORKBENCH_MODULES, moduleListed).map((row) => {
        const name = moduleName(row.key, row.label);
        const line = document.createElement("div");
        line.className = "ob-mod-row";
        const title = document.createElement("span");
        title.className = "ob-mod-name";
        title.append(iconImg((SURFACE_ICONS[row.key] ?? row.key) as ColorIcon));
        const text = document.createElement("span");
        text.textContent = name;
        title.append(text);
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "module-settings__switch";
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-label", name);
        toggle.setAttribute("aria-checked", String(rowOn(row, hidden)));
        toggle.addEventListener("click", () => void setModuleVisible(row.id, !rowOn(row, getPref("modules.hidden") ?? [])));
        line.append(title, toggle);
        return line;
      }));
    }

    paint();
    document.addEventListener("vidar-modules-change", paint);
    const offs = [onModulesChange(paint), onModuleNamesChange(paint)];
    return () => {
      document.removeEventListener("vidar-modules-change", paint);
      for (const off of offs) off();
    };
  },
});
