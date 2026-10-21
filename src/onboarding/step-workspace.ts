// src\onboarding\step-workspace.ts — onboarding step 3, Workspace (mock primary-agent-variants A, frames 5
// and 6). One green Add Workspace button opens the folder picker (pickWorkspace saves the folder, or reuses
// it when it is already a workspace). Next stays off until a folder is added; Skip is the shell's. The pick
// is written to the progress record so a resume at a later step keeps its cwd.
import { folderName, pickWorkspace } from "../launcher/workspaces";
import { registerStep, type StepCtx } from "./steps";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

registerStep({
  id: "workspace",
  title: "Workspace",
  mount(body: HTMLElement, ctx: StepCtx) {
    const root = el("div", "ob-workspace");
    body.appendChild(root);
    let picked: string | null = ctx.progress.workspace ?? null;
    let busy = false;
    let error = "";
    let disposed = false;

    function paint(): void {
      if (disposed) return;
      root.replaceChildren();
      ctx.setNextEnabled(picked !== null);
      if (picked) {
        const row = el("div", "ob-ws-row");
        row.append(el("span", "ob-ws-name", folderName(picked)), el("span", "ob-ws-path ob-mono", picked));
        root.append(row);
      }
      const add = el("button", "ws-btn ws-add ob-btn ob-big", "Add Workspace");
      add.type = "button";
      add.disabled = busy;
      add.addEventListener("click", pick);
      root.append(add);
      if (error) root.append(el("div", "ob-error", error));
    }

    function pick(): void {
      if (busy) return;
      busy = true;
      error = "";
      paint();
      pickWorkspace().then(
        (loc) => {
          busy = false;
          if (disposed) return;
          if (loc) {
            picked = loc.cwd;
            ctx.setProgress({ workspace: loc.cwd });
          }
          paint();
        },
        (e: unknown) => {
          console.error(`workspace pick failed: ${String(e)}`);
          busy = false;
          if (disposed) return;
          error = `Not Added: ${String(e)}`;
          paint();
        },
      );
    }

    paint();
    return () => { disposed = true; };
  },
});
