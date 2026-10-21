/* The Jira slice of the typed command map (ipc.ts `Commands` extends it). Types only: ipc.ts stays
   the one file that imports @tauri-apps/api, and the host tags stay in ipc-hosts.ts. */
import type { Cmd } from "../ipc";

/** Jira filter bar state (src-tauri/src/jira/jql.rs). */
export type Filters = { projects: string[]; types: string[]; categories: number[]; assignee: "any" | "me" | "none"; text: string };

/** Jira issue detail (src-tauri/src/jira/detail.rs); description and comment bodies are ADF, untrusted. */
export type JiraRef = { key: string; summary: string; status: string; statusCategory: string; url: string };
export type JiraCommentsPage = { total: number; startAt: number; items: { author: string; created: string; body: unknown }[] };
export type JiraIssueDetail = {
  key: string; url: string; summary: string; status: string; statusCategory: string; type: string; priority: string; updated: string;
  assignee: string; description: unknown | null; parent: JiraRef | null; subtasks: JiraRef[]; comments: JiraCommentsPage;
};

export interface JiraCommands {
  // Jira bench tab (src-tauri/src/jira): the token goes in once, on Connect, and never comes back
  jira_status: Cmd<undefined, { site: string | null; email: string | null; jql: string | null; tokenSaved: boolean }>;
  jira_connect: Cmd<{ site: string; email: string; token: string }, void>;
  jira_disconnect: Cmd<undefined, void>;
  jira_issues: Cmd<{ scope: "mine" | "all"; filters: Filters | null; pageToken: string | null },
    | { issues: { key: string; summary: string; status: string; statusCategory: string; type: string; priority: string; updated: string; url: string; typeLevel: number; parent: string }[]; nextPageToken: string | null }
    | { error: { kind: "unset" | "auth" | "jql" | "rate" | "endpoint" | "site" | "network"; message: string } }>;
  jira_types: Cmd<undefined,
    | { types: { name: string; level: number }[] }
    | { error: { kind: "unset" | "auth" | "jql" | "rate" | "endpoint" | "site" | "network"; message: string } }>;
  jira_projects: Cmd<undefined,
    | { projects: { key: string; name: string }[] }
    | { error: { kind: "unset" | "auth" | "jql" | "rate" | "endpoint" | "site" | "network"; message: string } }>;
  jira_issue: Cmd<{ key: string },
    | { issue: JiraIssueDetail }
    | { error: { kind: "unset" | "auth" | "jql" | "rate" | "endpoint" | "site" | "network"; message: string } }>;
  jira_comments: Cmd<{ key: string; startAt: number },
    | { comments: JiraCommentsPage }
    | { error: { kind: "unset" | "auth" | "jql" | "rate" | "endpoint" | "site" | "network"; message: string } }>;
}
