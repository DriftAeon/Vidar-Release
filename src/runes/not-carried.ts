// Parser and renderer for the launch warnings an agent cannot carry. The Rust format is
// `"{kind} {id} Not Carried by {Agent}: {reason}"` (`not_carried` in bare/set_loadout.rs); the contract test
// tests/not-carried-contract.test.mjs pins this file against that format string.
import { AGENTS } from "../agents/descriptor";
import { AGENT_IDS } from "../agents/id";
import { iconImg } from "../icon-img";
import { KINDS } from "./kind-icons";

export interface NotCarried { kind: string; id: string; agent: string; reason: string }

const AGENT_NAMES = AGENT_IDS.map((id) => AGENTS[id].name).join("|");
const LINE = new RegExp(`^(\\S+) (.+?) Not Carried by (${AGENT_NAMES}): ([\\s\\S]*)$`);
const RUNE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** A warning in the Not Carried format whose kind is a rune kind and whose id is a rune id; null otherwise.
 *  `guard` (not a rune), the legacy `outputStyle` spelling, and a `permission` that names a tool or mode
 *  (`mcp__plugin_vidar_drive`, `acceptEdits`) fall through to plain prose. */
export function parseNotCarried(warning: string): NotCarried | null {
  const m = LINE.exec(warning);
  if (!m) return null;
  const [, kind, id, agent, reason] = m;
  if (!Object.hasOwn(KINDS, kind) || !RUNE_ID.test(id)) return null;
  return { kind, id, agent, reason };
}

/** The notice body: kind icon, rune id in mono, then the prose; the plain warning text when it is not a rune line. */
export function notCarriedLine(warning: string): Node[] {
  const p = parseNotCarried(warning);
  if (!p) return [document.createTextNode(warning)];
  const icon = iconImg(KINDS[p.kind].icon);
  icon.title = KINDS[p.kind].name;
  const id = document.createElement("span");
  id.className = "nm-mono";
  id.textContent = p.id;
  return [icon, document.createTextNode(" "), id, document.createTextNode(` Not Carried by ${p.agent}: ${p.reason}`)];
}
