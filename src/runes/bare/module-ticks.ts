// An MCP server row's name and module detail in the Generate Runes from Local file list (view.ts).
import { label } from "../../format";
import { moduleName } from "../../modules/names";
import { nameAndDetail, rowLabel } from "./row-name";
import type { BareLocalFile, BareModuleBundles, BareModuleBundle } from "./flow";

type BundleMcp = BareModuleBundle["mcp"][number];
const transportOf = (m: BundleMcp): string => m.hasUrl ? "HTTP" : m.hasCommand ? "Stdio" : "";
function serverModuleLabel(bundles: BareModuleBundles | null, name: string): string {
  for (const [id, b] of Object.entries(bundles?.bundles ?? {}))
    if (b.mcp.some((m) => m.name === name)) return moduleName(id, label(id));
  return "";
}
function serverTitle(bundles: BareModuleBundles | null, name: string, fallback = name): string {
  for (const b of Object.values(bundles?.bundles ?? {})) {
    const m = b.mcp.find((x) => x.name === name);
    if (m) return transportOf(m) || fallback;
  }
  return fallback;
}
function mcpRowParts(f: BareLocalFile, bundles: BareModuleBundles | null): { spans: HTMLElement[]; title: string } {
  const sid = f.hosted ?? f.shown;
  return { spans: nameAndDetail(rowLabel(f), serverModuleLabel(bundles, sid)),
    title: serverTitle(bundles, sid, f.path) };
}
export function mcpTickRow(b: HTMLElement, f: BareLocalFile, bundles: BareModuleBundles | null, tip: string): void {
  const { spans, title } = mcpRowParts(f, bundles);
  b.replaceChildren(...spans);
  b.title = [title, tip].filter(Boolean).join("\n");
}
