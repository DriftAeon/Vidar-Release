// Tray block annotation: one saved comment per block, edited under the block's content with
// Save / Cancel. Save stores the text on the block and republishes through `onSave`; Cancel
// returns to the saved text. This file owns the button, the editor and the read-only line;
// workbench-tray.ts only wires it in.

import { iconImg } from "../icon-img";

/** The part of a tray block the annotation touches. */
export interface Annotatable {
  annotation?: string;
  el: HTMLElement;
}

const MAX_CHARS = 4000;

/** Builds the Annotate button (for the actions bar) and the annotation area (appended after the
 *  block's content). `onSave` runs after the block's `annotation` changes. */
export function mountAnnotation(b: Annotatable, onSave: () => void): { button: HTMLButtonElement; area: HTMLElement } {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn file-action wb-annotate-btn";
  button.title = "Annotate";
  button.setAttribute("aria-label", "Annotate");
  button.appendChild(iconImg("comments"));

  const area = document.createElement("div");
  area.className = "wb-annotation";
  const shown = document.createElement("div");
  shown.className = "wb-annotation-text";
  shown.tabIndex = 0;
  const editor = document.createElement("div");
  editor.className = "wb-annotation-editor";
  const ta = document.createElement("textarea");
  ta.maxLength = MAX_CHARS;
  ta.placeholder = "Comment";
  const row = document.createElement("div");
  row.className = "wb-annotation-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "wb-annotation-save";
  save.textContent = "Save";
  save.title = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.title = "Cancel";
  row.append(save, cancel);
  editor.append(ta, row);
  area.append(shown, editor);

  const refresh = () => {
    const text = b.annotation ?? "";
    shown.textContent = text;
    const editing = !editor.hidden;
    shown.hidden = !text || editing;
    area.hidden = !text && !editing;
    button.classList.toggle("selected", !!text);
    button.setAttribute("aria-pressed", String(!!text));
  };
  const open = () => {
    ta.value = b.annotation ?? "";
    editor.hidden = false;
    refresh();
    ta.focus();
  };
  const close = () => {
    editor.hidden = true;
    ta.value = b.annotation ?? "";
    refresh();
  };
  const commit = () => {
    b.annotation = ta.value.trim() || undefined;
    close();
    onSave();
  };

  button.addEventListener("click", () => (editor.hidden ? open() : close()));
  shown.addEventListener("click", open);
  shown.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
  save.addEventListener("click", commit);
  cancel.addEventListener("click", close);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  editor.hidden = true;
  refresh();
  return { button, area };
}
