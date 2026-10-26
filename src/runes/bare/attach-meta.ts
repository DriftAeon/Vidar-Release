// src\runes\bare\attach-meta.ts — what an opened skill, agent, hook or MCP server row shows: the rune card's fields
// (cards.ts `openedBody`) built from the file's frontmatter, a guard or a module server. Pure; no DOM, no IPC.
import type { BodyOpts, CardRune } from "../cards";
import type { BareGuard, BareModuleBundles, BareModuleMcp } from "./flow";
import { fileName } from "./row-name";

const TC = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Pure: the single-line `key: value` fields between a file's leading `---` lines. A `>` / `|` block joins its indented
 *  lines with spaces, a `- item` list joins with commas; `#` lines are skipped; a leading BOM is ignored. */
export function frontmatterFields(text: string): Record<string, string> {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const out: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") return out;
  let key = "", block = false;
  const parts: string[] = [];
  const flush = (): void => { if (key) out[key] = parts.join(block ? " " : ", ").trim(); key = ""; parts.length = 0; block = false; };
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    if (/^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      flush();
      key = m[1];
      const v = m[2].trim();
      if (/^[>|][+-]?$/.test(v)) block = true;
      else if (v) parts.push(v.replace(/^(["'])(.*)\1$/, "$2"));
      continue;
    }
    if (!key) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && !block) parts.push(item[1].trim().replace(/^(["'])(.*)\1$/, "$2"));
    else if (line.trim() && block) parts.push(line.trim());
  }
  flush();
  return out;
}

/** What a row opens to: a file (skill or agent; `text` null until read), a hook guard, or a module's MCP server. */
export type ItemSpec =
  | { kind: "skill" | "agent"; path: string; text: string | null }
  | { kind: "hook"; guard: BareGuard }
  | { kind: "mcp"; name: string; module: string; mcp: BareModuleMcp | null };

/** Pure: the module server `name` in the bundles, or null. */
export function findMcp(bundles: BareModuleBundles | null, name: string): BareModuleMcp | null {
  for (const b of Object.values(bundles?.bundles ?? {})) {
    const m = b.mcp.find((x) => x.name === name);
    if (m) return m;
  }
  return null;
}

/** Pure: a skill's file; its path is the folder (or already the file). */
export const skillFile = (path: string): string => (/skill\.md$/i.test(path) ? path : `${path.replace(/[\\/]+$/, "")}\\SKILL.md`);

/** Pure: the rune and opened-body options for one row. `scope` is the library's scope as bricks show it. */
export function itemRune(spec: ItemSpec, scope: string): { rune: CardRune; opts: BodyOpts } {
  const fields: [string, string][] = [];
  const add = (k: string, v: string | undefined): void => { if (v) fields.push([k, v]); };
  if (spec.kind === "hook") {
    const g = spec.guard, run = g.run ?? [], file = run[run.length - 1] ?? g.event;
    add("Event", g.event);
    add("Matcher", g.matcher);
    return {
      rune: { id: fileName(file), kind: "hook", scope: [], activate: "always", description: "", path: file, body: run.join(" ") },
      opts: { barScope: scope, kindName: "Hook", fields, acts: ["folder"] },
    };
  }
  if (spec.kind === "mcp") {
    const m = spec.mcp;
    add("Module", spec.module);
    if (m) add("Transport", m.hasUrl ? "HTTP" : "Stdio");
    if (m?.agents?.length) add("Agents", m.agents.map(TC).join(", "));
    // The url or command line never crosses IPC (bare/bundles.rs `WireMcp`), so the card has no body.
    const body = "";
    return {
      rune: { id: fileName(spec.name), kind: "mcp", scope: [], activate: "always", description: "", path: "", body },
      opts: { barScope: scope, kindName: "MCP Server", fields, acts: [] },
    };
  }
  const fm = frontmatterFields(spec.text ?? "");
  const path = spec.kind === "skill" ? skillFile(spec.path) : spec.path;
  if (spec.kind === "agent") add("Model", fm.model);
  add("Tools", spec.kind === "skill" ? fm["allowed-tools"] : fm.tools);
  return {
    rune: { id: fm.name || fileName(spec.path), kind: spec.kind, scope: [], activate: "recall", description: fm.description ?? "", path, body: (spec.text ?? "").replace(/^﻿/, "") },
    opts: { barScope: scope, kindName: TC(spec.kind), fields },
  };
}
