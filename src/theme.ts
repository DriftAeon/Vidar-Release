import { invoke } from "./ipc";
import { getPref, setPref } from "./prefs";
import { migrateThemeId } from "./theme-ids";

export type ModeName = "onyx" | "cobalt" | "ember" | "olive";

interface Ansi16 {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface XtermColors extends Ansi16 {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

// Campbell — the Windows Terminal / PowerShell default palette, which is what
// this shell's output was authored against. Deliberately ONE set shared by all
// four CAS modes: the terminal renders true ANSI and the chrome alone carries
// the mode. Per-mode ANSI tuning was considered and dropped as premature.
const ANSI: Ansi16 = {
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

interface Mode {
  label: string;
  glyph: string;
  // CAS selector plate color; defaults to the mode accent (xterm cursor)
  plate?: string;
  xterm: XtermColors;
}

export const MODE_ORDER: ModeName[] = ["onyx", "cobalt", "ember", "olive"];

// Liger Zero CAS. Chrome tokens live in styles.css [data-theme] blocks; this
// holds only what JS needs (xterm colors + dial labels). Each mode sets its own
// background/foreground/cursor and spreads the shared ANSI-16 above.
export const MODES: Record<ModeName, Mode> = {
  onyx: {
    label: "Onyx",
    glyph: "O",
    plate: "#ffffff",
    xterm: {
      ...ANSI,
      background: "#0f0f13",
      foreground: "#e8e5dd",
      cursor: "#d7b254",
      cursorAccent: "#0f0f13",
      selectionBackground: "#3a3a48",
    },
  },
  cobalt: {
    label: "Cobalt",
    glyph: "C",
    xterm: {
      ...ANSI,
      background: "#0d1016",
      foreground: "#dce6f2",
      cursor: "#5aa2f0",
      cursorAccent: "#0d1016",
      selectionBackground: "#2b3c5a",
    },
  },
  ember: {
    label: "Ember",
    glyph: "E",
    xterm: {
      ...ANSI,
      background: "#131009",
      foreground: "#f0e7da",
      cursor: "#e0592f",
      cursorAccent: "#131009",
      selectionBackground: "#4a3520",
    },
  },
  olive: {
    label: "Olive",
    glyph: "V",
    xterm: {
      ...ANSI,
      background: "#0e110d",
      foreground: "#e2e8da",
      cursor: "#8aa15f",
      cursorAccent: "#0e110d",
      selectionBackground: "#33402c",
    },
  },
};

// Cobalt is the default theme, used when nothing is saved (2026-10-18); onyx stays the :root token set.
export const DEFAULT_MODE: ModeName = "cobalt";
let current: ModeName = DEFAULT_MODE;
const listeners: Array<(m: ModeName) => void> = [];

export function currentMode(): ModeName {
  return current;
}

export function xtermTheme(m: ModeName = current): XtermColors {
  return MODES[m].xterm;
}

export function onThemeChange(cb: (m: ModeName) => void) {
  listeners.push(cb);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Native title bar carries the theme BACKGROUND (dark, tinted per mode);
// title text gets the theme foreground.
export function syncCaption() {
  const t = MODES[current].xterm;
  const cap = hexToRgb(t.background);
  const txt = hexToRgb(t.foreground);
  invoke("set_caption_color", {
    r: cap.r, g: cap.g, b: cap.b,
    tr: txt.r, tg: txt.g, tb: txt.b,
  }).catch(() => {});
}

export function applyTheme(m: ModeName) {
  current = m;
  document.documentElement.dataset.theme = m;
  setPref("theme", m);
  syncCaption();
  for (const cb of listeners) cb(m);
}

/** Falcon shell: set only the page's `data-theme` from a theme name read out of vidar-state.json.
 *  No pref write, no caption sync, no listeners; unknown values are ignored. True when it changed. */
export function applyThemeAttr(stored: unknown): boolean {
  const raw = migrateThemeId(stored);
  if (typeof raw !== "string" || !Object.hasOwn(MODES, raw)) return false;
  if (document.documentElement.dataset.theme === raw) return false;
  current = raw as ModeName;
  document.documentElement.dataset.theme = raw;
  return true;
}

export function initTheme() {
  // The state file (via prefs) is the truth after boot. `window.__vidarPrepaintTheme` is only
  // the pre-paint hint main.rs injects once at startup; a webview reload re-injects that stale
  // startup value, so it must never be read back here.
  const stored = getPref("theme");
  const saved = migrateThemeId(stored) as ModeName | undefined;
  // Own keys only: a saved "constructor" or "toString" must not pass as a mode (audit css-R14).
  current = saved && Object.hasOwn(MODES, saved) ? saved : DEFAULT_MODE;
  // A pick saved under an old palette id is written back under the new one.
  if (saved !== stored && saved === current) setPref("theme", current);
  // The head inline script already set the attribute pre-paint; this corrects it if stale.
  document.documentElement.dataset.theme = current;
}

