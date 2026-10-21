/* Listen capability: the wake-word mic button (panels/listen.ts), moved
   out of main.ts's eager init. Host is #mic-group, which also holds the auto-send switch; the
   button is a child, so its own glyph is cleared here (the registry restores only the host's direct
   children). Gated on the voice dependency, so the mic is hidden while the voice venv is missing.
   Provides "listen" (ListenApi) to the voice map. Whisper settings come from dictation's live
   VoiceCfg when it is on, else from this mount's config. The auto-send switch shows only while
   the mic is not off. No `wakeword` block in vidar.json (the browser mock): a mount failure, so
   the host stays hidden rather than showing an empty button. */
import { initListen } from "../../panels/listen";
import { initAutoSend } from "../../panels/autosend";
import type { DictationApi } from "./dictation";
import type { CapabilityCtx, Dispose } from "../core";

/** Switched off by a diff: the same body as the launch stop. */
export { stop } from "../stops/listen";

export function mount(host: HTMLElement, ctx: CapabilityCtx): Dispose {
  const wakeword = ctx.cfg.wakeword;
  if (!wakeword) throw new Error("no wakeword config");
  const btn = host.querySelector<HTMLButtonElement>("#listen-btn");
  if (!btn) throw new Error("#mic-group has no #listen-btn");
  const sendHost = host.querySelector<HTMLElement>("#auto-send");
  const voice = () => ctx.use<DictationApi>("dictation")?.voice ?? ctx.cfg.voice;
  ctx.provide("listen", initListen(btn, wakeword, voice, ctx.signal, (state) => {
    sendHost?.classList.toggle("hidden", state === "off");
  }));
  if (sendHost) void initAutoSend(sendHost, ctx.signal).catch((e) => console.error("auto-send:", e));
  // Listeners and the Wake Word row go with ctx.signal; the registry restores the host's children.
  return () => {
    btn.replaceChildren();
    // the switch's glyph and track are grandchildren too: a remount would otherwise build a second pair
    sendHost?.replaceChildren();
    sendHost?.classList.add("hidden");
  };
}
