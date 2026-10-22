// File-action buttons shared by Document, the Tray and Relay: Copy, Copy Path, Open Folder,
// Open in Browser, Delete.
// One builder per action so the icon, aria-label, title and look (styles/file-actions.css) live here
// and nowhere else. A panel passes only what differs: how to get the path or text, where feedback goes.

import { invoke, type CommandName } from "../ipc";
import { copyText } from "../clipboard";
import { iconImg, type ColorIcon } from "../icon-img";

type Note = (msg: string) => void;

interface BaseOpts {
  /** keeps an element id other code queries */
  id?: string;
  /** extra classes, e.g. "hidden" for a button shown later */
  className?: string;
  /** replaces the canonical title when a tooltip carries more than the label (aria-label stays canonical) */
  title?: string;
}

function build(label: string, icon: ColorIcon, o: BaseOpts, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = ["icon-btn", "file-action", o.className].filter(Boolean).join(" ");
  if (o.id) b.id = o.id;
  b.setAttribute("aria-label", label);
  b.title = o.title ?? label;
  b.appendChild(iconImg(icon));
  b.addEventListener("click", run);
  return b;
}

function reportCopy(ok: boolean, note: Note | undefined, okMsg: string) {
  note?.(ok ? okMsg : "Copy Failed");
}

export interface CopyOpts extends BaseOpts {
  /** the copy itself; return null/undefined when there is nothing to copy (the click does nothing) */
  copy?: () => Promise<boolean> | null | undefined;
  /** a panel with its own copy-and-feedback flow (Tray blocks, which note on the block) takes the whole click instead of `copy` */
  run?: () => void;
  note?: Note;
}

/** Copy: the item itself (text or image) onto the clipboard. */
export function copyButton(o: CopyOpts): HTMLButtonElement {
  return build("Copy", "copy", o, () => {
    if (o.run) return o.run();
    const p = o.copy?.();
    if (p) void p.then((ok) => reportCopy(ok, o.note, "Copied"));
  });
}

export interface CopyPathOpts extends BaseOpts {
  /** the path to copy; null/undefined = nothing to copy */
  path?: () => string | null | undefined;
  run?: () => void;
  note?: Note;
}

/** Copy Path: the file's path as text. */
export function copyPathButton(o: CopyPathOpts): HTMLButtonElement {
  return build("Copy Path", "link", o, () => {
    if (o.run) return o.run();
    const p = o.path?.();
    if (p) void copyText(p).then((ok) => reportCopy(ok, o.note, "Path Copied"));
  });
}

export interface OpenFolderOpts extends BaseOpts {
  path: () => string | null | undefined;
  note: Note;
}

/** Open Folder: the file's folder in the system's default file manager. */
export function openFolderButton(o: OpenFolderOpts): HTMLButtonElement {
  return build("Open Folder", "folder", o, () => {
    const path = o.path();
    if (path) invoke("open_folder", { path }).catch((e) => o.note(`Open Folder Failed:${String(e)}`));
  });
}

export const OPEN_IN_BROWSER = "Open in Browser";

/** True when `path` is a file Open in Browser accepts (the backend allowlist: html, htm, svg, png, jpg, jpeg, gif, webp). */
export function isBrowserPath(path: string | null | undefined): boolean {
  return !!path && /\.(html?|svg|png|jpe?g|gif|webp)$/i.test(path);
}

export interface OpenInBrowserOpts extends OpenFolderOpts {
  /** a block with no file yet (a pasted image): saves it and returns the path; used when `path()` is empty */
  ensure?: () => Promise<string | null | undefined>;
}

/** Open in Browser: an .html/.htm file with the shell's handler for it (the default browser); an
 *  image (svg, png, jpg, jpeg, gif, webp) in the browser registered for .html, not the image viewer.
 *  Any other path does nothing; the caller disables the button for it. */
export function openInBrowserButton(o: OpenInBrowserOpts): HTMLButtonElement {
  const open = (path: string | null | undefined) => {
    if (!isBrowserPath(path)) return;
    invoke("open_in_browser", { path: path! }).catch((e) => o.note(`Open in Browser Failed: ${String(e)}`));
  };
  return build(OPEN_IN_BROWSER, "globe", o, () => {
    const path = o.path();
    if (path || !o.ensure) return open(path);
    void o.ensure().then(open, (e) => o.note(`Open in Browser Failed: ${String(e)}`));
  });
}

export interface DeleteOpts extends BaseOpts {
  path: () => string | null | undefined;
  /** the backend command that removes the file (receives `{ path }`) */
  command: CommandName;
  note: Note;
  /** runs after the command succeeds */
  onDeleted: () => void;
}

/** Delete: confirm, then the backend command. */
export function deleteButton(o: DeleteOpts): HTMLButtonElement {
  return build("Delete", "trash", o, () => {
    const path = o.path();
    if (!path) return;
    const name = path.split("\\").pop() ?? path;
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
    invoke(o.command as "delete_display_file", { path }) // any `{ path }` delete command; the cast only widens the name
      .then(() => o.onDeleted())
      .catch((e) => o.note(`Delete Failed: ${String(e)}`));
  });
}

/** Sets `disabled` across a set of file-action buttons in one call. */
export function setFileActionsDisabled(buttons: readonly HTMLButtonElement[], disabled: boolean) {
  for (const b of buttons) b.disabled = disabled;
}
