export const ISSUE_KEYS = ["key", "summary", "status", "statusCategory", "type", "priority", "updated", "url", "typeLevel", "parent"] as const;

export interface Issue {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  type: string;
  priority: string;
  updated: string;
  url: string;
  typeLevel: number;
  parent: string;
}

import type { Filters } from "./ipc";

export type Scope = "mine" | "all";

export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

/** Plan D7: a saved JQL that is empty, or the default reflowed, counts as blank (Mine's parts apply). */
export function isBlankJql(jql: string): boolean {
  const flat = (s: string) => s.trim().replace(/\s+/g, " ");
  return flat(jql) === "" || flat(jql) === flat(DEFAULT_JQL);
}

/** Plan D6 caps; Rust refuses anything over them as a backstop only. */
export const MAX_PICKS = 20;
export const MAX_TEXT = 200;

export type Assignee = Filters["assignee"];
export type FilterState = Filters;

/** Status categories by id (plan D6): the ids do not depend on the site's language. */
export const CATEGORIES: [number, string][] = [[2, "To Do"], [4, "In Progress"], [3, "Done"]];
export const ASSIGNEES: [Assignee, string][] = [["any", "Anyone"], ["me", "Me"], ["none", "Unassigned"]];

export function blankFilters(): FilterState {
  return { projects: [], types: [], categories: [], assignee: "any", text: "" };
}

/** Which controls the bar shows: Project on All only; Assignee not on Mine with a blank saved JQL. */
export function barShape(scope: Scope, blankJql: boolean): { project: boolean; assignee: boolean } {
  return { project: scope === "all", assignee: !(scope === "mine" && blankJql) };
}

/** Filters that apply to the scope: a hidden control's value is dropped. */
export function applicable(f: FilterState, scope: Scope, blankJql: boolean): FilterState {
  const shape = barShape(scope, blankJql);
  return { ...f, projects: shape.project ? f.projects : [], assignee: shape.assignee ? f.assignee : "any" };
}

export function filtersSet(f: FilterState): boolean {
  return !!(f.projects.length || f.types.length || f.categories.length || f.assignee !== "any" || f.text.trim());
}

/** The wire payload: null when nothing applicable is set. Text is capped here as well as in the bar. */
export function toFilters(f: FilterState, scope: Scope, blankJql: boolean): Filters | null {
  const a = applicable(f, scope, blankJql);
  if (!filtersSet(a)) return null;
  return { ...a, text: a.text.slice(0, MAX_TEXT) };
}

/** Adds or removes a pick; a 21st pick is refused (the list comes back unchanged). */
export function togglePick<T>(list: readonly T[], value: T): T[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  return list.length >= MAX_PICKS ? [...list] : [...list, value];
}

/** Plan D4 order for the Type picker: level descending, then name A-Z, one entry per name. */
export function sortTypes(types: readonly { name: string; level: number }[]): { name: string; level: number }[] {
  const seen = new Map<string, { name: string; level: number }>();
  for (const t of types) if (t.name && !seen.has(t.name)) seen.set(t.name, t);
  return [...seen.values()].sort((a, b) => b.level - a.level || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const OTHER_LABEL = "Other";

export type TypeLucide = "zap" | "bug" | "circle-dot";
export type TypeColor = "book" | "content-view" | "contact-card";
export type TypeIcon = { color: TypeColor } | { lucide: TypeLucide };

/** Plan D5: level first (an epic-like level), then the standard names, then the sub-task level, else a dot.
 *  Story, Task and sub-task are colour icons (2026-10-18). */
export function typeIcon(level: number, name: string): TypeIcon {
  if (level >= 1) return { lucide: "zap" };
  if (name === "Story") return { color: "book" };
  if (name === "Bug") return { lucide: "bug" };
  if (name === "Task") return { color: "content-view" };
  if (level === -1) return { color: "contact-card" };
  return { lucide: "circle-dot" };
}

/** The type colour key for a group edge (--kind-<key>): typeIcon's level and name rules; a dot type is "other". */
export type TypeKind = "epic" | "story" | "task" | "bug" | "subtask" | "other";
export function typeKind(level: number, name: string): TypeKind {
  if (level >= 1) return "epic";
  if (name === "Story") return "story";
  if (name === "Bug") return "bug";
  if (name === "Task") return "task";
  if (level === -1) return "subtask";
  return "other";
}

// Small words stay lowercase after the first word (copied from tools/ui/lint-copy-note.mjs SMALL; src/ never imports tools/).
const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "nor", "but", "of", "to", "in", "on", "for", "at", "by", "vs", "via", "per", "as", "from", "with"]);

/** A status name as a Title Case label: `Ready-triage` → Ready Triage, `ready_for_qa` → Ready for QA. A word with a capital
 *  stays as typed (QA, UAT); a name with no lowercase letter is lowercased first. The raw name stays in the tooltip. */
export function statusLabel(raw: string): string {
  let text = raw.trim();
  if (text && !/\p{Ll}/u.test(text)) text = text.toLowerCase();
  const words = text.split(/[\s_-]+/).filter(Boolean);
  return words
    .map((w, i) => {
      if (/\p{Lu}/u.test(w)) return w;
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export type StatusTone = "todo" | "progress" | "review" | "blocked" | "done" | "neutral";

/** Plan D5: Jira's status category key picks the tone; an in-progress name that says review or block refines it.
 *  An unknown key is neutral. */
export function statusTone(categoryKey: string, name: string): StatusTone {
  if (categoryKey === "new") return "todo";
  if (categoryKey === "done") return "done";
  if (categoryKey === "indeterminate") {
    if (/\breview/i.test(name)) return "review";
    if (/\bblock/i.test(name)) return "blocked";
    return "progress";
  }
  return "neutral";
}

export interface Group {
  /** Collapse key: level plus name, so team-managed types of one name merge. */
  key: string;
  label: string;
  level: number;
  issues: Issue[];
}

export function groupKey(level: number, name: string): string {
  return name ? `${level}:${name}` : "other";
}

/** Plan D4: level descending, then name A-Z; a row with no type name goes last under Other. Rows keep their order. */
export function groupIssues(issues: readonly Issue[]): Group[] {
  const groups = new Map<string, Group>();
  for (const issue of issues) {
    const name = issue.type.trim();
    const key = groupKey(issue.typeLevel, name);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: name || OTHER_LABEL, level: name ? issue.typeLevel : Number.NEGATIVE_INFINITY, issues: [] };
      groups.set(key, g);
    }
    g.issues.push(issue);
  }
  return [...groups.values()].sort((a, b) => b.level - a.level || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** Plan D2: a page merges by key, first seen wins, because rows shift between fetches. */
export function mergePage(existing: readonly Issue[], page: readonly Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of [...existing, ...page]) {
    if (seen.has(issue.key)) continue;
    seen.add(issue.key);
    out.push(issue);
  }
  return out;
}

const SITE_LABEL = "([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
const SITE = new RegExp(`^(?:${SITE_LABEL}\\.atlassian\\.net|https:\\/\\/${SITE_LABEL}\\.atlassian\\.net\\/?|${SITE_LABEL})$`, "i");

export function normaliseSite(input: string): string | null {
  const match = SITE.exec(input.trim());
  const name = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!name || /^xn--/i.test(name)) return null;
  return `https://${name.toLowerCase()}.atlassian.net`;
}

const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MAX_SEND_BYTES = 1024;

export function sendText(issue: Pick<Issue, "key" | "summary">): string {
  const clean = `${issue.key}: ${issue.summary}`.replace(STRIP, "");
  const encoder = new TextEncoder();
  if (encoder.encode(clean).length <= MAX_SEND_BYTES) return clean;

  let result = "";
  let bytes = 0;
  for (const codePoint of clean) {
    const nextBytes = encoder.encode(codePoint).length;
    if (bytes + nextBytes > MAX_SEND_BYTES) break;
    result += codePoint;
    bytes += nextBytes;
  }
  return result;
}
