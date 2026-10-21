export type CharacterLoop = "bn01" | "bn02" | "br01" | "f002";
const LOW_CONTEXT_ENTER = 80;
const LOW_CONTEXT_LEAVE = 75;
const CHARACTER_ACTIVITY_ARM_MS = 350;
export const CHARACTER_ACTIVITY_QUIET_MS = 900;

/* Which character a tab shows comes from the user's packs (resolve.ts). Under AUTO
   (no fixed model pinned) the ordinary Idle (bn01) is replaced with Clip F002 as the
   idle-equivalent — the same character body, a different resting pose to tell the two apart
   at a glance. */
const IDLE_OVERRIDES = new Map<string, CharacterLoop>([["auto", "f002"]]);

function idleLoopForModel(model: string | null | undefined): CharacterLoop {
  const key = model?.trim().toLowerCase();
  return (key ? IDLE_OVERRIDES.get(key) : undefined) ?? "bn01";
}

export function reduceLowContext(current: boolean, percentage: number | null, fresh: boolean): boolean {
  if (!fresh || percentage === null || !Number.isFinite(percentage)) return current;
  return current ? percentage >= LOW_CONTEXT_LEAVE : percentage >= LOW_CONTEXT_ENTER;
}

/* Run (`br01`) is off: a running character in the rail is distracting
   while the activity signal is still coarse. Active tabs sit on Idle until that is fixed;
   `active` stays in the signature so the arm/quiet plumbing and its tests keep their shape
   and flipping Run back on is a one-line change. */
export function characterLoop(_active: boolean, lowContext: boolean, model?: string | null): CharacterLoop {
  return lowContext ? "bn02" : idleLoopForModel(model);
}

/* Raw pty tabs have no turn boundaries, so the character reads output as work. That only
   holds for a TUI that goes quiet when it is idle. The Codex TUI repaints while idle — the
   same fact that removed the background-activity dot (sessions.ts) — so the
   quiet timer never fired and the character ran forever: through a `/model` popup, and on
   past a finished Astra review. No cheap frame signal separates the two
   (frames are ANSI deltas; an idle repaint still differs byte for byte), so these agents get
   no run loop at all in a raw tab. Rendered Codex is unaffected: it has protocol turns. */
const IDLE_REPAINT_AGENTS = new Set(["codex", "gemini"]);

export function rawOutputMeansWork(agent: string): boolean {
  return !IDLE_REPAINT_AGENTS.has(agent);
}

export interface OutputActivityState {
  armedAt: number | null;
  active: boolean;
  lastOutputAt: number;
}

export function reduceOutputPulse(state: OutputActivityState | undefined, now: number): {
  state: OutputActivityState;
  edge: true | null;
} {
  if (!state) return { state: { armedAt: now, active: false, lastOutputAt: now }, edge: null };
  state.lastOutputAt = now;
  if (state.active) return { state, edge: null };
  if (state.armedAt === null || now - state.armedAt > CHARACTER_ACTIVITY_ARM_MS) {
    state.armedAt = now;
    return { state, edge: null };
  }
  state.active = true;
  state.armedAt = null;
  return { state, edge: true };
}

/* Per-character, per-clip playrate overrides: `playrate` in a character pack maps
   a clip code ("bn01") to a multiplier. Anything missing, non-finite or non-positive plays at 1. */
export type PlayrateOverrides = Readonly<Record<string, number>>;

export function clipCode(clipName: string): string {
  const at = clipName.lastIndexOf("_");
  return at < 0 ? clipName : clipName.slice(at + 1);
}

export function clipPlayrate(overrides: PlayrateOverrides | undefined, clipName: string): number {
  const rate = overrides?.[clipCode(clipName)];
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : 1;
}

export function reduceOutputQuiet(state: OutputActivityState, now: number): {
  edge: false | null;
  remaining: number;
} {
  if (!state.active) return { edge: null, remaining: 0 };
  const remaining = CHARACTER_ACTIVITY_QUIET_MS - (now - state.lastOutputAt);
  if (remaining > 0) return { edge: null, remaining };
  state.active = false;
  state.armedAt = null;
  return { edge: false, remaining: 0 };
}
