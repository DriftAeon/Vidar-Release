// src\drive\paste.ts — the `paste` drive verb:
// a synthetic ClipboardEvent("paste") carrying a built DataTransfer, dispatched at one of the
// three receivers. It exercises our handlers, not the OS clipboard → WebView2 handoff.
//
// `clipboardData` is recorded by a window capture listener during the dispatch, so every result
// says whether the engine honoured the constructed event's clipboardData (INFERRED for WebView2
// until the first smoke; Chromium does).

import { driveSnapshot as sessionsDriveSnapshot, sessionContainer } from "../panels/sessions";

export type DrivePasteTarget = "terminal" | "tray" | "composer";
export interface DrivePastePayload {
  text?: string;
  /** an image file read by the node side; base64 of its bytes */
  file?: { name: string; type: string; base64: string };
}
export interface DrivePasteResult {
  target: DrivePasteTarget;
  tabId?: string;
  /** what a capture listener on window saw on the dispatched event */
  clipboardData: { present: boolean; types: string[]; textLength: number; files: number };
  /** the receiver claimed the event (terminal: xterm stopped it; tray: preventDefault) */
  handled: boolean;
  [k: string]: unknown;
}

const TIMEOUT_MS = 3000;

function buildTransfer(p: DrivePastePayload): DataTransfer {
  const dt = new DataTransfer();
  if (p.file) {
    const bytes = Uint8Array.from(atob(p.file.base64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], p.file.name, { type: p.file.type }));
  }
  if (p.text !== undefined) dt.setData("text/plain", p.text);
  return dt;
}

// Dispatch with the window-capture probe attached for exactly this event.
function dispatchPaste(at: EventTarget, dt: DataTransfer) {
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
  let seen: DrivePasteResult["clipboardData"] = { present: false, types: [], textLength: 0, files: 0 };
  const probe = (e: Event) => {
    if (e !== ev) return;
    const cd = (e as ClipboardEvent).clipboardData;
    seen = cd
      ? { present: true, types: [...cd.types], textLength: cd.getData("text/plain").length, files: cd.files.length }
      : seen;
  };
  window.addEventListener("paste", probe, true);
  try { at.dispatchEvent(ev); } finally { window.removeEventListener("paste", probe, true); }
  return { ev, seen };
}

function activeTab(body: "terminal" | "rendered") {
  const snap = sessionsDriveSnapshot();
  const tab = snap.tabs.find((t) => t.id === snap.activeId);
  if (!tab) throw new Error("no active tab");
  if (tab.body !== body) throw new Error(`active tab "${tab.id}" is a ${tab.body} body, not ${body}`);
  const container = sessionContainer(tab.id);
  if (!container) throw new Error(`no container for tab "${tab.id}"`);
  return { id: tab.id, container };
}

// xterm's own paste listener (textarea + element, CoreBrowserTerminal) reads
// clipboardData text/plain, stops propagation and writes it through onData → write_pty.
// sessions/terminal-body.ts's capture listener only swallows a paste during a Ctrl+V gesture, which a
// drive never has. So "handled" = the event never bubbled up to the tab container.
function pasteTerminal(p: DrivePastePayload): DrivePasteResult {
  if (p.text === undefined) throw new Error("terminal takes text only");
  const { id, container } = activeTab("terminal");
  const ta = container.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
  if (!ta) throw new Error(`no xterm textarea in tab "${id}"`);
  let bubbled = false;
  const mark = () => { bubbled = true; };
  container.addEventListener("paste", mark);
  try {
    const { seen } = dispatchPaste(ta, buildTransfer(p));
    return { target: "terminal", tabId: id, clipboardData: seen, handled: !bubbled, deliveredLength: bubbled ? 0 : seen.textLength };
  } finally { container.removeEventListener("paste", mark); }
}

// workbench.ts onPaste, on the #workbench root: preventDefault when it takes the paste;
// text lands synchronously, an image block after an async read — poll the block count.
async function pasteTray(p: DrivePastePayload): Promise<DrivePasteResult> {
  const root = document.getElementById("workbench");
  if (!root) throw new Error("no #workbench root");
  const count = () => root.querySelectorAll("article.wb-block").length;
  // head notes are toasts now (workbench.ts note -> showSessionsToast); the one #zoom-toast holds the latest
  const note = () => document.getElementById("zoom-toast")?.textContent ?? "";
  const before = count();
  const noteBefore = note();
  const { ev, seen } = dispatchPaste(root, buildTransfer(p));
  const handled = ev.defaultPrevented;
  const deadline = performance.now() + (handled && p.file ? TIMEOUT_MS : 0);
  while (count() === before && note() === noteBefore && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { target: "tray", clipboardData: seen, handled, blocksBefore: before, blocksAfter: count(), note: note() };
}

// The Rendered composer has no paste listener of its own: a real paste is the browser's
// default textarea insertion, which an untrusted (synthetic) event never gets. So after the
// dispatch, if nothing claimed it, the verb performs that default with execCommand("insertText"),
// which fires the textarea's input handler as a real paste would.
function pasteComposer(p: DrivePastePayload): DrivePasteResult {
  if (p.text === undefined) throw new Error("composer takes text only");
  const { id, container } = activeTab("rendered");
  const ta = container.querySelector<HTMLTextAreaElement>("textarea.rendered-input");
  if (!ta) throw new Error(`no .rendered-input in tab "${id}"`);
  if (ta.disabled) throw new Error(`composer in tab "${id}" is disabled`);
  const before = ta.value.length;
  ta.focus();
  const { ev, seen } = dispatchPaste(ta, buildTransfer(p));
  const handled = ev.defaultPrevented;
  const inserted = handled ? false : document.execCommand("insertText", false, p.text);
  return { target: "composer", tabId: id, clipboardData: seen, handled, defaultEmulated: inserted, valueLengthBefore: before, valueLengthAfter: ta.value.length };
}

export async function drivePaste(target: DrivePasteTarget, payload: DrivePastePayload): Promise<DrivePasteResult> {
  if (payload.text === undefined && !payload.file) throw new Error("paste needs text or a file");
  switch (target) {
    case "terminal": return pasteTerminal(payload);
    case "tray": return pasteTray(payload);
    case "composer": return pasteComposer(payload);
    default: throw new Error(`unknown paste target "${String(target)}"; valid: terminal, tray, composer`);
  }
}
