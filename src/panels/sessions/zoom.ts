// Font zoom for terminal tabs: the size kept as an offset from vidar.json's fontSize, the
// Ctrl+wheel/key steps and the readout toast. sessions.ts binds its tab map and refit in.
import { getPref, setPref } from "../../prefs";
import type { TerminalSession } from "./types";

let sessions: ReadonlyMap<string, TerminalSession> = new Map();
let refitActive: () => void = () => {};

/** sessions.ts, at load: the tab map applyFont walks and the refit it calls after. */
export function bindZoom(deps: { sessions: ReadonlyMap<string, TerminalSession>; refitActive: () => void }) {
  sessions = deps.sessions;
  refitActive = deps.refitActive;
}

// Zoom persists as prefs "sessions.zoomOffset", an offset from baseFont (vidar.json's fontSize),
// so a later config change doesn't get shadowed by a stale absolute value. "sessions.legacyFont"
// is the retired absolute size (imported from the old vidar-font key), read once for migration.
const FONT_MIN = 8;
const FONT_MAX = 28;

let baseFont = 14;
export let currentFont = 14;

/** initSessions: seed the size from vidar.json's fontSize and the saved offset (one-time legacy migration). */
export function initZoom(opts?: { fontSize?: number }) {
  baseFont = opts?.fontSize ?? 14;
  let offset = 0;
  const savedOffset = getPref("sessions.zoomOffset");
  if (savedOffset !== undefined) {
    offset = savedOffset || 0;
  } else {
    // one-time migration: the old key held an absolute font size, which
    // shadowed vidar.json's fontSize forever once the user zoomed once.
    const legacy = getPref("sessions.legacyFont") ?? 0;
    if (legacy >= FONT_MIN && legacy <= FONT_MAX) offset = legacy - baseFont;
    if (offset !== 0) setPref("sessions.zoomOffset", offset);
  }
  // Retired either way (a no-op when absent): both old keys can arrive in one import, and a
  // leftover would sit in vidar-state.json for good.
  setPref("sessions.legacyFont", undefined);
  currentFont = Math.max(FONT_MIN, Math.min(FONT_MAX, baseFont + offset));
}

/* ---- font zoom (all sessions; hidden ones re-fit on next activate) ---- */

let zoomToast: HTMLElement | null = null;
let zoomToastTimer: number | undefined;

// The terminal area's one transient toast (top-centre): the zoom readout, and
// sessions.ts's file-link open errors. Holds `ms` after the last call, then fades.
export function showSessionsToast(message: string, ms = 500) {
  if (!zoomToast) {
    zoomToast = document.createElement("div");
    zoomToast.id = "zoom-toast";
    document.body.appendChild(zoomToast);
  }
  zoomToast.textContent = message;
  zoomToast.classList.remove("fading");
  window.clearTimeout(zoomToastTimer);
  zoomToastTimer = window.setTimeout(() => zoomToast?.classList.add("fading"), ms);
}

// Transient readout so wheel/key zoom shows where it landed.
function showZoomToast() {
  showSessionsToast(`Zoom ${Math.round((currentFont / baseFont) * 100)}%`);
}

function applyFont() {
  const offset = currentFont - baseFont;
  setPref("sessions.zoomOffset", offset === 0 ? undefined : offset);
  for (const s of sessions.values()) {
    if (s.term) s.term.options.fontSize = currentFont;
  }
  refitActive();
  showZoomToast();
}

export function zoomBy(delta: number) {
  currentFont = Math.max(FONT_MIN, Math.min(FONT_MAX, currentFont + delta));
  applyFont();
}

export function zoomReset() {
  currentFont = baseFont;
  setPref("sessions.zoomOffset", undefined);
  applyFont();
}
