// head-name.ts — the Runes view head's vault name: plain text, or text plus a rename pencil (the Changes tab's
// `.cx-rename` look and its inline-field behaviour: Enter blurs and commits, Escape reverts, the field takes the
// name's place). A New Rune Vault draft shows "New Rune Vault" until named and keeps the pencil after a rename;
// a started session's head shows the vault's name read-only.
import { el } from "../../dom";
import { lucide } from "../../icons";

/** What makes a head name renamable: the name so far ("" = unnamed), the text shown meanwhile, and the commit. */
export interface HeadNameEdit {
  value(): string;
  fallback: string;
  set(name: string): void;
}

export interface HeadName {
  root: HTMLElement;
  /** Shows `text` (null hides the head name); `edit` adds the pencil and makes the text the draft's name. */
  show(text: string | null, edit?: HeadNameEdit): void;
}

export function headName(cls: string): HeadName {
  const root = el("span", cls);
  root.hidden = true;
  let edit: HeadNameEdit | undefined;
  let text: string | null = null;
  let editing = false;

  function paint(): void {
    root.hidden = text === null;
    if (text === null) { root.replaceChildren(); return; }
    if (!edit) { root.replaceChildren(el("span", "runes-vault-name-text", text)); root.title = text; return; }
    const shown = edit.value().trim() || edit.fallback;
    root.title = shown;
    if (editing) { root.replaceChildren(field(edit)); return; }
    const pen = document.createElement("button");
    pen.type = "button";
    pen.className = "cx-rename";
    pen.title = "Rename Vault";
    pen.setAttribute("aria-label", "Rename Vault");
    pen.append(lucide("pencil"));
    pen.addEventListener("click", () => { editing = true; paint(); root.querySelector("input")?.focus(); });
    root.replaceChildren(el("span", "runes-vault-name-text", shown), pen);
  }

  function field(e: HeadNameEdit): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cx-rename-input";
    input.spellcheck = false;
    input.placeholder = e.fallback;
    input.value = e.value();
    input.setAttribute("aria-label", "Vault Name");
    let reverted = false;
    input.addEventListener("blur", () => {
      if (!editing) return;
      editing = false;
      if (!reverted && input.value.trim()) e.set(input.value.trim());
      paint();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      else if (ev.key === "Escape") { reverted = true; input.blur(); }
      ev.stopPropagation(); // typing is not a shortcut
    });
    queueMicrotask(() => { if (input.isConnected) { input.focus(); input.select(); } });
    return input;
  }

  return {
    root,
    show(next, nextEdit) {
      if (nextEdit !== edit) editing = false;
      text = next;
      edit = nextEdit;
      paint();
    },
  };
}
