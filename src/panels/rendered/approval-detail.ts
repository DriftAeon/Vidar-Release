// The body of an approval card: the exact thing being approved, built from the tool's own input.
// Shared by the Rendered approval card (cards.ts) and the Flow approvals sidebar (flow/approvals-panel.ts).

import { renderMarkdownOrText } from "../markdown-build";
import { pretty } from "./format";
import { prettyTool, titleCase } from "../../format";
import { el } from "./dom";
import { codexChanges, codexDiffLines } from "../../agents/codex-diff";

/** one diff line: "+ text" green or "− text" (U+2212) red; shared with the Edit/Write pill's line list */
export function diffSpan(kind: "add" | "del", line: string, tail = "", extra = ""): HTMLSpanElement {
  return el("span", `diff-${kind}${extra ? ` ${extra}` : ""}`, `${kind === "add" ? "+" : "−"} ${line}${tail}`);
}

/** the head label for an approval: an MCP elicitation names its server ("Proxy Server"),
 *  so the body never repeats it; everything else is the pretty tool name */
export function approvalToolLabel(tool: string, input: unknown): string {
  if (tool !== "MCP Elicitation") return tool === "ExitPlanMode" ? "Plan" : prettyTool(tool);
  const server = input && typeof input === "object" ? (input as Record<string, unknown>).serverName : undefined;
  return typeof server === "string" && server ? `${titleCase(server)} Server` : "MCP";
}

/** the exact thing being approved, in the tool's own terms:
 *  the command, the path + diff, the path + size — JSON only as the fallback */
export function approvalDetail(tool: string, input: unknown, inputBytes: number): HTMLElement[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const note = inputBytes > 256 * 1024 ? `\n[input summarised: ${inputBytes} B]` : "";
  switch (tool) {
    case "Permissions": {
      const permissions = (i.permissions && typeof i.permissions === "object" ? i.permissions : {}) as Record<string, unknown>;
      const out: HTMLElement[] = [el("div", "tool-input", "Scope: This Turn")];
      if (s("cwd")) out.push(el("div", "approval-path", s("cwd")));
      if (s("reason")) out.push(el("div", "approval-path", s("reason")));
      // Retain every requested entry (including globs and special paths) in the review body.
      out.push(el("pre", "tool-input", pretty(permissions) + note));
      return out;
    }
    case "Bash": case "PowerShell":
      return [el("pre", "tool-input approval-cmd", s("command") + note)];
    case "Command": { // Codex's command approval
      const out: HTMLElement[] = [el("pre", "tool-input approval-cmd", s("command") + note)];
      if (s("reason")) out.push(el("div", "approval-path", s("reason")));
      return out;
    }
    case "MCP Elicitation": {
      const out: HTMLElement[] = [];
      if (s("title")) out.push(el("div", "approval-path", s("title")));
      if (s("message")) out.push(el("div", "tool-input", s("message")));
      if (s("description")) out.push(el("div", "tool-input", s("description")));
      if (s("url")) out.push(el("pre", "tool-input approval-cmd", s("url")));
      if (i.challenge !== undefined) out.push(el("pre", "tool-input", pretty(i.challenge)));
      if (s("unsupportedReason")) out.push(el("div", "approval-path", s("unsupportedReason")));
      return out.length ? out : [el("pre", "tool-input", pretty(input) + note)];
    }
    case "Edit": {
      if (Array.isArray(i.changes)) { // Codex: {changes:[{path, kind, diff}]}
        const out: HTMLElement[] = [];
        for (const c of codexChanges(i)) {
          out.push(el("div", "approval-path", `${c.path}${c.kind ? ` (${c.kind})` : ""}`));
          const d = el("pre", "tool-input approval-diff");
          for (const l of codexDiffLines(c)) d.append(diffSpan(l.kind, l.text, "\n"));
          out.push(d);
        }
        if (s("reason")) out.push(el("div", "approval-path", s("reason")));
        return out.length ? out : [el("pre", "tool-input", s("note") || pretty(input) + note)];
      }
      const path = el("div", "approval-path", s("file_path"));
      const diff = el("pre", "tool-input approval-diff");
      for (const line of s("old_string").split("\n")) diff.append(diffSpan("del", line, "\n"));
      for (const line of s("new_string").split("\n")) diff.append(diffSpan("add", line, "\n"));
      if (i.replace_all === true) {
        const all = el("span", "diff-note", "(All)");
        all.title = "Replaces every occurrence.";
        diff.append(all);
      }
      return [path, diff];
    }
    case "Write": {
      const content = s("content");
      return [el("div", "approval-path", `${s("file_path")} — ${content.length} chars${content.includes("\n") ? `, ${content.split("\n").length} lines` : ""}`),
        el("pre", "tool-input", content.length > 4000 ? content.slice(0, 4000) + "\n… (more)" : content)];
    }
    case "ExitPlanMode": {
      const plan = s("plan");
      const built = renderMarkdownOrText("plan.md", plan, { softBreaks: "br" });
      const wrap = el("div", "approval-plan");
      if (built.fellBack) {
        const pre = el("pre", "blk-text-fallback", plan);
        pre.title = built.fellBack.reason;
        wrap.appendChild(pre);
      } else {
        wrap.appendChild(built.el);
      }
      return [wrap];
    }
    default:
      return [el("pre", "tool-input", pretty(input) + note)];
  }
}
