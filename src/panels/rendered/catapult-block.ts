// A `/catapult <handoff path>` prompt (typed, or lane-spawned) draws as one
// compact row with the catapult icon instead of the raw command and path (2026-10-06);
// the path stays on hover. Replayed history reaches here too: claude.ts's echo turns a recorded
// /catapult command back into the same text.

import { el } from "./dom";
import { iconImg } from "../../icon-img";

const CATAPULT = /^\/catapult(?:\s+([\s\S]+))?$/;

/** the args of a `/catapult` prompt ("" when bare), or null for any other text */
export function parseCatapult(text: string): string | null {
  const m = CATAPULT.exec(text.trim());
  return m ? (m[1] ?? "").trim() : null;
}

export function catapultBlock(args: string): HTMLElement {
  const host = el("div", "blk blk-user blk-catapult");
  if (args) host.title = args;
  host.append(iconImg("catapult"), el("span", "", "Catapult"));
  return host;
}
