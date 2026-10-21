// Stale-Claude notice for Falcon-hosted Rendered tabs (pure, unit-tested in
// tests\bundle-version.test.mjs). A hosted tab spawns the user's installed
// claude.exe (the pinned store entry is only the fallback when none is
// installed), and the native installer self-updates, so a tab that started
// before the CLI updated runs an older Claude than the installed one. The
// panel compares the tab's reported `claude_code_version` with
// `claude_installed_version` (src-tauri claude_version.rs) and shows this chip
// in the agent pill: a new tab picks up the installed version. Never refreshes.

/** Numeric dotted compare; `null` when either side is not a plain version. */
function compareVersions(a: string, b: string): number | null {
  const pa = a.split(".");
  const pb = b.split(".");
  if (![...pa, ...pb].every((p) => /^\d+$/.test(p))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Chip text when the tab's Claude is strictly older than the installed one, else null. */
export function bundleChip(reported: string | undefined, installed: string | null | undefined): string | null {
  if (!reported || !installed) return null;
  return compareVersions(reported, installed) === -1
    ? `New Tab Uses ${installed}`
    : null;
}

export const BUNDLE_CHIP_TIP =
  "This tab started before the installed Claude Code updated, so it still runs the older version. " +
  "A new tab uses the installed version.";
