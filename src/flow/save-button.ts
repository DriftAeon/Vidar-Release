// Save: the toolbar button left of Tidy that writes the canvas's unsaved template instance into
// the User list (store.ts's `saveDraft`, which names it clear of the stored names). Enabled only
// while a draft is on the canvas: a User graph already saves itself on every edit. Mounting it
// is panels/flow.ts's job.

import { iconImg } from "../icon-img";
import type { FlowGraph } from "./model";
import { activeDraft, saveDraft } from "./store";

/** `refresh` re-reads whether a draft is on the canvas; call it after every graph switch. */
export interface SaveButton {
  el: HTMLButtonElement;
  refresh: () => void;
}

/** Shares `.flow-tidy-btn`'s look via its sibling selector list (flow.css). `onSaved` lets the
 *  panel refresh the picker once the graph joined the User list. */
export function buildSaveButton(onSaved?: (graph: FlowGraph) => void): SaveButton {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "flow-save-btn icon-btn";
  btn.setAttribute("aria-label", "Save");
  btn.appendChild(iconImg("save-disc"));
  btn.title = "Save";

  const refresh = () => {
    btn.disabled = !activeDraft();
  };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const graph = saveDraft();
    refresh();
    if (graph) onSaved?.(graph);
  });

  refresh();
  return { el: btn, refresh };
}
