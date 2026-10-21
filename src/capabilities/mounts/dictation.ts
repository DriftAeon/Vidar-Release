/* Dictation capability: the push-to-talk chord (voice.ts), moved out of
   main.ts's eager init. A hostless service: on unless the overlay switches it off (`when: {}`;
   `whisper` is not a gate, because transcriber.command is user-configurable). The pill stays in
   the bottom bar's markup and is only driven from here.
     - initVoice checks the signal after each await, so an early switch-off never re-binds the
       chord or leaks the `voice-hotkey` listener;
     - dispose removes the settings rows and the shortcut, re-homes the pill and stops the pane
       observer; the stop (stops/dictation.ts) ends a live take and unbinds the chord.
   Provides "dictation" -> { voice }: the live VoiceCfg its settings rows edit. No `voice` block
   in vidar.json (the browser mock): nothing starts, nothing is provided. */
import { initVoice, type VoiceCfg } from "../../voice";
import type { CapabilityCtx, Dispose } from "../core";

export interface DictationApi {
  voice: VoiceCfg;
}

/** Switched off by a diff: the same body as the launch stop. */
export { stop } from "../stops/dictation";

export function start(ctx: CapabilityCtx): Dispose {
  const voice = ctx.cfg.voice;
  if (!voice) return () => {};
  ctx.provide("dictation", { voice } satisfies DictationApi);
  return initVoice(voice, ctx.signal);
}
