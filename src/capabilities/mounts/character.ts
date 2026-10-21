/* Character capability: the left bar character panel
   (panels/character.ts), on while at least one pack is listed, any status (`characters` fact,
   facts.ts); a bad pack shows the panel's own "Fix It In Settings › Characters" placeholder.
   Adding the first pack in Settings › Characters re-diffs and mounts it without a restart.
   No stop(): nothing outlives the panel's own Dispose. */
import { initCharacter } from "../../panels/character";
import type { CapabilityCtx, Dispose } from "../core";

export function mount(host: HTMLElement, _ctx: CapabilityCtx): Dispose {
  return initCharacter(host);
}
