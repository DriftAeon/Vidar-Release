// src\onboarding\step-runes.ts — onboarding step 6, First Runeset (variant A, Runes Tab As Is): the Runes
// tab's own Bare view, opened on Local Files for the primary agent's Rendered Bare row and the step 3
// workspace (else the Home folder). One row only: set-attach cannot attach a library to other rows.
// No Rendered Bare row for the primary: the step skips itself. Next is always enabled; Skip is the shell's.
import { resolveDefaultCwd } from "../config";
import { effectivePrimary } from "../agents/primary";
import { shownRoots, shownVariants } from "../launcher/roster";
import { codexModelsReady, genModels } from "../panels/runes";
import { createBareIo } from "../runes/bare/io";
import { rowGenerating } from "../runes/bare/flow";
import { mountBareView } from "../runes/bare/view";
import { STEP_ORDER } from "./progress";
import { renderedBareKey } from "./runes-row";
import { registerStep, type StepCtx } from "./steps";

// not a quoted bare literal: tests/paths-contract counts those
const RUNES = STEP_ORDER[5];

// the row this step last mounted for; the run state itself lives in flow.ts (`running`)
let mountedRow: string | null = null;

/** True while a generate started from this step is running. W6 reads it so Finish opens the Runes tab on that run. */
export function runeRunGoing(): boolean {
  return rowGenerating(mountedRow);
}

registerStep({
  id: RUNES,
  title: "First Runeset",
  mount(body: HTMLElement, ctx: StepCtx) {
    let disposed = false;
    let dispose = (): void => {};
    const skip = (): void => { queueMicrotask(() => { if (!disposed) ctx.next(); }); };
    void (async () => {
      const agent = effectivePrimary();
      const rowKey = renderedBareKey(shownRoots().flatMap((r) => shownVariants(r)), agent);
      const cwd = ctx.progress.workspace ?? (await resolveDefaultCwd());
      if (disposed) return;
      if (!agent || !rowKey || !cwd) { skip(); return; }
      mountedRow = rowKey;
      const host = document.createElement("div");
      host.className = "ob-runes";
      body.appendChild(host);
      const handle = mountBareView(
        host,
        { agent, rowKey, cwd, profile: "bare", gen: () => genModels(agent), modelsReady: codexModelsReady(agent), start: "files" },
        createBareIo(),
      );
      dispose = () => { handle.dispose(); host.remove(); };
    })().catch((e) => { console.error(`first runeset step failed: ${String(e)}`); skip(); });
    return () => { disposed = true; dispose(); };
  },
});
