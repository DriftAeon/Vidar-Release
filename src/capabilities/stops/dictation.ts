/* Dictation stop: runs at launch when dictation ends up off, and on a live
   switch-off (mounts/dictation.ts re-exports it). A discard voice_stop first: a switch-off or
   reload mid-hold leaves no release to end the take, so the mic would stay open and listen stay
   paused (voice_start paused it); with discard, voice.rs returns before reading the transcriber
   and resumes listen. "not recording" is the normal answer. Then the chord is unbound, so the
   global hotkey does nothing while dictation is off. No UI here. */
import { invoke } from "../../ipc";

const DISCARD = { prompt: "", discard: true };

export async function stop(): Promise<void> {
  try {
    await invoke("voice_stop", DISCARD);
  } catch {
    // not recording
  }
  try {
    await invoke("voice_register", { chord: "" });
  } catch (e) {
    console.error("dictation stop:", e);
  }
}
