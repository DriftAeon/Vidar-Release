// The tool chain of a Rendered activity group: one joined bar of segments (icon + short label
// + count, one per tool name) and the "N Ops" total with the group's mark. Pure DOM builders;
// groups.ts owns when they run, tool-pills.ts uses the same short labels and badge.

import { prettyTool, toolWords } from "../../format";
import { svgEl, TOOL_ICON } from "./icons";
import { BACKEND_ICON_MAP, BACKEND_ICONS_MAP, iconImg, TOOL_ICON_MAP, type ColorIcon } from "../../icon-img";
import { backendLookupName } from "../rack-modules";
import { splitUrl } from "./format";
import { el } from "./dom";
import { markSlot, type Mark } from "./marks";
import { toolClass } from "./tool-class";
import type { RenderedAgent } from "./transport";
import type { Group } from "./state";

const SHORT_LABEL = new Map<string, string>([
  ["Read", "Read"], ["Grep", "Grep"], ["Glob", "Glob"],
  ["Edit", "Edit"], ["MultiEdit", "Edit"], ["NotebookEdit", "Edit"], ["Write", "Write"],
  ["Bash", "Bash"], ["WebFetch", "Web"], ["WebSearch", "Web"],
  ["AskUserQuestion", "Ask"], ["Agent", "Agent"], ["Task", "Agent"], ["Thought", "Thought"],
]);
/** Short chain labels for the Atlassian server's tools; other Atlassian tools take the camelCase split. */
const ATLASSIAN_LABEL = new Map([
  ["executeRead", "Read"], ["executeWrite", "Write"], ["executeDestructive", "Delete"], ["discover", "Discover"],
  ["getAccessibleAtlassianResources", "List Sites"], ["atlassianUserInfo", "User Info"],
  ["searchJiraIssuesUsingJql", "Search Issues"], ["getJiraIssue", "Get Issue"],
  ["searchConfluence", "Search Confluence"], ["getConfluenceContent", "Get Page"],
]);
const OPENAI_DOCS_LABEL = new Map([
  ["search_openai_docs", "Search OpenAI Docs"],
  ["fetch_openai_doc", "Fetch OpenAI Doc"],
  ["fetch_openai_docs", "Fetch OpenAI Docs"],
]);

/** MCP names (`mcp__<server>__<tool>` or Codex's `<server>.<tool>`) split for display: a server in
 *  BACKEND_ICON_MAP and/or a tool whose first `_` word is in it become icons and leave the label.
 *  Null when nothing matches or the name has its own tool-map icon. Raw name stays the key. */
function mcpDisplay(name: string): { icons: ColorIcon[]; label: string } | null {
  if (TOOL_ICON_MAP.has(name)) return null;
  let rawServer: string;
  let toolName: string;
  if (name.startsWith("mcp__")) {
    const [, server = "", ...rest] = name.split("__");
    rawServer = server;
    toolName = rest.join("__");
  } else {
    // Some catalog rows use `server:tool`; Codex's live item mapper uses `server.tool`.
    const dot = name.indexOf(".");
    const separator = dot > 0 ? dot : name.lastIndexOf(":");
    if (separator <= 0 || separator === name.length - 1) return null;
    rawServer = name.slice(0, separator);
    toolName = name.slice(separator + 1);
  }
  // OpenAI Developer Docs tools carry the provider name in their tool name; use the existing
  // OpenAI mark from the launcher even when the MCP server id varies by host.
  const openAiDocsLabel = OPENAI_DOCS_LABEL.get(toolName);
  if (openAiDocsLabel) return { icons: ["openai" as ColorIcon], label: openAiDocsLabel };
  // Vidar's proxy exposes Unreal tools with a stable prefix in the tool name.
  const proxyUnreal = rawServer.toLowerCase() === "proxy" && /^unreal[_-]/i.test(toolName);
  if (proxyUnreal) {
      return { icons: ["vidar" as ColorIcon, "unreal" as ColorIcon], label: toolWords(toolName.replace(/^unreal[_-]/i, "")) };
  }
  // a Claude Code plugin server is `plugin_<plugin>_<server>` (plugin_vidar_drive): look it up as vidar-drive
  const server = backendLookupName(rawServer);
  const icons: ColorIcon[] = [];
  const serverIcons = BACKEND_ICONS_MAP.get(server.toLowerCase());
  const serverIcon = serverIcons?.[0];
  if (serverIcons) icons.push(...serverIcons);
  const parts = toolName.split(/[_-]+/).filter(Boolean);
  const toolIcon = parts.length > 1 ? BACKEND_ICON_MAP.get(parts[0].toLowerCase()) : undefined;
  if (toolIcon) { icons.push(toolIcon); parts.shift(); }
  if (!icons.length) return null;
  const atlassian = server.toLowerCase() === "atlassian" ? ATLASSIAN_LABEL.get(toolName) : undefined;
  if (atlassian) return { icons, label: atlassian };
  const label_ = [serverIcon ? "" : toolWords(server), parts.map(toolWords).join(" ")].filter(Boolean).join(": ");
  return { icons, label: label_ || prettyTool(name) };
}

/** the one-word label of a tool name in the chain and on its pill; unlisted names keep prettyTool */
export function shortLabel(name: string): string {
  return SHORT_LABEL.get(name) ?? mcpDisplay(name)?.label ?? prettyTool(name);
}

/** chain-merge key: the short label, plus the icons of an MCP name so unreal_ and blender_ "Call Tool" stay apart */
function mergeKey(name: string): string {
  const icons = mcpDisplay(name)?.icons;
  return icons ? `${icons.join("+")}|${shortLabel(name)}` : shortLabel(name);
}

/** Tools drawn with colour art instead of a tinted lucide glyph: the tool map in
 *  contracts/icons.json (slot.mjs --tool). Checked before TOOL_ICON. */
const TOOL_COLOR_ICON = TOOL_ICON_MAP;

/** a count cell: an icon then the number; the full words ("3 Ops") stay as the title */
export function fillCount(node: HTMLElement, n: number, icon: HTMLImageElement, title: string): void {
  node.replaceChildren(icon, String(n)); // icon then number (2026-10-05; was number then icon)
  node.title = title;
}

/** the phone icon of a "N Calls" cell, mirrored in CSS (.icn-flip-x) so the handset faces right */
export function callsIcon(): HTMLImageElement {
  const img = iconImg("phone");
  img.classList.add("icn-flip-x");
  return img;
}

/** the tool's icon elements (full name as tooltip): one, two for an MCP name with a server and a
 *  tool-word icon, none when it has none */
export function toolIcons(name: string): Element[] {
  const label = prettyTool(name);
  const color = TOOL_COLOR_ICON.get(name);
  if (color) {
    const img = iconImg(color);
    img.title = label;
    return [img];
  }
  const mcp = mcpDisplay(name);
  if (mcp) {
    return mcp.icons.map((icon) => {
      const img = iconImg(icon);
      img.title = label;
      return img;
    });
  }
  const glyph = TOOL_ICON.get(name);
  return glyph ? [svgEl(glyph, label)] : [];
}

/** the pill's class badge: the tool's icon(s) (name as tooltip), or its first letter when it has none */
export function toolBadge(name: string): HTMLElement {
  const badge = el("span", "tool-badge");
  const icons = toolIcons(name);
  if (icons.length) badge.append(...icons);
  if (icons.length > 1) badge.classList.add("multi");
  else if (!icons.length) badge.textContent = prettyTool(name).slice(0, 1).toUpperCase();
  return badge;
}

/** fill a pill's mono target: an http(s) URL becomes scheme / host / rest spans (textContent
 *  keeps the whole string), anything else is plain text */
export function setTarget(node: HTMLElement, text: string, tail = ""): void {
  node.textContent = "";
  const u = splitUrl(text);
  if (u) {
    node.append(el("span", "url-scheme", u.scheme), el("span", "url-host", u.host), el("span", "url-path", u.rest));
  } else if (text) {
    node.append(text);
  }
  if (tail) node.append(tail);
}

/** the Ask segment's outcome, read from the group's own Ask pills: error if any failed, open
 *  while one is waiting, done once all are answered, null with no pills */
function askOutcome(g: Group): "error" | "open" | "done" | null {
  const pills = [...g.details.querySelectorAll<HTMLElement>(':scope > .blk-tool[data-tool-class="ask"]')];
  if (!pills.length) return null;
  if (pills.some((p) => p.matches(".error, .denied, .stale"))) return "error";
  if (pills.some((p) => p.matches(".pending, .running, .awaiting"))) return "open";
  return "done";
}

function segment(g: Group, name: string, count: number, agent: RenderedAgent): HTMLElement {
  const cls = name === "Thought" ? "think" : toolClass(name, agent);
  const seg = el("span", "chain-seg");
  seg.dataset.tool = name;
  seg.dataset.toolClass = cls;
  seg.append(...toolIcons(name));
  seg.appendChild(el("span", "chain-seg-name", shortLabel(name)));
  if (count > 1) seg.appendChild(el("span", "chain-seg-n", String(count)));
  // run: green, red once any of this tool's pills in the group failed (2026-10-04)
  if (cls === "run" && g.details.querySelector(`:scope > .blk-tool[data-tool="${CSS.escape(name)}"]:is(.error, .denied)`)) {
    seg.dataset.outcome = "error";
  }
  {
    // armed while any of the group's own pills of this tool (a Monitor, a background shell) still
    // watches (monitor-run.ts paints data-monitor); a subagent's pills sit deeper and never count
    const pills = [...g.details.querySelectorAll<HTMLElement>(`:scope > .blk-tool[data-tool="${CSS.escape(name)}"][data-monitor]`)];
    if (pills.length) {
      const pick = pills.find((p) => p.dataset.monitor === "armed") ?? pills[pills.length - 1];
      seg.dataset.monitor = pick.dataset.monitor;
      seg.title = pick.querySelector<HTMLElement>(":scope > summary > .tool-badge")?.title ?? "";
      const img = seg.querySelector<HTMLElement>(":scope > .icn");
      if (img) img.title = seg.title;
    }
  }
  if (cls === "ask") {
    const out = askOutcome(g);
    if (out) {
      seg.dataset.outcome = out;
      const mark: Mark = out === "error" ? "error" : out === "open" ? "awaiting" : "done";
      seg.appendChild(markSlot(mark));
    }
  }
  return seg;
}

/** rebuild the summary's bar and total from the group's counts; `running` / `error` set the group mark */
export function renderChain(g: Group, agent: RenderedAgent, running: boolean): void {
  g.label.textContent = "";
  let ops = 0;
  // tools sharing a short label (WebFetch + WebSearch, Edit + MultiEdit) read as one segment: counts
  // summed, name and class colour from the first
  const merged = new Map<string, { name: string; count: number }>();
  for (const [name, count] of g.counts) {
    const key = mergeKey(name);
    const m = merged.get(key);
    if (m) m.count += count;
    else merged.set(key, { name, count });
    if (name !== "Thought") ops += count;
  }
  for (const { name, count } of merged.values()) g.label.appendChild(segment(g, name, count, agent));
  const rt = g.details.querySelector<HTMLElement>(":scope > summary > .chain-rt");
  if (!rt) return;
  rt.textContent = "";
  if (ops) {
    const total = el("span", "chain-ops");
    fillCount(total, ops, iconImg("hammer"), `${ops} ${ops === 1 ? "Op" : "Ops"}`);
    rt.appendChild(total);
  }
  const state: Mark | null = running ? "running" : g.error ? "error" : ops ? "done" : null;
  if (state) rt.appendChild(markSlot(state));
}
