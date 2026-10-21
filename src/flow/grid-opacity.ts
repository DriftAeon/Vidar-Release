// Flow canvas grid-line opacity: vidar.json `flowGridOpacity` (whole percent) drives the
// `--flow-grid-opacity` percentage on the Flow root, which flow.css reads for the grid
// lines. Absent = DEFAULT_GRID_OPACITY, the alpha the lines had before the setting existed.
// Live: Settings › Flow saves through patch_settings, whose settings-changed event lands here.

import { loadConfig, onSettingsChanged } from "../config";
import { S } from "./state";
import { gridOpacityCssValue } from "./grid-opacity-value";

export { DEFAULT_GRID_OPACITY } from "./grid-opacity-value";

export function applyGridOpacity(percent: number | undefined): void {
  S.rootEl?.style.setProperty("--flow-grid-opacity", gridOpacityCssValue(percent));
}

/** Reads the saved value now and follows later saves. Call once the Flow root exists. */
export function initGridOpacity(): void {
  const load = () => void loadConfig().then(({ config }) => applyGridOpacity(config.flowGridOpacity));
  load();
  onSettingsChanged(({ keys }) => { if (keys.includes("flowGridOpacity")) load(); });
}
