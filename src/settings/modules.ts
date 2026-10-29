// Settings > Modules: one list editor for the three existing module surfaces.
import { BACKEND_ICON_MAP, iconImg, type ColorIcon } from "../icon-img";
import { titleWords } from "../format";
import { resolveModuleState } from "../modules/state";
import { moduleListed, moduleOn, onModulesChange } from "../modules/registry";
import { mergeVisibleOrder } from "../modules/order";
import type { ModuleDescriptor } from "../modules/types";
import { getPref, savePrefConfirmed } from "../prefs";
import { SURFACE_ICONS, SURFACE_LABELS, WORKBENCH_MODULES } from "../panels/workbench-modules";
import { setWorkbenchTabVisibility, type Tab } from "../panels/workbench";
import { setToolVisibility, syncToolOrder } from "../panels/toolbench";
import { BUILTIN_TOOL_MODULES } from "../tools/registry";
import { getFocusedSession } from "../panels/sessions";
import { mcpFocus, mcpFocusKey, mcpFocusRead } from "../panels/mcp-focus";
import pickerIcon from "../assets/picker.png";
import type { McpRack } from "../panels/rack";
import { backendLookupName, dedupeRackServers, rackServerId, reconcileRackOrder } from "../panels/rack-modules";
import { applyOrder } from "../panels/reorder";
import { moduleName, onModuleNamesChange, type RenameOutcome } from "../modules/names";
import { addSettingRow, registerCategory } from "./registry";
import { bindRename, cancelRename, renameCell, whileRendering } from "./module-rename";

type OrderKey = "order.workbenchTabs" | "order.tools" | "order.rack";
/** `builtin` is set on bench and tool rows (renamable); `label` is the name shown. */
type Entry = { id: string; key: string; label: string; builtin?: string; level: ModuleDescriptor["level"]; icon?: ColorIcon };
type Status = "Pending" | "Saved" | "Save Failed" | "Session Only";
type Group = { title: string; orderKey: OrderKey; entries: Entry[] };

const benchIcons: Record<string, ColorIcon> = {
  relay: "relay", tray: "tray", doc: "doc",
  flow: "flow", runelib: "runelib", lab: "lab", changes: "changes", unreal: "unreal",
  ...SURFACE_ICONS,
};
const toolIcons: Record<string, ColorIcon> = { marquee: "marquee" };
let root: HTMLElement | null = null;
let rackEntries: Entry[] = [];
let rackProject: string | null | undefined;
let readGeneration = 0;
let statusGeneration = 0;

/** The rack shows when either agent module is on (a Claude-free set still has Codex). */
function rackAvailable(): boolean {
  return moduleOn("claude") || moduleOn("codex");
}

function groups(): Group[] {
  const hidden = getPref("modules.hidden") ?? [];
  // A release set's unlisted core[] surfaces get no row (moduleListed).
  const bench = resolveModuleState(WORKBENCH_MODULES.filter((m) => moduleListed(m.id)), {
    hidden, order: getPref("order.workbenchTabs"),
  }, (entry) => `bench:${entry.id}`).modules.map(({ descriptor }) => ({
    id: `bench:${descriptor.id}`, key: descriptor.id, label: moduleName(descriptor.id, descriptor.label),
    builtin: descriptor.label, level: descriptor.level, icon: benchIcons[descriptor.id],
  }));
  const tools = resolveModuleState(BUILTIN_TOOL_MODULES.filter((m) => moduleListed(m.id)), {
    hidden, order: getPref("order.tools"),
  }, (entry) => `tool:${entry.id}`).modules.map(({ descriptor }) => ({
    id: `tool:${descriptor.id}`, key: descriptor.id, label: moduleName(descriptor.id, descriptor.label),
    builtin: descriptor.label, level: descriptor.level, icon: toolIcons[descriptor.id],
  }));
  const rackOrder = getPref("order.rack") ?? [];
  const orderedRack = resolveModuleState(rackEntries.map((entry) => ({ ...entry, id: entry.key })),
    { hidden: [], order: rackOrder }).modules.map(({ descriptor }) => rackEntries.find((entry) => entry.key === descriptor.key)!);
  const result: Group[] = [
    { title: "Bench", orderKey: "order.workbenchTabs", entries: bench },
    { title: "Toolbar", orderKey: "order.tools", entries: tools },
  ];
  if (rackAvailable()) result.push({ title: "MCP Rack", orderKey: "order.rack", entries: [
      { id: "rack:container", key: "", label: "MCP Rack", level: "optional", icon: "rack" },
      ...orderedRack,
    ] });
  return result;
}

function setStatus(value: Status) {
  const status = root?.querySelector<HTMLElement>("[data-module-save-status]");
  if (!status) return;
  status.textContent = value;
  status.dataset.state = value === "Pending" ? "pending" : value === "Saved" ? "saved" : "error";
}

/** Pending until `work` settles; a later save's status wins. */
async function track(work: Promise<Status>) {
  const mine = ++statusGeneration;
  setStatus("Pending");
  const value = await work;
  if (mine === statusGeneration) setStatus(value);
}

async function save(key: "modules.hidden" | OrderKey, value: string[]) {
  await track(savePrefConfirmed(key, value).then((result) =>
    result.status === "saved" ? "Saved" : result.status === "session-only" ? "Session Only" : "Save Failed"));
}

const renameStatus = (outcome: RenameOutcome): Status => outcome === "saved" ? "Saved" : "Save Failed";

function refreshLiveOrder(key: OrderKey) {
  if (key === "order.workbenchTabs") {
    const strip = document.getElementById("wb-tabs");
    if (strip) applyOrder(strip, key);
  }
  if (key === "order.tools") syncToolOrder();
  if (key === "order.rack") {
    const list = document.querySelector<HTMLElement>("#bar-modules .module-box .rack-list");
    if (list) applyOrder(list, key);
  }
  document.dispatchEvent(new CustomEvent("vidar-modules-change"));
}

function render() {
  if (root) whileRendering(build);
}

function build() {
  if (!root) return;
  const host = root.querySelector<HTMLElement>(".module-settings__groups")!;
  const active = document.activeElement as HTMLElement | null;
  const activeRow = active && host.contains(active) ? active.closest<HTMLElement>("[data-module-id]") : null;
  const activeId = activeRow?.dataset.moduleId;
  const activeRole = active?.getAttribute("role") === "switch" ? "switch"
    : active?.dataset.moduleRenameOpen ? "rename" : active?.dataset.direction;
  host.replaceChildren();
  const hidden = new Set(getPref("modules.hidden") ?? []);
  for (const group of groups()) {
    const section = document.createElement("section");
    section.className = "module-settings__group";
    section.dataset.orderKey = group.orderKey;
    section.setAttribute("aria-label", group.title);
    const heading = document.createElement("h2");
    heading.className = "module-settings__heading";
    heading.textContent = group.title;
    section.appendChild(heading);
    group.entries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "module-settings__row";
      row.dataset.moduleId = entry.id;
      const name = document.createElement("span");
      name.className = "module-settings__name";
      if (entry.icon) name.appendChild(iconImg(entry.icon));
      else if (entry.id === "tool:eyedropper") {
        const icon = document.createElement("img");
        icon.className = "icn";
        icon.src = pickerIcon;
        icon.alt = "";
        icon.setAttribute("aria-hidden", "true");
        name.appendChild(icon);
      }
      if (entry.builtin) name.append(...renameCell({ id: entry.id, key: entry.key, builtin: entry.builtin }));
      else {
        const label = document.createElement("span");
        label.textContent = entry.label;
        name.appendChild(label);
      }
      const controls = document.createElement("span");
      controls.className = "module-settings__controls";
      const reorderable = !!entry.key;
      for (const [direction, glyph] of [["up", "▲"], ["down", "▼"]] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "module-settings__order";
        button.dataset.direction = direction;
        button.textContent = glyph;
        button.title = direction === "up" ? "Move Up" : "Move Down";
        button.setAttribute("aria-label", `Move ${entry.label} ${direction === "up" ? "Up" : "Down"}`);
        button.disabled = !reorderable || index === (direction === "up" ? (group.title === "MCP Rack" ? 1 : 0) : group.entries.length - 1);
        button.addEventListener("click", () => move(group.orderKey, entry.key, direction === "up" ? -1 : 1));
        controls.appendChild(button);
      }
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "module-settings__switch";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", entry.label);
      toggle.setAttribute("aria-checked", String(entry.level === "core" || !hidden.has(entry.id)));
      toggle.disabled = entry.level === "core";
      if (toggle.disabled) toggle.title = "Relay Is Fixed";
      toggle.addEventListener("click", () => void setModuleVisible(entry.id, hidden.has(entry.id)));
      controls.appendChild(toggle);
      row.append(name, controls);
      section.appendChild(row);
    });
    host.appendChild(section);
  }
  if (activeId && activeRole) {
    const row = [...host.querySelectorAll<HTMLElement>("[data-module-id]")]
      .find((item) => item.dataset.moduleId === activeId);
    const controls = [...(row?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const matching = controls.find((button) => activeRole === "switch" ? button.getAttribute("role") === "switch"
      : activeRole === "rename" ? !!button.dataset.moduleRenameOpen : button.dataset.direction === activeRole);
    const fallback = controls.find((button) => !button.disabled && button !== matching && !button.dataset.moduleRenameOpen);
    (matching && !matching.disabled ? matching : fallback)?.focus();
  }
}

function move(orderKey: OrderKey, key: string, direction: -1 | 1) {
  const group = groups().find((item) => item.orderKey === orderKey)!;
  const entries = group.entries.filter((entry) => entry.key);
  const index = entries.findIndex((entry) => entry.key === key);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= entries.length) return;
  [entries[index], entries[next]] = [entries[next], entries[index]];
  const order = mergeVisibleOrder(getPref(orderKey) ?? [], entries.map((entry) => entry.key));
  void save(orderKey, order);
  refreshLiveOrder(orderKey);
  render();
}

/** Shows or hides one listed module by its row id (`bench:<id>`, `tool:<id>`, `rack:<id>`); core stays
 *  refused and an id with no row is ignored. Settings and the onboarding Modules step both call it. */
export async function setModuleVisible(id: string, visible: boolean): Promise<void> {
  const entry = groups().flatMap((group) => group.entries).find((item) => item.id === id);
  if (entry) await setVisible(entry, visible);
}

async function setVisible(entry: Entry, visible: boolean) {
  if (entry.level === "core") return;
  const hidden = new Set(getPref("modules.hidden") ?? []);
  if (visible) hidden.delete(entry.id);
  else hidden.add(entry.id);
  const value = [...hidden];
  // The confirmed-save API updates the cache immediately; surfaces read that cache on refresh.
  const pending = save("modules.hidden", value);
  if (entry.id.startsWith("bench:")) setWorkbenchTabVisibility(entry.key as Tab, visible);
  if (entry.id.startsWith("tool:")) setToolVisibility(entry.key, visible);
  document.dispatchEvent(new CustomEvent("vidar-modules-change"));
  render();
  await pending;
}

async function loadRack() {
  const mine = ++readGeneration;
  if (!rackAvailable()) {
    rackEntries = [];
    render();
    return;
  }
  // the rack panel's own derivation; a row whose module is off reads as the default row
  const focus = mcpFocus(getFocusedSession(), moduleOn);
  const focusKey = mcpFocusKey(focus);
  if (focusKey !== rackProject) {
    rackProject = focusKey;
    rackEntries = [];
    render();
  }
  try {
    const rack: McpRack = await mcpFocusRead(focus);
    if (mine !== readGeneration) return;
    const servers = dedupeRackServers(rack.servers);
    const order = reconcileRackOrder(getPref("order.rack") ?? [], servers);
    rackEntries = [
      ...servers.map((server) => ({
        id: rackServerId(server), key: rackServerId(server), label: titleWords(server.name) || server.name,
        level: "optional" as const, icon: BACKEND_ICON_MAP.get(backendLookupName(server.name)),
      })),
      { id: "rack:lmstudio", key: "lmstudio", label: "LM Studio", level: "optional", icon: "lmstudio" },
    ];
    // Existing migration is applied for display; its normal rack owner persists it.
    rackEntries = resolveModuleState(rackEntries.map((entry) => ({ ...entry, id: entry.key })),
      { order }).modules.map(({ descriptor }) => rackEntries.find((entry) => entry.key === descriptor.key)!);
    render();
  } catch {
    if (mine !== readGeneration) return;
    rackEntries = [{ id: "rack:lmstudio", key: "lmstudio", label: "LM Studio", level: "optional", icon: "lmstudio" }];
    render();
  }
}

/** The user's module names that differ from every built-in label, for Settings search. */
function customNames(): string {
  const all = [...WORKBENCH_MODULES, ...BUILTIN_TOOL_MODULES];
  const builtins = new Set(all.map((m) => m.label));
  return [...new Set(all.map((m) => moduleName(m.id, m.label)).filter((n) => !builtins.has(n)))].join(" ");
}

/** Call before the Settings modal first opens; registration is idempotent. */
let registered = false;
export function registerModuleRows() {
  if (registered) return;
  registered = true;
  registerCategory("modules", "Modules", "keybinds", "module");
  addSettingRow({
    name: "Modules", category: "modules", wide: true,
    // Built-in names stay searchable; a custom name joins them (search text is built at modal open).
    keywords: () => `Bench Toolbar MCP Rack Relay Tray Display Document Flow Runes Lab Changes Git Commit Stage Diff Branch Marquee Eyedropper LM Studio Unreal UE Editor Build Live Coding Log Issues Atlassian JQL Ticket Pages Database Wiki Inbox Message Channel ${SURFACE_LABELS.join(" ")} ${customNames()}`.trim(),
    control: () => {
      cancelRename(); // a fresh page opens with no field left over from the last one
      root = document.createElement("div");
      root.className = "module-settings";
      const status = document.createElement("span");
      status.className = "module-settings__status";
      status.dataset.moduleSaveStatus = "";
      status.setAttribute("role", "status");
      const host = document.createElement("div");
      host.className = "module-settings__groups";
      root.append(status, host);
      const focusKey = mcpFocusKey(mcpFocus(getFocusedSession(), moduleOn));
      if (focusKey !== rackProject) {
        rackProject = focusKey;
        rackEntries = [];
      }
      render();
      void loadRack();
      return root;
    },
  });
  document.addEventListener("vidar-focus", () => { if (root?.isConnected) void loadRack(); });
  document.addEventListener("vidar-modules-change", () => { if (root?.isConnected) render(); });
  bindRename({ rerender: () => { if (root?.isConnected) render(); }, track: (work) => void track(work.then(renameStatus)) });
  onModuleNamesChange(() => { if (root?.isConnected) render(); });
  let claudeAvailable = rackAvailable();
  const listedKey = () => [...WORKBENCH_MODULES, ...BUILTIN_TOOL_MODULES].filter((m) => moduleListed(m.id)).map((m) => m.id).join("\0");
  let listedSeen = listedKey();
  onModulesChange(() => {
    const listed = listedKey();
    if (listed !== listedSeen) {
      listedSeen = listed;
      if (root?.isConnected) render();
    }
    const available = rackAvailable();
    if (available === claudeAvailable) return;
    claudeAvailable = available;
    if (root?.isConnected) void loadRack();
  });
}
