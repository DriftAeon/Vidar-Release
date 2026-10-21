// src\control\registry.ts — `ctl.*` verb -> existing function. No new
// behaviour: every export here is a thin call into a function that already
// shipped. `listen.ts`
// is the only caller.

import type { Effort } from "../agents/protocol";
import { driveSnapshot, driveSend, driveOpenTab, hasRenderedAgent, hostedRenderedAgent } from "../drive/drive";
import { openDocumentPath, documentDirty } from "../panels/document";
import { revealWorkbench, revealWorkbenchTab } from "../panels/workbench";
import { activate, sessionContainer, findTabByFalconSession, renderedBody } from "../panels/sessions";
import { showSessionsToast } from "../panels/sessions/zoom";
import { transcriptTail } from "../panels/transcript";
import { resolveTabRef } from "../tab-names";
import { resolveRequesterTab, type Requester as ControlRequester } from "./requester";

export { driveSnapshot, hasRenderedAgent, hostedRenderedAgent };

/** `ctl.read`'s own-tab resolution: a `token` requester, or a
 *  `falcon_session` one Rust found in `falcon.hosted`, already names its tab;
 *  otherwise the frontend's session -> tab lookup (adopted tabs). */
export function requesterTabId(r: ControlRequester): string | null {
  return resolveRequesterTab(r, findTabByFalconSession);
}

/** `ctl.read`: refuses a raw (non-rendered) tab the way `driveSend` already
 *  does (`drive.ts:74-78`), else reads the live transcript tail. */
export function readTranscript(tabId: string, maxBytes: number): { ok: true; text: string } | { ok: false; reason: string } {
  const tab = driveSnapshot().tabs.find((t) => t.id === tabId);
  if (!tab || tab.body !== "rendered") return { ok: false, reason: "raw tab" };
  const text = transcriptTail(tabId, maxBytes);
  if (text === null) return { ok: false, reason: "no tab" };
  return { ok: true, text };
}

/** `ctl.prompt`'s Approve action: delivers `text` into `tab` exactly the way
 *  a human typing and hitting Enter would (`driveSend` already refuses a
 *  raw/non-rendered tab and appends the submit `\r`, `drive.ts:74-78`). */
export async function promptTab(tab: string, text: string): Promise<boolean> {
  return driveSend(tab, text);
}

/** `ctl.spawn`'s Approve action: thin call into `driveOpenTab`, which already
 *  refuses an unknown agent id (`findRenderedType`, `drive.ts:57-61`). */
export function spawnTab(opts: { agent: string; model?: string; effort?: Effort; cwd?: string; title?: string }): Promise<string> {
  return driveOpenTab(opts);
}

/** The lane seams (`lanes.ts`): a tab's rendered body, read live per call. */
export function hostedTab(tab: string): boolean {
  return renderedBody(tab)?.hosted() ?? false;
}
export function tabPromptReady(tab: string): boolean {
  return renderedBody(tab)?.promptReady() ?? false;
}
export function tabBusy(tab: string): boolean {
  return renderedBody(tab)?.isBusy() ?? false;
}
/** Closed (no body) or the state chip reads Stopped/Disconnected (`"dead"`). */
export function tabDead(tab: string): boolean {
  const body = renderedBody(tab);
  return !body || body.drive().state === "dead";
}
/** Composer-less prompt into a hosted tab (`RenderedBody.sendPrompt`); rejects on no tab. */
export function sendPromptTo(tab: string, text: string): Promise<void> {
  const body = renderedBody(tab);
  return body ? body.sendPrompt(text) : Promise.reject(new Error("no tab"));
}
export function laneToast(message: string): void {
  showSessionsToast(message, 6000);
}

/** `ctl.show`, Document half: `--focus` reveals the workbench on its Document
 *  sub-tab, so the loaded document is the one on screen. */
export async function showDocument(path: string, focus: boolean): Promise<{ ok: boolean; reason?: string }> {
  if (focus) revealWorkbenchTab("doc");
  const ok = await openDocumentPath(path);
  return ok ? { ok: true } : { ok: false, reason: "open failed" };
}

/** `ctl.show`, display half: opens a bridge\display file (Rust already confined `path`
 *  to a file directly in that folder) in Document's Display group; `--focus` reveals the
 *  Document sub-tab. Approve and Deny stay in Relay, which lists gate files on its own.
 *  Refused while Document has unsaved edits: an agent's show never raises the discard prompt. */
export async function showDisplay(path: string, focus: boolean): Promise<{ ok: boolean; reason?: string }> {
  if (documentDirty()) return { ok: false, reason: "document has unsaved changes" };
  if (focus) revealWorkbenchTab("doc");
  const ok = await openDocumentPath(path);
  const name = path.split("\\").pop() ?? path;
  return ok ? { ok: true } : { ok: false, reason: `open failed: "${name}"` };
}

/** The one tab-address resolver for `focus`, `prompt` and `wait`: an exact tab id first (page
 *  tabs included), else a case-insensitive exact title match (`tab-names.ts`). Zero or several
 *  matches give null, which fails the way an unknown id does. */
export function resolveTab(ref: string): string | null {
  return sessionContainer(ref) ? ref : resolveTabRef(driveSnapshot().tabs, ref);
}

/** `ctl.focus`: "workbench" reveals the pane; any other target is a tab id or name,
 *  focused via `sessions.ts`'s own `activate` (already exported; not named
 *  in the brief's Input list but the only existing "switch to this tab"
 *  function — reused rather than adding a new one). */
export function focusTarget(target: string): boolean {
  if (target === "workbench") {
    revealWorkbench();
    return true;
  }
  const tab = resolveTab(target);
  if (!tab) return false;
  activate(tab);
  return true;
}
