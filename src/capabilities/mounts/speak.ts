/* Speak capability: the press-to-read button (panels/speak.ts). Host is
   #speak-group, which also holds auto-speak's switch; the button is a child, so its own
   glyph is cleared here (the registry restores only the host's direct children).
   Provides "speak" (SpeakApi) to auto-speak and the voice map. */
import { initSpeak } from "../../panels/speak";
import type { CapabilityCtx, Dispose } from "../registry";

/** Switched off by a diff (dependency lost, overlay off): the same body as the launch stop, so a
 *  Vidar-armed sidecar does not stay up without a control and a CLI one survives. */
export { stop } from "../stops/speak";

export function mount(host: HTMLElement, ctx: CapabilityCtx): Dispose {
  const btn = host.querySelector<HTMLButtonElement>("#speak-btn");
  if (!btn) throw new Error("#speak-group has no #speak-btn");
  ctx.provide("speak", initSpeak(btn, ctx.signal));
  return () => btn.replaceChildren();
}
