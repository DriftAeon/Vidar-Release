// One place for the copy of every permission ask that goes through askGate(). A caller passes a
// `kind`; the title (and a placeholder, if the kind needs its own) comes from here, so two cards
// that do different things cannot drift into near-identical hand-rolled titles. The one caller
// questions never come here: ctl.ask lives in Relay (relay/source-ctl-asks.ts), so every kind is registered.

/** The comment-box placeholder every ask shows unless its kind registers its own. */
export const DEFAULT_ASK_PLACEHOLDER = "Additional Info"; // 2026-10-10

export interface AskKind {
  title: string;
  placeholder?: string;
}

export const ASK_KINDS: Record<string, AskKind> = {
  "ctl-prompt": { title: "Type Into Tab" },
  "ctl-spawn": { title: "Open Agent Tab" },
  "ctl-flow": { title: "Run Flow" },
  "review-dispatch": { title: "Type Into Astra" },
  astra: { title: "Open Astra Tab" },
};
