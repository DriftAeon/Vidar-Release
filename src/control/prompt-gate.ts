// src\control\prompt-gate.ts — which refusal `ctl.prompt` owes a target tab, if any.
// A tab that can never take a prompt (closed, raw/PTY) must not read as "not ready":
// that wording invites polling. Only a rendered tab that is not promptReady is retryable.

export type PromptTabs = { id: string; body: string }[];

/** Refusal line for a target that can never accept (checked before the card is minted), else null. */
export function promptTargetRefusal(tabs: PromptTabs, tab: string): string | null {
  const target = tabs.find((t) => t.id === tab);
  if (!target) return `err no tab "${tab}"`;
  if (target.body !== "rendered") return "err raw tab";
  return null;
}

/** Refusal line at delivery time: the target check again (the tab may have closed while the
 *  card was open), then the retryable "err tab not ready". */
export function promptDeliveryRefusal(tabs: PromptTabs, tab: string, ready: (tab: string) => boolean): string | null {
  return promptTargetRefusal(tabs, tab) ?? (ready(tab) ? null : "err tab not ready");
}
