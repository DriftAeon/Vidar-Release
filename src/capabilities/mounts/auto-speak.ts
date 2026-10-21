/* Auto-speak capability: the bottom-bar switch (panels/autospeak.ts). Depends on
   speak, so the registry mounts it after speak and disposes it first; the API is read through
   use() at each reply rather than captured, so it never holds a withdrawn speak. */
import { initAutoSpeak } from "../../panels/autospeak";
import type { SpeakApi } from "../../panels/speak";
import type { CapabilityCtx, Dispose } from "../registry";

export function mount(host: HTMLElement, ctx: CapabilityCtx): Dispose {
  void initAutoSpeak(host, () => ctx.use<SpeakApi>("speak"), ctx.signal);
  return () => {};
}
