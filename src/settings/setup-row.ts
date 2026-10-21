// General's Setup row: re-runs onboarding from the Primary Agent step. It never clears
// `primaryAgent`; the step preselects the saved pick. start.ts loads lazily so the settings bundle
// never pulls the step files.
import { closeShortcutsModal } from "./modal";
import { addSettingRow } from "./registry";

export function registerSetupRow(category: string): void {
  addSettingRow({
    name: "Setup",
    category,
    tip: "Walk through the first-run setup again, starting at the primary agent. Your saved choices stay until you change them.",
    keywords: () => "onboarding first run welcome primary agent workspace theme modules",
    control: () => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ws-btn setup-run";
      b.textContent = "Run Setup";
      b.addEventListener("click", () => {
        // Close first: the modal's close refocuses the previously active tab.
        closeShortcutsModal();
        void import("../onboarding/start")
          .then((m) => m.runOnboarding("primary", false))
          .catch((e) => console.error("Can't Run Setup:", e));
      });
      return b;
    },
  });
}
