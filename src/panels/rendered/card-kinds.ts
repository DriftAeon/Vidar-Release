// The Rendered-tab card kinds (the chain segments and pills) as data, for the Settings Cards page.
// Colour is not stored here: it stays in styles/rendered-chain.css (--chain-tc per data-tool-class).
// The icon comes from `sample` through chain.ts's own icon lookup. A later editable icon/colour
// layers over these entries by `cls`; this list stays the defaults. Value-import-free (node tests
// load it directly); tests/card-kinds.test.mjs keeps the tool lists in step with tool-class.ts.

import type { ToolClass } from "./tool-class";

export interface CardKind {
  cls: ToolClass;
  /** Title Case name shown on the Settings row and its sample segment */
  label: string;
  /** wire names (claude and codex tables of tool-class.ts) that draw this kind; empty for "other" */
  tools: readonly string[];
  /** a tool name whose icon represents the kind */
  sample: string;
}

export const CARD_KINDS: readonly CardKind[] = [
  { cls: "read", label: "Read", tools: ["Read"], sample: "Read" },
  { cls: "search", label: "Search", tools: ["Grep", "Glob"], sample: "Grep" },
  { cls: "edit", label: "Edit", tools: ["Edit", "MultiEdit", "Write", "NotebookEdit"], sample: "Edit" },
  { cls: "run", label: "Run", tools: ["Bash", "PowerShell", "Command"], sample: "Bash" },
  { cls: "web", label: "Web", tools: ["WebFetch", "WebSearch"], sample: "WebFetch" },
  { cls: "ask", label: "Ask", tools: ["AskUserQuestion"], sample: "AskUserQuestion" },
  { cls: "agent", label: "Agent", tools: ["Agent", "Task", "SendMessage", "Wait", "CloseAgent", "InterruptAgent", "ListAgents"], sample: "Agent" },
  { cls: "think", label: "Thought", tools: ["Thought", "ToolSearch"], sample: "Thought" },
  { cls: "other", label: "Other", tools: [], sample: "Other" },
];
