// Codex-specific Loadout rows. The shared rack structure lives in loadout-rows.
import type { CodexLoadout } from "../ipc";
import { DASH, prettyModel } from "../format";
import { buildInstructionsViz } from "./loadout-viz";
import { buildRow, detailRowNode, groupedLines, groupHead, infoLine, scopeValue } from "./loadout-rows";
import { detailRow, text } from "./rack-row";
import { skillLabel } from "./skill-label";
import { iconImg, type ColorIcon } from "../icon-img";

function fieldLine(icon: ColorIcon, label: string, value: string): HTMLElement {
  const content = document.createElement("span");
  content.append(text("", label + " "), text("loadout-mono", value));
  return infoLine(icon, content, label);
}

export function codexRows(l: CodexLoadout, cwd: string): HTMLElement[] {
  // The instruction file paths are already in the native reader's load order.
  const hasInstructions = l.instructions.length > 0 || l.developerInstructionsChars != null;
  const instructions = buildRow("Instructions", scopeValue(""), () => {
    const detail: HTMLElement[] = [];
    if (l.instructions.length) detail.push(buildInstructionsViz(l.instructions));
    if (l.developerInstructionsChars != null) {
      detail.push(fieldLine("rules", "Developer Instructions", String(l.developerInstructionsChars) + " chars"));
    }
    return detail;
  }, !hasInstructions);

  const skills = buildRow("Skills", scopeValue(""), () => {
    if (!l.skills.length) return [];
    const list = document.createElement("div");
    list.className = "item-btn-list";
    list.append(...l.skills.map((s) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "item-btn";
      el.append(text("item-btn-dot", ""), text("item-btn-name", skillLabel(s.name)));
      if (s.description) el.title = s.description;
      return el;
    }));
    return [list];
  }, !l.skills.length);

  // Role files of the tab's Codex home (`<home>\agents\*.toml`), listed like the Claude Agents row. A role
  // held read-only by prompt only (bare/codex_roles.rs) gets a lock icon after its model.
  const agents = buildRow("Agents", scopeValue(""), () =>
    l.agents.length
      ? l.agents.map((a) => {
          const model = a.model ? prettyModel(a.model) : DASH;
          if (!a.readOnlyByPrompt) return detailRow(a.name, model);
          const value = document.createElement("span");
          value.className = "loadout-info-line"; // gives the icon its size
          const lock = iconImg("lock");
          lock.title = "Read-only by prompt: Codex does not sandbox this role";
          value.append(text("", model), lock);
          return detailRowNode(a.name, value);
        })
      : [],
    !l.agents.length,
  );

  const configFields = [
    ["Model", l.model],
    ["Effort", l.effort],
    ["Sandbox", l.sandbox],
    ["Approval", l.approval],
    ["Reviewer", l.reviewer],
  ] as const;
  const presentConfig = configFields.filter(([, value]) => value != null);
  const config = buildRow("Config", scopeValue(""), () =>
    presentConfig.length
      ? presentConfig.map(([label, value]) => fieldLine("ruler", label, value!))
      : [],
    !presentConfig.length,
  );

  const hooks = buildRow("Hooks", scopeValue(""), () =>
    l.notify.length
      ? [groupedLines(
          groupHead("timer", "Notify", "Notify"),
          l.notify.map((script) => {
            const line = text("loadout-item-line loadout-mono", script);
            line.title = script;
            return line;
          }),
        )]
      : [],
    !l.notify.length,
  );

  const permissions = buildRow("Permissions", scopeValue(""), () => [
    fieldLine("shield", "Sandbox", l.sandbox ?? DASH),
    ...(l.network == null ? [] : [fieldLine("shield", "Network", l.network ? "On" : "Off")]),
    fieldLine("ruler", "Rules Files", String(l.rulesFiles)),
  ]);

  // Notes are plain error-style lines, as in the Claude reader.
  return [instructions, skills, agents, config, hooks, permissions, ...l.notes.map((n) => text("sub tool-err", n))];
}
