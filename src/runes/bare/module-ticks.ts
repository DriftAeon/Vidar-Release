// Module item ticks import library runes, then edit the vault's copied runeset membership.
import { iconImg } from "../../icon-img";
import { label } from "../../format";
import { moduleName } from "../../modules/names";
import { setHead } from "../set-card";
import { checkBox } from "../check-box";
import { nameAndDetail, rowLabel } from "./row-name";
import { runeName } from "../cards";
import { KIND_ICON } from "../kind-icons";
import type { RuneItem } from "../types";
import { el } from "./agent-view";
import { importMembers } from "./set-attach";
import type { SetAttachCtx } from "./set-attach";
import type { BareLocalFile, BareModuleBundles, BareModuleBundle, BareGuard, ItemRuneInputs } from "./flow";
import type { VaultViewRune } from "./cake";

type BundleMcp = BareModuleBundle["mcp"][number];
export const transportOf = (m: BundleMcp): string => m.hasUrl ? "HTTP" : m.hasCommand ? "Stdio" : "";
export function serverModuleLabel(bundles: BareModuleBundles | null, name: string): string {
  for (const [id, b] of Object.entries(bundles?.bundles ?? {}))
    if (b.mcp.some((m) => m.name === name)) return moduleName(id, label(id));
  return "";
}
export function serverTitle(bundles: BareModuleBundles | null, name: string, fallback = name): string {
  for (const b of Object.values(bundles?.bundles ?? {})) {
    const m = b.mcp.find((x) => x.name === name);
    if (m) return transportOf(m) || fallback;
  }
  return fallback;
}
export function mcpRowParts(f: BareLocalFile, bundles: BareModuleBundles | null): { spans: HTMLElement[]; title: string } {
  const sid = f.hosted ?? f.shown;
  return { spans: nameAndDetail(rowLabel(f), serverModuleLabel(bundles, sid)),
    title: serverTitle(bundles, sid, f.path) };
}
export function mcpTickRow(b: HTMLElement, f: BareLocalFile, bundles: BareModuleBundles | null, tip: string): void {
  const { spans, title } = mcpRowParts(f, bundles);
  b.replaceChildren(...spans);
  b.title = [title, tip].filter(Boolean).join("\n");
}

const last = (p: string): string => p.split(/[\\/]/).at(-1)?.toLowerCase() ?? p.toLowerCase();
/** A module item's visible name: Title Case with the acronyms runeName keeps (`vidar-drive` → Vidar Drive). The raw name stays in the row title. */
export const itemLabel = (raw: string): string =>
  runeName({ id: (raw.split(/[\\/]/).at(-1) ?? raw).replace(/\.(mjs|cjs|js|ts|md|toml|json|ps1|sh|py)$/i, ""), path: "" } as RuneItem);
const guardKey =(g: BareGuard): string => `guard:${g.event}|${g.matcher ?? ""}|${(g.run ?? []).map(last).join(",")}`;
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const generatedId = (actual: string, base: string): boolean => actual === base || new RegExp(`^${base}-[0-9]+$`).test(actual);
interface Item { key: string; name: string; label: string; matches(r: VaultViewRune): boolean }
function items(id: string, b: BareModuleBundle, codex: boolean): Item[] {
  return [
    ...b.mcp.filter((m) => !m.agents?.length || m.agents.includes(codex ? "codex" : "claude"))
      .map((m) => ({ key: `mcp:${m.name}`, name: m.name, label: itemLabel(m.name),
        matches: (r: VaultViewRune) => r.kind === "mcp" && generatedId(r.id, slug(`${id}-${m.name}`)) })),
    ...b.skills.map((p) => ({ key: `skill:${last(p)}`, name: last(p), label: itemLabel(p),
      matches: (r: VaultViewRune) => r.kind === "skill" && !!r.item?.source && r.item.source.endsWith(p) })),
    ...b.agents.map((p) => ({ key: `agent:${last(p)}`, name: last(p), label: itemLabel(p),
      matches: (r: VaultViewRune) => r.kind === "agent" && !!r.item?.source && r.item.source.endsWith(p) })),
    ...(codex ? [] : b.guards.map((g) => ({ key: guardKey(g), name: last(g.run?.at(-1) ?? g.event), label: itemLabel(g.run?.at(-1) ?? g.event),
      matches: (r: VaultViewRune) => r.kind === "hook" && r.item?.event === g.event &&
        (g.run ?? []).every((p) => r.item?.run?.some((q) => q.endsWith(p))) }))),
  ];
}

/** Include every catalog key in `off` except the items this switch offers for the agent. */
export function moduleLayer(id: string, b: BareModuleBundle, selected: readonly string[]): ItemRuneInputs {
  const all = new Set([
    ...b.mcp.map((m) => `mcp:${m.name}`),
    ...b.skills.map((p) => `skill:${last(p)}`),
    ...b.agents.map((p) => `agent:${last(p)}`),
    ...b.guards.map(guardKey),
  ]);
  const keep = new Set(selected);
  return { modules: { [id]: { off: [...all].filter((key) => !keep.has(key)) } } };
}

export function moduleTicks(c: SetAttachCtx): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const [id, bundle] of Object.entries(c.bundles?.bundles ?? {})) {
    const entries = items(id, bundle, c.codex);
    if (!entries.length) continue;
    const on = entries.some((item) => c.runes.some(item.matches));
    const group = el("details", `runes-set runes-cat hue-none`);
    group.dataset.module = id;
    group.dataset.set = c.set.set;
    c.trackOpen(group, `module:${c.set.library}/${c.set.set}:${id}`, false);
    // the group's toggle is Modify's checkbox at the head's left, like the runeset heads (check-box.ts)
    const toggle = checkBox({ state: on ? "on" : "off", disabled: c.busy, title: on ? "On" : "Off", label: on ? "On" : "Off",
      flip: () => c.act(() => importMembers(c.io, c.set, moduleLayer(id, bundle, on ? [] : entries.map((item) => item.key)), !on, c.runes, c.edit,
        c.runes.filter((r) => entries.some((item) => item.matches(r))))) });
    group.appendChild(setHead(moduleName(id, label(id)),
      entries.filter((item) => c.runes.some(item.matches)).length, KIND_ICON.mcp, undefined, toggle));
    const tray = el("div", "runes-tray");
    for (const item of entries) {
      const active = c.runes.some(item.matches);
      const row = el("button", "runes-blk runes-module-item");
      row.type = "button"; row.disabled = c.busy;
      row.dataset.item = item.key;
      row.setAttribute("aria-pressed", String(active));
      row.classList.toggle("is-dim", !active);
      row.title = item.name;
      row.append(el("span", "runes-kslot"), el("span", "runes-rname", item.label));
      row.querySelector(".runes-kslot")!.appendChild(iconImg(active ? "check-circle" : "dismiss-circle"));
      row.addEventListener("click", () => c.act(() =>
        importMembers(c.io, c.set, moduleLayer(id, bundle, active ? [] : [item.key]),
          !active, c.runes, c.edit, c.runes.filter(item.matches))));
      tray.appendChild(row);
    }
    group.appendChild(tray);
    out.push(group);
  }
  return out.length ? [el("div", "runes-div", "Modules"), ...out] : [];
}
