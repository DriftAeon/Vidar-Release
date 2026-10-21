// Palette ids as saved on disk. The 2026-10-15 rename moved the four ids; a saved pick under an
// old id maps forward on load. Kept free of asset imports so tests can load it directly.
export const LEGACY_THEME_IDS: Readonly<Record<string, string>> = {
  zero: "onyx",
  jager: "cobalt",
  schneider: "ember",
  panzer: "olive",
};

/** Old palette id to its new id; anything else (new ids, unknown values, non-strings) passes through. */
export function migrateThemeId(raw: unknown): unknown {
  if (typeof raw === "string" && Object.hasOwn(LEGACY_THEME_IDS, raw)) return LEGACY_THEME_IDS[raw];
  return raw;
}
