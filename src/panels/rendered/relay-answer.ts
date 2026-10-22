// A Relay answer reaches the agent as a user message in a fixed wire form (src/relay/source-asks.ts,
// pinned by tests/relay-ask-source.test.mjs). The model keeps that text; the transcript draws it as an
// answered-Ask block (the .ask-answer look): the pick in bold over the comment, no label.

import { el } from "./dom";
import { labelledMark } from "./marks";
import { askLabel } from "./ask-answers";

const JSON_STR = String.raw`null|"(?:[^"\\]|\\.)*"`;
const WIRE = new RegExp(String.raw`^Answer to pending question [0-9a-f]{8}: choice=(${JSON_STR}) comment=(${JSON_STR})$`);

export interface RelayAnswer { choice: string | null; comment: string | null }

export function parseRelayAnswer(text: string): RelayAnswer | null {
  const m = WIRE.exec(text.trim());
  if (!m) return null;
  try {
    const choice: unknown = JSON.parse(m[1]);
    const comment: unknown = JSON.parse(m[2]);
    if ((choice !== null && typeof choice !== "string") || (comment !== null && typeof comment !== "string")) return null;
    return { choice, comment };
  } catch {
    return null;
  }
}

export function relayAnswerBlock(a: RelayAnswer): HTMLElement {
  const host = el("div", "blk blk-user blk-relay-answer");
  // the answered-Ask badge (green ? bubble) as a prefix, so the block reads as the user's answer
  // and not as a bare line of text (2026-10-05)
  const badge = el("span", "tool-badge");
  badge.append(labelledMark("answered", "Relay Answer", "awaiting")); // a green "?"
  host.append(badge);
  const row = el("div", "ask-answer");
  if (a.choice) {
    const pick = el("span", "ask-answer-a");
    // the answered-Ask look: "(Recommended)" drawn as the trailing star, as askAnswersBlock does
    pick.append(askLabel(a.choice));
    row.append(pick);
  }
  if (a.comment) row.append(el("span", "ask-answer-a relay-answer-comment", a.comment));
  host.append(row);
  return host;
}
