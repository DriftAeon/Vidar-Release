/* The Slack slice of the typed command map (ipc.ts `Commands` extends it). Types only: ipc.ts stays
   the one file that imports @tauri-apps/api, and the host tags stay in ipc-hosts.ts. */
import type { Cmd } from "../ipc";

/* Slack tab (src-tauri/src/slack; docs/projects/slack/inbox-tab-plan.md § IPC). */
export type SlackErrorKind = "unset" | "auth" | "scope" | "rate" | "endpoint" | "network";
export interface SlackError { error: { kind: SlackErrorKind; message: string; retryAfter?: number } }
export type SlackReply<T> = T | SlackError;
export interface SlackItem {
  id: string; kind: "mention" | "dm"; place: "dm" | "group" | "channel" | "private";
  sender: string; channel: string; text: string; ts: string; url: string;
}

export interface SlackCommands {
  // Slack tab (src-tauri/src/slack): read-only; the token goes in once, on Connect
  slack_status: Cmd<undefined, { host: string | null; tokenSaved: boolean; error?: SlackError["error"] }>;
  slack_connect: Cmd<{ token: string }, SlackReply<{ host: string }>>;
  slack_disconnect: Cmd<undefined, void>;
  slack_inbox: Cmd<undefined, SlackReply<{ items: SlackItem[]; truncated: boolean }>>;
}
