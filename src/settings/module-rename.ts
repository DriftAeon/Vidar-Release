// Settings > Modules inline rename (2026-10-17): the Changes tab's Rename
// Branch pencil (.cx-rename look), hidden at rest and shown on row hover or focus, opens a field in
// place of the name. Blur (Enter blurs) saves through renameModule; an empty field saves the
// built-in name (the placeholder shows it); Escape reverts, and inside the modal REVERT_EVENT
// does the same before the modal closes. Relay has no pencil (P5).
// modules.ts render() rebuilds every row: the editing id and draft live here, the blur a rebuild
// fires on the removed field is ignored (`rendering`), and restoreEditor() puts the field back.
import { lucide } from "../icons";
import { moduleName, NAME_CHARS, renameModule, trimModuleName, type RenameOutcome } from "../modules/names";

/** modal.ts REVERT_EVENT, by value: importing modal.ts pulls the whole Settings modal into every
 *  module that loads Settings > Modules (rack tests among them). tests/module-settings pins it. */
export const REVERT_EVENT = "settings-revert";

export type RenameTarget = { id: string; key: string; builtin: string };
type Host = { rerender: () => void; track: (work: Promise<RenameOutcome>) => void };

let host: Host | null = null;
let editing: string | null = null;
let draft = "";
let selection: [number, number] | null = null;
let rendering = false;
/** Row whose pencil takes focus after the next rebuild (a keyboard commit or cancel). */
let refocus: string | null = null;

export function bindRename(next: Host): void {
  host = next;
}

/** Runs one rebuild of the rows; field events fired meanwhile are not edits. */
export function whileRendering(build: () => void): void {
  const input = document.querySelector<HTMLInputElement>("input[data-module-rename]");
  if (input && editing && input.dataset.moduleRename === editing) {
    selection = [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length];
  }
  rendering = true;
  try {
    build();
    restoreEditor();
  } finally {
    rendering = false;
  }
}

/** Clears an open edit without saving (the modal closed under it, or Escape). */
export function cancelRename(): void {
  editing = null;
  draft = "";
  selection = null;
}

/** The name cell content for one bench or tool row: a field while editing, else the label plus
 *  the pencil (none on Relay). */
export function renameCell(target: RenameTarget): HTMLElement[] {
  const name = moduleName(target.key, target.builtin);
  if (editing === target.id) return [field(target, name)];
  const label = document.createElement("span");
  label.className = "module-settings__label";
  label.textContent = name;
  if (name !== target.builtin) label.title = `Built-In Name: ${target.builtin}`;
  if (target.key === "relay") return [label];
  const pen = document.createElement("button");
  pen.type = "button";
  pen.className = "cx-rename module-settings__rename";
  pen.dataset.moduleRenameOpen = target.id;
  pen.title = "Rename Module";
  pen.setAttribute("aria-label", `Rename ${name}`);
  pen.append(lucide("pencil"));
  pen.addEventListener("click", () => {
    editing = target.id;
    draft = name;
    selection = [0, name.length];
    host?.rerender();
  });
  return [label, pen];
}

function field(target: RenameTarget, name: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "module-settings__rename-input";
  input.dataset.moduleRename = target.id;
  input.spellcheck = false;
  input.maxLength = NAME_CHARS; // soft cap: names.ts counts code points and is the real check
  input.placeholder = target.builtin;
  input.value = draft;
  input.setAttribute("aria-label", `Rename ${name}`);
  input.addEventListener("input", () => {
    if (!rendering && editing === target.id) draft = input.value;
  });
  input.addEventListener("blur", () => {
    if (rendering || editing !== target.id) return;
    commit(target, input.value);
  });
  const revert = () => {
    if (editing !== target.id) return;
    cancelRename();
    refocus = target.id;
    if (!rendering) host?.rerender();
  };
  input.addEventListener(REVERT_EVENT, revert);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      refocus = target.id;
      input.blur();
    } else if (e.key === "Escape") revert();
    e.stopPropagation(); // typing is not a shortcut (agents.ts field)
  });
  return input;
}

function commit(target: RenameTarget, value: string): void {
  cancelRename();
  const before = moduleName(target.key, target.builtin);
  const typed = trimModuleName(value);
  if (typed === before || (typed === "" && before === target.builtin)) {
    host?.rerender();
    return;
  }
  // The store updates its cache before the write, so the rebuilt row already shows the new name;
  // a refusal or failure rolls the cache back and the store's change event relabels the row.
  const work = renameModule(target.key, value, target.builtin);
  host?.track(work);
  host?.rerender();
}

function restoreEditor(): void {
  if (editing) {
    const input = [...document.querySelectorAll<HTMLInputElement>("input[data-module-rename]")]
      .find((el) => el.dataset.moduleRename === editing);
    if (!input) return;
    input.focus();
    const [start, end] = selection ?? [input.value.length, input.value.length];
    input.setSelectionRange(start, end);
    return;
  }
  if (!refocus) return;
  const id = refocus;
  refocus = null;
  [...document.querySelectorAll<HTMLButtonElement>("button[data-module-rename-open]")]
    .find((el) => el.dataset.moduleRenameOpen === id)?.focus();
}
