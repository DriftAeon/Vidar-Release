// AskUserQuestion answers as shown in an answered Ask pill (replaces the raw tool-result text),
// plus the "(Recommended)" star label shared with the question form.

import { iconImg } from "../../icon-img";
import { el } from "./dom";

const RECOMMENDED = /\s*\(\s*recommended\s*\)\s*$/i;

/** a label minus a trailing "(Recommended)"; `starred` says whether one was dropped */
export function splitRecommended(label: string): { shown: string; starred: boolean } {
  const shown = label.replace(RECOMMENDED, "");
  return { shown, starred: shown !== label };
}

/** an option label as shown: a star before the label when it ends "(Recommended)", the suffix dropped */
export function askLabel(label: string): HTMLElement {
  const { shown } = splitRecommended(label);
  const lead = el("span", "q-label");
  lead.append(el("b", undefined, shown));
  // trailing, so a starred title starts where the others do (2026-10-05)
  if (shown !== label) {
    const star = iconImg("star");
    star.title = "Recommended";
    lead.append(star);
  }
  return lead;
}

const PAIR = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;

/** the `"question"="answer"` pairs of the tool result text; empty when none parse */
function parseAskAnswers(content: string): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = [];
  for (const m of content.matchAll(PAIR)) out.push({ q: m[1].replace(/\\(.)/g, "$1"), a: m[2].replace(/\\(.)/g, "$1") });
  return out;
}

/** the answers block, or null when nothing parsed (the caller keeps the raw output) */
export function askAnswersBlock(content: string): HTMLElement | null {
  const pairs = parseAskAnswers(content);
  if (pairs.length === 0) return null;
  const box = el("div", "ask-answers");
  for (const { q, a } of pairs) {
    const row = el("div", "ask-answer");
    if (pairs.length > 1) row.append(el("span", "ask-answer-q", q));
    const val = el("span", "ask-answer-a");
    a.split(/,\s+/).forEach((part, i) => {
      if (i > 0) val.append(", ");
      val.append(askLabel(part));
    });
    row.append(val);
    box.append(row);
  }
  return box;
}
