// Pure selection and labels for the vault-backed Runes view.
import type { ActionResult, BareActiveLibrary, BareLocalFile } from "./flow";

export const generatable = (files: readonly BareLocalFile[], ticked: ReadonlySet<string>): boolean =>
  files.some((f) => (f.kind === "rules" || f.kind === "memory") && ticked.has(f.path));

export function errorLine(r: ActionResult, what: "import" | "load" = "import"): { text: string; title: string } | null {
  if (r.ok) return null;
  if (r.reason === "readOnly") return { text: "Read Only", title: "" };
  return { text: what === "load" ? "Load Failed" : "Import Failed", title: r.error ?? "" };
}

export function hueOf(lib: Pick<BareActiveLibrary, "generated" | "source" | "library">): string {
  if (lib.generated) return "hue-generated";
  if (/^((set|one|add):)?stock(\/|$)/.test(lib.library)) return "hue-stock";
  const agentSet = /^set:[^/]*\/.*-(claude|codex)$/.exec(lib.library);
  if (agentSet) return `hue-agent-${agentSet[1]}`;
  if (lib.source === null) return "hue-set";
  if (lib.library.startsWith("memory-")) return "hue-recall";
  return /agents(\.override)?\.md$/i.test(lib.source) ? "hue-agents" : "hue-claude";
}
