// Slash commands the TUI answers locally and never sends to the model. In a rendered body they
// used to reach the SDK as prose. One table for both entry points — the right panel's Model select
// goes through body.write(), a typed command through submit() — so the two cannot drift.

import { EFFORT_LEVELS } from "../../agents/protocol";
import type { Effort } from "../../agents/protocol";
import { label } from "../../format";
import { AGENT_PROFILE } from "../../agents/agent-profile";
import type { RenderedOpts } from "./opts";

export interface LocalCommandDeps {
  opts: RenderedOpts;
  noticeBlock: (text: string, level: "info" | "warn" | "error") => void;
  pickModelMenu: () => void;
  setModel: (want: string) => void;
  bar: { pickEffortMenu(): void; setEffort(level: Effort): void };
}

/** Returns a function that is true when the text was consumed as a local command. */
export function createLocalCommand({ opts, noticeBlock, pickModelMenu, setModel, bar }: LocalCommandDeps): (text: string) => boolean {
  return (text) => {
    // a body cannot resume itself — Rust refuses a resume of a live session —
    // so this hands the past-session list to the launcher; a pick is a new tab
    // and this body keeps running, queued messages and all.
    if (text === "/resume" && AGENT_PROFILE[opts.agent].resumeCommand) {
      if (opts.resumeNotice) noticeBlock(opts.resumeNotice, "info"); else opts.onResume();
      return true;
    }
    if (!AGENT_PROFILE[opts.agent].localCommands) return false;
    // raw /model is a picker whose pick changes the model; pickModelMenu is
    // the same thing over the agent's own model list, ending in set_model.
    if (text === "/model") { pickModelMenu(); return true; }
    const m = /^\/model\s+(\S+)$/.exec(text);
    if (m) { setModel(m[1]); return true; }
    // every /effort is ours: the SDK's own /effort writes the user's global settings.json
    if (/^\/effort\b/.test(text)) {
      const arg = text.slice(7).trim().toLowerCase();
      if (!arg) bar.pickEffortMenu();
      else if ((EFFORT_LEVELS as readonly string[]).includes(arg)) bar.setEffort(arg as Effort);
      else noticeBlock(`Effort Takes ${EFFORT_LEVELS.map((l) => label(l)).join(", ")}`, "info");
      return true;
    }
    return false;
  };
}
