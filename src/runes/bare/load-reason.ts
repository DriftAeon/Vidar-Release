// The one line a vault card's tooltip carries to say why a rune loaded or not.
// First match wins: not carried, off, at start, then what the transcript read shows for a path, recall or
// procedure rune. Not carried and off are known without a session; every other line needs a loads result, and
// none yet means no line.
import { parseNotCarried } from "../not-carried";
import type { RunesLoaded } from "../types";
import { readKeys, readSet, wasRead } from "./on-demand-loads";
import type { RuneState } from "./rune-state";

export interface ReasonRune { id: string; kind?: string; activate: string; recall?: boolean; paths?: string[] }

/** Ids of the runes the launch warnings say this agent does not carry. */
export const notCarriedIds = (warnings: readonly string[] = []): Set<string> =>
  new Set(warnings.map((w) => parseNotCarried(w)?.id).filter((id): id is string => !!id));

/** Whether the transcript shows this rune read (its `vidar-runes/<id>.md` copy). */
export const runeWasRead = (loads: RunesLoaded | null | undefined, id: string): boolean =>
  !!loads && wasRead(readSet(readKeys(loads)), { id, path: "" });

const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function loadReason(r: ReasonRune, o: {
  state: RuneState; notCarried?: ReadonlySet<string>; loads?: RunesLoaded | null; read?: boolean;
}): string | null {
  if (o.notCarried?.has(r.id)) return "Not Loaded: Not Carried by This Agent";
  if (o.state === "off") return "Not Loaded: Off in This Vault";
  if (!o.loads) return null;
  const onPath = r.activate === "paths" || !!r.paths?.length;
  if (r.activate === "always" && !r.recall && !onPath) return "Loaded: At Start";
  const procedure = r.kind === "procedure";
  if (!r.recall && !onPath && !procedure && r.activate !== "recall") return null;
  if (!(o.read ?? runeWasRead(o.loads, r.id))) return "Not Loaded: Pointer Line Only";
  if (onPath) {
    const t = o.loads.runeTriggers?.[r.id];
    return t ? `Loaded: On Path (${base(t)})` : "Loaded: On Path";
  }
  return procedure ? "Loaded: On Invoke" : "Loaded: On Recall";
}
