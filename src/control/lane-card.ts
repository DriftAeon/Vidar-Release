// src\control\lane-card.ts — the value strings the `ctl.spawn`/`ctl.prompt` cards show for
// a first prompt and a lane subscription (listen.ts builds the cards). Pure formatting.

import { DASH } from "../format";

/** The spawn card's Text row, and the Flow approval's Request row: the whole text, never cut.
 *  An approval card shows exactly the bytes that will be sent or run;
 *  the card's value area scrolls (`.ask-value`, `.nm-pre`) instead. */
export function cardText(text: string): string {
  return text;
}

/** One "Reports To" row (where the result goes, then the report path), or none when notify is off:
 *  the card stays lean, no Off/dash rows (2026-10-10). */
export function laneRows(notify: boolean, report: string | null, deliverTo: string | null): [string, string][] {
  if (!notify) return [];
  const value = [deliverTo, report].filter((v): v is string => !!v).join(" · ");
  return [["Reports To", value || DASH]];
}
