// src\runes\bare\attach-card.ts — View's skill, agent, hook and MCP server rows as the summary of a `details.rp-item`
// that opens to the rune card's opened body (cards.ts `openedBody`). A skill's or agent's file is read on first open
// (`io.readText`) and kept by path, so a repaint opens without a second read.
import { fillCard, lazyBody, openedBody, type CardCtx } from "../cards";
import { el } from "./agent-view";
import { itemRune, skillFile, type ItemSpec } from "./attach-meta";

/** What a row needs to open: the file reader, the card's actions, the library's scope name and the view's open-state hook. */
export interface ItemCtx {
  readText?: (path: string) => Promise<string>;
  card: CardCtx;
  scope: string;
  trackOpen(det: HTMLDetailsElement, key: string, dflt: boolean): void;
}

const texts = new Map<string, string>();
const reading = new WeakSet<HTMLDetailsElement>();

/** `sum` (the row, already built) becomes the summary of a closed-by-default details tracked under `key`. */
export function itemDetails(sum: HTMLElement, spec: ItemSpec, key: string, c: ItemCtx): HTMLDetailsElement {
  const det = el("details", "rp-item");
  const draw = (text: string | null): HTMLElement => {
    const { rune, opts } = itemRune(spec.kind === "skill" || spec.kind === "agent" ? { ...spec, text } : spec, c.scope);
    return openedBody(rune, c.card, opts);
  };
  const file = spec.kind === "skill" ? skillFile(spec.path) : spec.kind === "agent" ? spec.path : "";
  lazyBody(det, () => {
    if (!file || !c.readText) return draw(null);
    const hit = texts.get(file);
    if (hit !== undefined) return draw(hit);
    if (!reading.has(det)) {
      reading.add(det);
      c.readText(file).then((t) => { texts.set(file, t.replace(/^﻿/, "")); reading.delete(det); fillCard(det); }, (e: unknown) => {
        reading.delete(det);
        if (det.childElementCount === 1) det.appendChild(el("div", "rp-error", `This file could not be read: ${String((e as { message?: string })?.message ?? e)}`));
      });
    }
    return null;
  });
  det.appendChild(sum);
  c.trackOpen(det, key, false);
  return det;
}
