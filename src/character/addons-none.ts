// What `@character-addons` resolves to when VIDAR_CHARACTER_ADDONS=off (the release build):
// no addons, same shape as addons-index.ts.
import type { AddonModules } from "./renderer-registry";

export const addons: AddonModules = {};
