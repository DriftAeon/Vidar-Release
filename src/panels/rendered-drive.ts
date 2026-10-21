// Pure mapping for the drive hook's card snapshot (rendered.ts `drive()`).
// Kept separate from the DOM so the shape the driver sees is unit-testable;
// the caller adapts real `.blk-approval` elements to `CardLike`.

/** Class names on the approval card that the drive surface keys on: rendered.ts
 *  builds the card with them, drive/drive.ts clicks through them, and rendered.ts's
 *  `drive()` snapshot reads them. Byte-for-byte the DOM contract that
 *  tools\drive\vidar-drive.mjs `click`/`text` selectors and smoke briefs rely on;
 *  styles.css repeats them as literals. */
export const DRIVE_CLASS = {
  card: "blk-approval",
  settled: "settled",
  question: "q",
  option: "q-opt",
  allow: "approval-allow",
  deny: "approval-deny",
  message: "approval-msg",
  result: "approval-result",
} as const;

/** The smallest shape the snapshot needs: the two dataset fields, the
 *  per-question option labels, and the settlement result text. */
export type CardLike = {
  /** `data-request-id`; absent/unset reads as "". */
  requestId?: string | null;
  /** `data-tool`; absent/unset reads as "". */
  tool?: string | null;
  /** One entry per `.q`, each holding its `.q-opt` labels (`data-label`, else
   *  text: the visible text also carries the description). A non-question
   *  approval card has none. */
  questions?: readonly (readonly (string | null | undefined)[])[];
  /** `.approval-result` text; absent reads as null (still pending). */
  result?: string | null;
};

export type CardSnapshot = {
  id: string;
  tool: string;
  options: string[][];
  settled: string | null;
};

export function cardSnapshot(card: CardLike): CardSnapshot {
  return {
    id: card.requestId ?? "",
    tool: card.tool ?? "",
    options: (card.questions ?? []).map((q) => q.map((label) => label ?? "")),
    settled: card.result ?? null,
  };
}

export function cardsSnapshot(cards: readonly CardLike[]): CardSnapshot[] {
  return cards.map(cardSnapshot);
}
