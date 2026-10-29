// The Modify switch's state policy, shared by ordinary and On Demand rune cards.
import { label } from "../../format";

export type RuneState = "off" | "on" | "shadow";

export interface StatefulRune { on: boolean; state?: RuneState; required?: boolean; addable?: boolean }

export const REQUIRED_TIP = "Required: can't be turned off or shadowed in any set.";
export const SHADOW_TIP = "Shadow: listed in the launch manifest, not loaded.";

export const runeState = (rune: StatefulRune, overrideOff = false): RuneState =>
  rune.required ? "on" : overrideOff ? "off" : rune.state ?? (rune.on ? "on" : "off");

export const nextRuneState = (state: RuneState, addable = false): RuneState =>
  state === "off" ? "on" : state === "on" && !addable ? "shadow" : "off";

export const stateLabel = (state: RuneState): string => `State: ${label(state)}`;

export const stateTooltip = (state: RuneState, required = false, extra = ""): string =>
  required ? REQUIRED_TIP : extra === "Generating…" ? extra : state === "shadow" ? SHADOW_TIP :
    `${state === "on" ? "On" : "Off"}${state === "off" && extra ? `\n${extra}` : ""}`;

export const stateDisabled = (rune: StatefulRune, locked = false): boolean => locked || !!rune.required;
