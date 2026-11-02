// The typed error voice_register rejects with (src-tauri voice.rs HotkeyError): a reason plus the chord.
// Pure, no imports, so `node --test` loads it directly; voice-hotkey-popup.ts draws it.

export interface HotkeyError {
  reason: "taken" | "invalid";
  chord: string;
}

/** The typed error from a rejected voice_register, or null for any other rejection. */
export function asHotkeyError(e: unknown): HotkeyError | null {
  if (!e || typeof e !== "object") return null;
  const { reason, chord } = e as { reason?: unknown; chord?: unknown };
  if ((reason !== "taken" && reason !== "invalid") || typeof chord !== "string") return null;
  return { reason, chord };
}

/** The popup's head, Title Case, naming the chord. */
export function hotkeyHead(e: HotkeyError): string {
  return e.reason === "taken" ? `Hotkey ${e.chord} Is Taken` : `Hotkey ${e.chord} Is Invalid`;
}

/** The popup's one-line note, sentence case. */
export function hotkeyNote(e: HotkeyError): string {
  return e.reason === "taken" ? "Another app is already using this hotkey." : "Windows cannot bind this hotkey.";
}

/** One sentence for the Settings row's inline error. */
export function hotkeyLine(e: HotkeyError): string {
  return e.reason === "taken" ? `Another app is already using ${e.chord}.` : `${e.chord} is not a valid hotkey.`;
}
