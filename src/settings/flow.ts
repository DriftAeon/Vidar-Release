// The Flow settings page: Grid Opacity, the Flow canvas grid-line opacity as a whole percent
// (vidar.json `flowGridOpacity`, saved through `patch_settings`; applied live by
// src/flow/grid-opacity.ts on the settings-changed event). Same numeric input as General.

import { invoke } from "../ipc";
import { loadConfig } from "../config";
import { DEFAULT_GRID_OPACITY } from "../flow/grid-opacity";
import { addSettingRow, registerCategory } from "./registry";
import { REVERT_EVENT } from "./modal";

export const FLOW_CATEGORY = "flow";
const KEY = "flowGridOpacity";

function control(setError: (msg: string) => void): HTMLElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = "100";
  input.step = "5";
  input.className = "sc-input";
  let saved = String(DEFAULT_GRID_OPACITY);
  input.value = saved;
  void loadConfig().then(({ config }) => {
    saved = String(config.flowGridOpacity ?? DEFAULT_GRID_OPACITY);
    input.value = saved;
  });
  const revert = () => {
    input.value = saved;
    setError("");
  };
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    if (raw === saved) return;
    if (raw === "") {
      revert();
      return;
    }
    void invoke("patch_settings", { key: KEY, value: Number(raw) }).then(
      () => { saved = raw; setError(""); },
      (e) => setError(String(e)),
    );
  });
  input.addEventListener(REVERT_EVENT, revert);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") revert();
    e.stopPropagation();
  });
  return input;
}

let registered = false;

/** Adds the Flow category and its one row once (after Cards, ahead of Dependencies). */
export function registerFlowRows(): void {
  if (registered) return;
  registered = true;
  registerCategory(FLOW_CATEGORY, "Flow", "dependencies", "module");
  addSettingRow({
    name: "Grid Opacity",
    description: "0 to 100.",
    tip: "How strongly the Flow canvas draws its grid lines.",
    category: FLOW_CATEGORY,
    control,
  });
}
