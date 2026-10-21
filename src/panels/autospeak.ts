/* Auto-speak: a second switch in the bottom bar, next to the
   close lock, modelled on it exactly — global to the window, off by default.
   On means each new completed assistant reply landing in the FOCUSED Claude or Codex
   Rendered tab is read aloud, via the existing speak button's arm/read
   machinery (panels/speak.ts) — this module never talks to speak_last or
   speak_arm itself. The file bridge\auto-speak.json is the only truth (read
   on mount, written on every flip), the same shape as close-lock.json.

   sessions.ts dispatches `vidar-reply-done` (panels/reply-events.ts) from
   RenderedOpts.onReplyDone (rendered.ts) with the tab id and agent kind; replay
   never fires it. This listener only acts when the switch is on, the reply's tab
   is the one focused right now (Claude or Codex), never a background tab. Mounted by the capability registry (capabilities/mounts/auto-speak.ts),
   which mounts it only after speak, so the speak API is there while it is mounted. */
import { initSwitch } from "./toggle-switch";
import { getActiveSessionId } from "./sessions";
import { openVoiceMap } from "./voice-map";
import type { ReplyDoneDetail } from "./reply-events";
import type { SpeakApi } from "./speak";

export async function initAutoSpeak(host: HTMLElement, speak: () => SpeakApi | null, signal?: AbortSignal) {
  // The glyph left of the switch is the press-to-read #speak-btn itself, a sibling in
  // #speak-group (index.html), not in this label.
  const sw = await initSwitch(host, {
    name: "auto-speak",
    label: "Auto-speak",
    titles: { on: "Auto-Speak Replies", off: "Auto-Speak Off" },
    signal,
  });

  // RMB has no other behaviour here (unlike mic/speaker) — free for the voice-map popup.
  host.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openVoiceMap(host);
  }, { signal });

  document.addEventListener("vidar-reply-done", (ev) => {
    if (!sw.isOn()) return; // live state, not the value read at mount
    const { id, cwd, agent, profile } = (ev as CustomEvent<ReplyDoneDetail>).detail;
    if (id !== getActiveSessionId()) return;
    speak()?.autoSpeak({ cwd, agent, tab: id, profile: profile ?? null });
  }, { signal });
}
