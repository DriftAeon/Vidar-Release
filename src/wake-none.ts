/* The Wake Word setting's "None" pick: `wakeword.model` holds this value (src-tauri listen.rs
   WAKE_NONE), Listen never starts, and no mic is held for wake detection. */

export const WAKE_NONE = "none";

/** True when the saved wake model asks for a wake listener at all. */
export function wakeActive(model: string | undefined): boolean {
  return model !== WAKE_NONE;
}
