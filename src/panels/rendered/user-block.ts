// Which block a user prompt draws as: a Relay answer, a /catapult hop row, or the plain text row.

import { el } from "./dom";
import { parseRelayAnswer, relayAnswerBlock } from "./relay-answer";
import { parseCatapult, catapultBlock } from "./catapult-block";
import { iconImg } from "../../icon-img";

// Same string as MARK in src/voice-mark.ts; not imported there because that module pulls in panels/sessions (cycle).
const VOICE_MARK = "[Voice] ";

/** Fills `host` with a user prompt's text; a dictated one draws the greyed mic icon in place of the marker (display only). */
export function userText(host: HTMLElement, text: string): void {
  if (!text.startsWith(VOICE_MARK)) {
    host.textContent = text;
    return;
  }
  const mic = iconImg("mic");
  mic.classList.add("voice-mark");
  mic.title = "Voice";
  host.replaceChildren(mic, document.createTextNode(text.slice(VOICE_MARK.length)));
}

export function userBlockFor(text: string): HTMLElement {
  const relay = parseRelayAnswer(text);
  if (relay) return relayAnswerBlock(relay);
  const hop = parseCatapult(text);
  if (hop !== null) return catapultBlock(hop);
  const host = el("div", "blk blk-user");
  userText(host, text);
  return host;
}
