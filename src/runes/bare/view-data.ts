// Pure selection and labels for the vault-backed Runes view.
import type { ActionResult, BareActiveLibrary, BareLocalFile } from "./flow";
// @ts-ignore TS5097: node --test loads this module directly
import { AGENT_IDS } from "../../agents/id.ts";
// @ts-ignore TS5097: node --test loads this module directly
import { AGENTS } from "../../agents/descriptor.ts";

export const generatable = (files: readonly BareLocalFile[], ticked: ReadonlySet<string>): boolean =>
  files.some((f) => (f.kind === "rules" || f.kind === "memory") && ticked.has(f.path));

export function errorLine(r: ActionResult, what: "import" | "load" = "import"): { text: string; title: string } | null {
  if (r.ok) return null;
  if (r.reason === "readOnly") return { text: "Read Only", title: "" };
  return { text: what === "load" ? "Load Failed" : "Import Failed", title: r.error ?? "" };
}

export function hueOf(lib: Pick<BareActiveLibrary, "generated" | "source" | "library">): string {
  if (lib.generated) return "hue-generated";
  if (/^((set|one|add):)?vidar(\/|$)/.test(lib.library)) return "hue-vidar";
  const agentSet = /^set:[^/]*\//.test(lib.library)
    ? AGENT_IDS.find((id) => lib.library.endsWith(`-${id}`)) : undefined;
  if (agentSet) return `hue-agent-${agentSet}`;
  if (/^(set:)?installed$/.test(lib.library)) return "hue-installed";
  if (lib.source === null) return "hue-set";
  if (lib.library.startsWith("memory-")) return "hue-recall";
  const source = lib.source.toLowerCase().replace(/\.override(?=\.md$)/, "");
  return agentFileHue((file) => source.endsWith(file));
}

/** The hue of the agent whose instructions file `matches` (lowercased name); an SDK-less match or none
 *  takes the Flow SDK agent's hue. Shared by the Bare libraries above and the classic sets (cards.ts). */
function agentFileHue(matches: (file: string) => boolean): string {
  const owner = AGENT_IDS.find((id) => matches(AGENTS[id].instructionsFile.toLowerCase()));
  const styleOwner = owner && !AGENTS[owner].flowSdk ? owner : AGENT_IDS.find((id) => AGENTS[id].flowSdk)!;
  return `hue-${AGENTS[styleOwner].instructionsFile.toLowerCase().replace(/\.md$/, "")}`;
}
