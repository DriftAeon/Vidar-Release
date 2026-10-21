// The spawn_pty payload for one terminal attachment, pure so the profile rule is testable without
// xterm. A profiled tab (bare) sends `profile` and no shell or args: the backend owns that spawn
// line (src-tauri bare/), and rules and the app layer never ride it (a bare row ignores `rules`).
// Its row's `key` rides as `rowKey`, and Rust reads that row's rune `sets` from vidar.json into a
// built payload (src-tauri bare/layer.rs); the frontend never sends the sets themselves.
// Launch sites send a profiled tab no shell or args (launcher/roster.ts spawnFrom); Rust refuses a
// profiled spawn that carries either, so a site that slips one in shows a tab error instead of
// opening a default Claude or Codex tab.
import { injectRules, type RulesLaunch } from "../../rules/inject";
import { injectAppLayer } from "../../rules/app-layer";

export interface PtySpawnInput {
  id: string;
  cols: number;
  rows: number;
  cwd: string;
  tabName: string | null;
  ptyGen: number;
  shell?: string;
  args?: string[];
  rules?: RulesLaunch;
  profile?: string;
  /** The launching row's key, sent only with a profile (Rust refuses a rowKey without one). */
  rowKey?: string;
  /** The row's roster id (tab art, else its agent kind); sent only with a profile, Rust admits "claude" (Raw Claude Bare) and "codex" (Raw Codex Bare, the TUI under node). */
  agent?: string;
}

export interface PtySpawnPayload {
  id: string;
  cols: number;
  rows: number;
  cwd: string | null;
  tabName: string | null;
  ptyGen: number;
  shell?: string;
  args?: string[];
  profile?: string;
  rowKey?: string;
  agent?: string | null;
}

/** The payload plus the rules warning for the tab (none for a profiled tab). */
export function ptySpawnPayload(p: PtySpawnInput): { payload: PtySpawnPayload; warning?: string } {
  const base = { id: p.id, cols: p.cols, rows: p.rows, cwd: p.cwd || null, tabName: p.tabName, ptyGen: p.ptyGen };
  if (p.profile) {
    // Passed through untouched, never stripped: a caller that hands a profiled tab a shell or args
    // (a resume form) gets Rust's refusal, not a quiet fresh launch.
    const extra = { ...(p.shell !== undefined ? { shell: p.shell } : {}), ...(p.args !== undefined ? { args: p.args } : {}) };
    return { payload: { ...base, ...extra, profile: p.profile, ...(p.rowKey ? { rowKey: p.rowKey } : {}), agent: p.agent ?? null } };
  }
  const inj = injectRules(p.args, p.rules);
  return { payload: { ...base, shell: p.shell, args: injectAppLayer(inj.args) }, warning: inj.warning };
}
