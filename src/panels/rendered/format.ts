/* Rendered text formatting: pure string helpers for pills, summaries, token counts and
   turn subtypes. No DOM. */

import { codexChanges } from "../../agents/codex-diff";

const SUMMARY_MAX = 120;
export { pretty } from "../../format";
export function clip(s: string, n = SUMMARY_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function commandFields(input: unknown): { command: string; cwd: string } {
  const i = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    command: typeof i.command === "string" ? i.command : "",
    cwd: typeof i.cwd === "string" ? i.cwd : "",
  };
}

/** Extract the script following a PowerShell -Command switch for readable display. The original
 *  invocation remains available in commandInputText, so this display-only view may be concise. */
export function commandScript(input: unknown): string {
  const command = commandFields(input).command;
  const match = /(?:^|\s)-Command\s+([\s\S]*)$/i.exec(command);
  if (!match) return command;
  const script = match[1].trim();
  return script.length >= 2 && script.startsWith('"') && script.endsWith('"') ? script.slice(1, -1) : script;
}

/** Expanded Command pill content: readable script and cwd, followed by the exact wire command. */
export function commandInputText(input: unknown): string {
  const { command, cwd } = commandFields(input);
  return [
    "Script:", commandScript(input) || "(empty)",
    "Working Directory:", cwd || "(not provided)",
    "Full Invocation:", command || "(empty)",
  ].join("\n");
}

/** one-line description of a tool call for its pill */
export function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (name) {
    case "Command": return clip(commandScript(input).split("\n")[0] || s("command"));
    case "Bash": case "PowerShell": return clip(s("description") || s("command").split("\n")[0]);
    case "Read": case "Write": case "Edit": case "NotebookEdit": {
      const direct = s("file_path") || s("notebook_path");
      if (direct || !Array.isArray(i.changes)) return clip(direct);
      return clip(codexChanges(i).map((c) => c.path).filter(Boolean).join(", ")); // Codex Edit: {changes:[{path}]}
    }
    case "Glob": return clip(s("pattern") + (s("path") ? ` in ${s("path")}` : ""));
    case "Grep": return clip(s("pattern") + (s("path") ? ` in ${s("path")}` : ""));
    case "Agent": return clip(s("description") || s("prompt"));
    case "Skill": return clip(s("skill") + (s("args") ? ` ${s("args")}` : ""));
    case "WebFetch": case "WebSearch": return clip(s("url") || s("query"));
    // Codex display items (src/agents/codex-items.ts)
    case "Image": return clip(s("prompt") || s("path"));
    case "Sleep": return clip(s("duration"));
    case "Subagent": return clip([s("agent") || s("thread"), s("status")].filter(Boolean).join(" · "));
    case "AskUserQuestion": {
      const qs = Array.isArray(i.questions) ? (i.questions as unknown[]) : [];
      const q0 = qs[0] && typeof qs[0] === "object" ? (qs[0] as Record<string, unknown>) : {};
      // the card below carries the question text; the pill names it by the model's short header
      return typeof q0.header === "string" && q0.header.trim() ? clip(q0.header) : "Question";
    }
    case "ExitPlanMode": {
      const heading = s("plan").split("\n").find((line) => /^#+\s/.test(line.trim()));
      return heading ? clip(heading.trim().replace(/^#+\s*/, "")) : "Plan";
    }
    default: {
      const first = Object.entries(i).find(([, v]) => typeof v === "string");
      return first ? clip(`${first[0]}: ${first[1] as string}`) : "";
    }
  }
}

/** an http(s) target split for the pill's mono line; null when it is not a URL.
 *  scheme + host + rest always concatenates back to the input. */
export function splitUrl(s: string): { scheme: string; host: string; rest: string } | null {
  const m = /^(https?:\/\/)([^/?#\s]+)(.*)$/i.exec(s);
  return m ? { scheme: m[1], host: m[2], rest: m[3] } : null;
}

/** the turn's wire subtype as a person would say it. An unlisted subtype shows raw:
 *  a new failure mode the UI has never met must not be prettified into something it is not. */
export function turnSubtype(subtype: string, interrupted: boolean): string {
  if (subtype === "error_during_execution") return interrupted ? "Interrupted" : "Failed During Execution";
  if (subtype === "error_max_turns") return "Turn Limit Reached";
  if (subtype === "interrupted") return "Interrupted"; // Codex's protocol status
  if (subtype === "failed") return "Failed";
  return subtype;
}
