/* The Notion slice of the typed command map (ipc.ts `Commands` extends it). Types only: ipc.ts stays
   the one file that imports @tauri-apps/api, and the host tags stay in ipc-hosts.ts. */
import type { Cmd } from "../ipc";

/* Notion tab (src-tauri/src/notion; docs/projects/notion/plan.md § IPC). Ids come back dashed. */
export type NotionKind = "connection" | "personal";
export type NotionErrorKind = "unset" | "auth" | "forbidden" | "missing" | "rate" | "endpoint" | "network" | "parse";
export interface NotionError { error: { kind: NotionErrorKind; message: string; retryAfter?: number } }
export type NotionReply<T> = T | NotionError;
/** `icon` is the page's own emoji, or "" (non-emoji icons are dropped in Rust). */
export interface NotionHit { id: string; kind: "page" | "source"; title: string; url: string; lastEdited: string; icon: string }
export interface NotionProp {
  id: string; name: string; type: string;
  options: { name: string; color: string }[];
  groups: { name: string; options: string[] }[];
}
export interface NotionSource { id: string; title: string; url: string; props: NotionProp[] }
export interface NotionRow { id: string; title: string; url: string; lastEdited: string; icon: string; values: Record<string, string[]> }
export interface NotionPage {
  id: string; title: string; url: string; lastEdited: string; created: string;
  fields: { label: string; value: string; dim?: boolean }[];
}

export interface NotionCommands {
  // Notion bench tab (src-tauri/src/notion): read-only; the token goes in once, on Connect
  notion_status: Cmd<undefined, { tokenSaved: boolean; workspace: string | null; kind: NotionKind | null }>;
  notion_connect: Cmd<{ token: string }, NotionReply<{ workspace: string | null; kind: NotionKind }>>;
  notion_disconnect: Cmd<undefined, void>;
  notion_search: Cmd<{ kind: "page" | "source"; cursor: string | null }, NotionReply<{ hits: NotionHit[]; next: string | null }>>;
  notion_source: Cmd<{ id: string }, NotionReply<{ source: NotionSource }>>;
  notion_query: Cmd<{ id: string; cursor: string | null; props: string[] },
    NotionReply<{ rows: NotionRow[]; next: string | null; propsRefused: boolean }>>;
  notion_page: Cmd<{ id: string }, NotionReply<{ page: NotionPage }>>;
  notion_blocks: Cmd<{ id: string; cursor: string | null }, NotionReply<{ blocks: unknown[]; next: string | null }>>;
}
