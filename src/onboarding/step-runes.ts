// Onboarding step 6 opens local source discovery for the primary agent.
import { resolveDefaultCwd } from "../config";
import { effectivePrimary } from "../agents/primary";
import { codexModelsReady, genModels } from "../panels/runes";
import { createBareIo } from "../runes/bare/io";
import { generating } from "../runes/bare/flow";
import { mountBareView } from "../runes/bare/view";
import { STEP_ORDER } from "./progress";
import { registerStep, type StepCtx } from "./steps";

// not a quoted bare literal: tests/paths-contract counts those
const RUNES = STEP_ORDER[5];

/** True while a generate started from this step is running. W6 reads it so Finish opens the Runes tab on that run. */
export function runeRunGoing(): boolean {
  return generating();
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
      const cwd = ctx.progress.workspace ?? (await resolveDefaultCwd());
      if (disposed) return;
      if (!agent || !cwd) { skip(); return; }
      const host = document.createElement("div");
      host.className = "ob-runes";
      body.appendChild(host);
      const handle = mountBareView(
        host,
        { agent, cwd, profile: "bare", gen: () => genModels(agent), modelsReady: codexModelsReady(agent), start: "files" },
        createBareIo(),
      );
      dispose = () => { handle.dispose(); host.remove(); };
    })().catch((e) => { console.error(`first runeset step failed: ${String(e)}`); skip(); });
    return () => { disposed = true; dispose(); };
  },
});
