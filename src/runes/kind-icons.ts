// One kind → icon and name map for all eleven rune kinds. The Runes cards, the key, the
// kind heads and the Not Carried notice all read it; the icons are existing installed ones.
import type { ColorIcon } from "../icon-img";

/** `plural` heads a kind group when it is not `name` + "s". */
export interface KindInfo { icon: ColorIcon; name: string; plural?: string }

export const KINDS: Readonly<Record<string, KindInfo>> = {
  rule: { icon: "scales", name: "Rule" },
  fact: { icon: "read", name: "Fact" },
  procedure: { icon: "flow", name: "Procedure" },
  skill: { icon: "skill", name: "Skill" },
  agent: { icon: "agent", name: "Agent" },
  hook: { icon: "hook", name: "Hook" },
  mcp: { icon: "proxy", name: "MCP Server", plural: "MCPs" },
  permission: { icon: "shield", name: "Permission" },
  plugin: { icon: "toolbox", name: "Plugin" },
  "output-style": { icon: "content-view", name: "Output Style" },
  model: { icon: "thought", name: "Model" },
  setting: { icon: "set-general", name: "Setting" },
};

/** Kind → icon, for the key and the chips. */
export const KIND_ICON: Readonly<Record<string, ColorIcon>> =
  Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.icon]));
/** Kind → Title Case name. */
export const KIND_NAME: Readonly<Record<string, string>> =
  Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.name]));
