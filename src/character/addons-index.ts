// What `@character-addons` resolves to in a normal build: every local renderer addon under
// addons/<id>/index.ts, eagerly bundled. The folder is gitignored and may be absent; then the
// glob is an empty map. A release build (VIDAR_CHARACTER_ADDONS=off) resolves the specifier to
// addons-none.ts instead, so nothing here reaches its dist (vite.config.ts, tsconfig.json).
import type { AddonModules } from "./renderer-registry";

export const addons: AddonModules = import.meta.glob("./addons/*/index.ts", { eager: true });
