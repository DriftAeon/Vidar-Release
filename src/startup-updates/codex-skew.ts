// Codex skew warning: hosted Codex sessions run Falcon's pinned copy, new tabs the npm-global one
// (src-tauri/src/deps/updates/skew.rs). One toast per detected version pair, remembered in
// runtime\vidar-state.json under SKEW_KEY; a new pair warns again. Import-free so tests load it.
export interface CodexSkew { hosted: string; tabs: string }

export const SKEW_TEXT = "Codex updated. Hosted sessions keep the old version until Falcon is refreshed.";
export const SKEW_KEY = "startupUpdates.codexSkewWarned";

const pair = (s: CodexSkew): string => `${s.hosted}>${s.tabs}`;

/** The pair to warn about and remember, or null when there is no skew or it was already warned. */
export function skewToWarn(skew: CodexSkew | null, state: Record<string, unknown>): string | null {
  if (!skew || skew.hosted === skew.tabs) return null;
  const p = pair(skew);
  return state[SKEW_KEY] === p ? null : p;
}

export interface SkewIo {
  check: () => Promise<CodexSkew | null>;
  readState: () => Promise<Record<string, unknown>>;
  patch: (entries: Record<string, string>) => Promise<void>;
  toast: (text: string) => void;
}

/** Toast once, then persist the pair; a failed save only means the next launch warns again. */
export async function warnCodexSkew(io: SkewIo): Promise<boolean> {
  const [skew, state] = await Promise.all([io.check(), io.readState()]);
  const p = skewToWarn(skew, state);
  if (!p) return false;
  io.toast(SKEW_TEXT);
  await io.patch({ [SKEW_KEY]: p }).catch(() => undefined);
  return true;
}
