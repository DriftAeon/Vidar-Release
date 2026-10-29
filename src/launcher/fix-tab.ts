// The fix tab behind a notice card's Ask Agent to Fix button: a Rendered Claude tab in the warned
// folder with the prompt placed unsent in its composer (LaunchOpts.draft); the user presses Enter.
// Nothing here writes to a session: a write would submit on a trailing CR.

import type { AgentType } from "../config";
import type { FixOpener, FixRequest } from "../panels/rendered/fix-seam";
// @ts-ignore TS5097: node --test loads this pure module directly
import { isAgentId, type AgentId } from "../agents/id.ts";

const canFix: Record<AgentId, boolean> = { claude: true, codex: false };

/** Control characters out of anything the prompt quotes: a warning or path never injects a line or a `!`. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The composer text. It opens with "Vidar", never `!` (bang.ts would run it as a shell line). */
export function fixPrompt(req: FixRequest): string {
  const label = clean(req.agentLabel);
  const folder = clean(req.folder);
  const warning = clean(req.warning);
  return `Vidar showed this warning when it opened a Rendered ${label} tab in ${folder}: "${warning}" Find out what causes it and fix it. Tell me what you'll change before you change anything.`;
}

/** The first shown row that is Rendered Claude without a role (the `claude-rendered-bare` child). */
export function findFixRow(roots: readonly AgentType[], variantsOf: (root: AgentType) => readonly AgentType[]): AgentType | null {
  const fits = (a: AgentType) => isAgentId(a.id) && canFix[a.id] && a.body === "rendered" && !a.role;
  for (const root of roots) {
    if (fits(root)) return root;
    const hit = variantsOf(root).find(fits);
    if (hit) return hit;
  }
  return null;
}

export interface FixDeps {
  roots: () => readonly AgentType[];
  variants: (root: AgentType) => readonly AgentType[];
  spawn: (t: AgentType, loc: { label: string; cwd: string }, title?: string, resume?: string, draft?: string, onAdopted?: (ok: boolean, reason?: string) => void) => Promise<string>;
  toast: (message: string) => void;
}

/** The opener main.ts registers on the notice-card seam. */
export function createFixOpener(deps: FixDeps): FixOpener {
  const row = () => findFixRow(deps.roots(), deps.variants);
  return {
    available: () => row() !== null,
    async open(req) {
      const found = row();
      if (!found) throw new Error("Claude isn't in the launcher");
      let failure: string | null = null;
      const onAdopted = (ok: boolean, reason?: string) => {
        if (ok) return;
        failure = reason || "The fix tab did not start";
        deps.toast(failure);
      };
      // The row's own fields; its cwd is replaced by the warned folder.
      await deps.spawn({ ...found, cwd: undefined }, { label: req.folder, cwd: req.folder }, undefined, undefined, fixPrompt(req), onAdopted);
      // A start failure that settled before createSession returned is the button's error; a later one is the toast alone.
      if (failure) throw new Error(failure);
    },
  };
}
