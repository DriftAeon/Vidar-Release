// Display formatting only: persisted values and executable identifiers stay intact.

import type { AgentPreset } from "./model";

const PRESET_LABELS: Record<AgentPreset, string> = {
  plan: "Plan",
  review: "Review",
  revise: "Revise",
  execute: "Execute",
  "brainstorm-format": "Brainstorm-Format",
  academy: "Academy",
  improve: "Improve",
  custom: "Custom",
};

/** Display label for an `AgentPreset` (the palette's preset picker, and the inspector's
 *  read-only `preset` field, §2/§3/§5) — matches the approved mock's exact casing
 *  ("Brainstorm-Format", not "Brainstorm-format"). */
export function presetLabel(preset: AgentPreset): string {
  return PRESET_LABELS[preset] ?? preset;
}

export function fieldLabel(key: string): string {
  if (key.toLowerCase() === "cwd") return "Working Directory";
  return key.replace(/-/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export function fieldValue(key: string, value: string): string {
  const names: Record<string, Record<string, string>> = {
    model: { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" },
    effort: { low: "Low", medium: "Medium", high: "High" },
    permission: { "read-only": "Read Only" },
    event: { "note added": "Note Added" },
    scope: { "diff, low": "Diff, Low" },
  };
  return names[key.toLowerCase()]?.[value.toLowerCase()] ?? value;
}

export function nodeSubtitle(value: string): string {
  if (value === "inbox note") return "Inbox Note";
  if (value === "ready-to-commit") return "Ready to Commit";
  return value.replace(/\b(sonnet|opus|haiku)\b/g, (model) => fieldValue("model", model));
}
