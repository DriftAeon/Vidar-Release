/* Reply-done event: core owns the `vidar-reply-done` event so sessions.ts
   can fire it without statically importing auto-speak, which the capability registry loads
   lazily. sessions.ts dispatches it from RenderedOpts.onReplyDone (rendered.ts) with the tab id,
   agent kind and cwd; replay never fires it. Listeners: auto-speak (capabilities/mounts). */
import type { RenderedAgent } from "./rendered";

export interface ReplyDoneDetail {
  id: string;
  agent: RenderedAgent;
  /** The cwd of the tab that fired this reply, captured at dispatch time —
   *  not re-read later, so a tab switch during the arm/retrigger wait (or two
   *  Claude tabs sharing one cwd) cannot speak another tab's reply. */
  cwd: string | null;
  /** The tab's launch profile ("bare"), so its own Claude config dir is read; null = default. */
  profile?: string | null;
}

/** Whose reply to read: the tab's folder, agent and id (the backend resolves a Bare Codex tab's
 *  CODEX_HOME from the id). With no agent the reader falls back to the newest transcript of either. */
export interface SpeakTarget {
  cwd: string | null;
  agent: string | null;
  tab: string | null;
  profile?: string | null;
}

export function dispatchReplyDone(detail: ReplyDoneDetail): void {
  document.dispatchEvent(new CustomEvent("vidar-reply-done", { detail }));
}
