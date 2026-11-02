// The Modify switch's state policy, shared by ordinary and On Demand rune cards.
import { label } from "../../format";

export type RuneState = "off" | "on" | "shadow";

export interface StatefulRune { on: boolean; state?: RuneState; required?: boolean }

export const REQUIRED_TIP = "Required: can't be turned off or shadowed in any set.";
export const SHADOW_TIP = "Shadow: listed in the launch manifest, not loaded.";

export const nextRuneState = (state: RuneState): RuneState =>
  state === "off" ? "on" : state === "on" ? "shadow" : "off";

export const stateLabel = (state: RuneState): string => `State: ${label(state)}`;

export const stateTooltip = (state: RuneState, required = false, extra = ""): string =>
  required ? REQUIRED_TIP : extra === "Generating…" ? extra : state === "shadow" ? SHADOW_TIP :
    `${state === "on" ? "On" : "Off"}${state === "off" && extra ? `\n${extra}` : ""}`;

export const stateDisabled = (rune: StatefulRune, locked = false): boolean => locked || !!rune.required;
