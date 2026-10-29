// Server rack: the first occupant of the modules half.
//
// Configuration truth, NOT liveness. Claude Code runs these servers as its own
// children, so Vidar cannot know their health — there is deliberately no status
// dot, because a dot that always looks green is worse than no dot.
//
// The one exception is tools/list: a loopback http server (in practice the
// :8399 proxy) or a stdio server (a throwaway copy Vidar spawns and kills) is
// asked for its tools, once per mount (a rebuild reuses the list it has). That is a real MCP client call,
// decided deliberately — see mcp.rs. Remote http servers are not queried.

import { invoke } from "../ipc";
import { BACKEND_ICON_MAP, iconImg } from "../icon-img";
import { DASH, firstLine, label, titleWords } from "../format";
import { renderLmStudioDetail } from "./lmstudio";
import { detailRow, rackRow, text } from "./rack-row";
import { skillLabel } from "./skill-label";
import { mcpFocus, mcpFocusRead, type McpFocus } from "./mcp-focus";
import { applyOrder, enableReorder } from "./reorder";
import { getFocusedSession, type FocusedSession } from "./sessions";
import { getPref, setPref } from "../prefs";
import { backendLookupName, dedupeRackServers, isLoopbackHttp, rackServerId, rackToolsKey, reconcileRackOrder } from "./rack-modules";
import { openModuleContextMenu, type ModuleContextMenu, type ModuleMenuAction } from "../modules/context-menu";

const ORDER_KEY = "order.rack";
const SHOW_SCOPE_PROJECT = false;
/** proxy backends shown with an icon: lowercase backend name -> visible Title Case name */
const BACKEND_TITLE: ReadonlyMap<string, string> = new Map([
  ["blender", "Blender"],
  ["rider", "Rider"],
  ["unreal", "Unreal"],
  ["local-llm", "Local LLM"], // no tool starts with "local-llm", so the tool-row brand check never matches it
]);
/** backend row order (2026-10-05); unlisted backends follow, alphabetical */
const BACKEND_ORDER = ["unreal", "rider", "blender", "local-llm"];
const backendRank = (name: string) => {
  const i = BACKEND_ORDER.indexOf(name);
  return i < 0 ? BACKEND_ORDER.length : i;
};
import { summarizeBackend, type BackendStatus } from "./backend-status";

export interface McpServer {
  name: string;
  scope: string;
  transport: string;
  target: string;
  args: string[];
  envKeys: string[];
  project: string | null;
  /** In the focused project's disabledMcpServers; null/absent = unknown (mcp.rs). */
  disabled?: boolean | null;
  /** Claude's approval of a project (.mcp.json) server; absent = approved. Unapproved ones are never listed (mcp.rs). */
  approved?: boolean;
}

// Which config the focused tab reads (project, profile, Codex tab): mcp-focus.ts, shared with
// the rail buttons. Denied servers never arrive; mcp.rs drops them.

// The only visible trace of "disabled here" is a dimmed row: no chip, no label
// Inline because styles.css belongs to another lane; 0.5
// matches the existing disabled-button opacity.
function applyDisabled(row: HTMLElement, disabled: boolean | null | undefined) {
  row.style.opacity = disabled ? "0.5" : "";
}

export interface McpRack {
  servers: McpServer[];
  notes: string[];
}

export interface McpTool {
  name: string;
  description: string;
}


// tools/list is asked of stdio servers (a throwaway copy, mcp.rs; only on a click) and
// loopback http ones; remote http and unapproved servers are never queried.
function queryable(s: McpServer): boolean {
  if (s.approved === false) return false;
  return s.transport === "stdio" || isLoopbackHttp(s.target);
}

// Project/local scope: Claude launches the server in the project dir, so we do
// too (`project` is that dir, mcp.rs read_mcp_servers). User/Codex scope: no override.
function fetchTools(s: McpServer, profile: string | null, tab: string | null): Promise<McpTool[]> {
  if (s.transport !== "stdio") return invoke("list_mcp_tools", { url: s.target });
  // Rust re-reads command, args and cwd from the config and refuses an unapproved project server
  const project = s.scope === "user" || s.scope === "codex" ? null : s.project;
  return invoke("list_mcp_tools_stdio", { name: s.name, scope: s.scope, project, profile, tab });
}

function shortenProject(p: string | null): string {
  if (!p) return "";
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}

export interface RackOptions {
  /** Keep only the servers this returns true for. A filtered rack is a view (rail-stripe.ts):
   *  no LM Studio row and no reorder, so it never writes the left-bar rack's saved order. */
  only?: (s: McpServer) => boolean;
  /** Left-bar mode (index.ts): no server rows and no LM Studio row, since each server has a rail
   *  button; the predicate only trims the Show/Hide menu entries. It still reads and writes the
   *  saved order. */
  exclude?: (s: McpServer) => boolean;
  /** A view of just the LM Studio row (rail-stripe.ts): no server rows, no reorder. */
  lmStudioOnly?: boolean;
  /** Render every row already expanded, by clicking it once on mount (rail drawers). */
  expand?: boolean;
}

// An empty list keeps the left-bar module hidden through its existing CSS; an
// error note stays in the list so a failed read remains visible.
export async function initRack(root: HTMLElement, opts: RackOptions = {}, signal?: AbortSignal): Promise<() => void> {
  const lifetime = new AbortController();
  let generation = 0;
  // The generation on screen and a signature of what it drew: a newer read that changes nothing
  // keeps the rows (and their open state and tool lists) instead of rebuilding them.
  let shown = 0;
  let drawnSig: string | null = null;
  // tools/list answers for this mount, keyed by rackToolsKey: a rebuild reuses them
  const toolsCache = new Map<string, Promise<McpTool[]>>();
  const initialFocus = getFocusedSession();
  // seeded as refresh() derives them, so the first vidar-focus for the same tab is a no-op
  let { project, profile, agent, tab, row } = mcpFocus(initialFocus);
  let visibility = "";
  let retryRead = false;
  let disposed = false;
  let available = new Map<string, string>();
  let menu: ModuleContextMenu | undefined;
  const setHidden = (id: string, hide: boolean) => {
    const hidden = new Set(getPref("modules.hidden") ?? []);
    if (hide) hidden.add(id);
    else hidden.delete(id);
    if (setPref("modules.hidden", [...hidden])) document.dispatchEvent(new CustomEvent("vidar-modules-change"));
  };
  const menuActions = (row?: HTMLElement): ModuleMenuAction[] => {
    const hidden = new Set(getPref("modules.hidden") ?? []);
    const id = row?.dataset.key === "lmstudio" ? "rack:lmstudio" : row?.dataset.key;
    const actions: ModuleMenuAction[] = [];
    if (id && available.has(id)) {
      const label = available.get(id)!;
      actions.push({ label: `Hide ${label}`, kind: "hide", onSelect: () => setHidden(id, true) });
    } else {
      actions.push({ label: `${hidden.has("rack:container") ? "Show" : "Hide"} MCP Rack`,
        kind: hidden.has("rack:container") ? "show" : "hide",
        onSelect: () => setHidden("rack:container", !hidden.has("rack:container")) });
    }
    for (const [entry, label] of available) {
      if (entry === id || !hidden.has(entry)) continue;
      actions.push({ label: `Show ${label}`, kind: "show", onSelect: () => setHidden(entry, false) });
    }
    actions.push({ label: "Modules…", kind: "manage",
      onSelect: () => { void import("../settings/modal").then(({ openShortcutsModal }) => openShortcutsModal("modules")); } });
    return actions;
  };
  const openMenu = (event: MouseEvent | KeyboardEvent, anchor: HTMLElement, row?: HTMLElement) => {
    event.preventDefault();
    event.stopPropagation();
    menu = openModuleContextMenu(anchor, menuActions(row), event instanceof MouseEvent
      ? { x: event.clientX, y: event.clientY }
      : { bar: anchor.closest("#bar-dock") ?? undefined });
  };
  const onContext = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".rack-row[data-key]");
    openMenu(event, row?.querySelector<HTMLElement>(".rack-name") ?? root, row ?? undefined);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".rack-row[data-key]");
    openMenu(event, row?.querySelector<HTMLElement>(".rack-name") ?? root, row ?? undefined);
  };
  root.addEventListener("contextmenu", onContext, { signal: lifetime.signal });
  root.addEventListener("keydown", onKey, { signal: lifetime.signal });
  // The rack box and even #bar-dock can disappear under the empty-rack CSS.
  const dock = root.closest<HTMLElement>("#bar-dock");
  const persistent = dock?.closest<HTMLElement>("#leftbar") ?? dock;
  const replaceRack = (box?: HTMLElement) => {
    const hadFocus = root.contains(document.activeElement);
    root.replaceChildren(...(box ? [box] : []));
    if (!hadFocus || document.activeElement !== document.body) return;
    const target = box?.querySelector<HTMLElement>(".rack-name") ?? (box ? root : persistent ?? root);
    if (target === root || target === persistent) target.tabIndex = -1;
    target.focus();
  };
  if (persistent) {
    const blankDockTarget = (target: HTMLElement) =>
      !target.closest("button, a, .rack-row, .module-box, #bar-foot")
      && (target === persistent || !!target.closest("#bar-dock, .bar-spacer"));
    persistent.addEventListener("contextmenu", (event) => {
      const target = event.target as HTMLElement;
      if (!root.contains(target) && blankDockTarget(target)) onContext(event);
    }, { signal: lifetime.signal });
    persistent.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement;
      if (!root.contains(target) && blankDockTarget(target)) onKey(event);
    }, { signal: lifetime.signal });
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation++;
    menu?.close();
    lifetime.abort();
    signal?.removeEventListener("abort", dispose);
    root.replaceChildren();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) dispose();

  const rebuild = async (next: string | null, nextProfile: string | null, nextAgent: McpFocus["agent"],
    nextTab: string | null, nextRow: string | null, mine: number, hidden: Set<string>) => {
  if (disposed) return;
  menu?.close();
  if (hidden.has("rack:container")) {
    available = new Map();
    if (!disposed && mine === generation) {
      drawnSig = null;
      shown = mine;
      replaceRack();
    }
    return;
  }
  let rack: McpRack;
  let failed = false;
  try {
    // a rail drawer (`only`) shows the focused Codex tab's own row, like the rail button that opened it
    rack = await mcpFocusRead({
      agent: opts.lmStudioOnly ? null : nextAgent, tab: nextTab, project: next, profile: nextProfile, row: nextRow,
    });
  } catch (e) {
    failed = true;
    // the command itself failing is the one case worth shouting about — an
    // absent .claude.json already comes back as a note, not an exception
    rack = { servers: [], notes: [String(e)] };
  }
  if (disposed || mine !== generation) return;
  retryRead = failed;
  // Identity includes project for local/project servers, so equal names in two
  // projects retain separate rows and saved visibility choices.
  rack.servers = dedupeRackServers(rack.servers);
  if (!opts.only && !opts.lmStudioOnly) {
    const saved = getPref(ORDER_KEY) ?? [];
    const order = reconcileRackOrder(saved, rack.servers);
    if (order.length !== saved.length || order.some((id, index) => id !== saved[index])) {
      if (setPref(ORDER_KEY, order)) document.dispatchEvent(new CustomEvent("vidar-modules-change"));
    }
  }
  const only = opts.only;
  const exclude = opts.exclude;
  const lmOnly = !!opts.lmStudioOnly;
  const lmCandidates = rack.servers; // the LM Studio detail names the proxy row that fronts it, shown or not
  if (only) rack.servers = rack.servers.filter(only);
  if (exclude) rack.servers = rack.servers.filter((s) => !exclude(s));
  if (lmOnly) rack.servers = [];
  available = new Map(rack.servers.map((s) => [rackServerId(s), titleWords(s.name) || s.name]));
  if (lmOnly || (!only && !exclude)) available.set("rack:lmstudio", "LM Studio");
  rack.servers = rack.servers.filter((s) => !hidden.has(rackServerId(s)));
  // The left-bar rack (index.ts passes `exclude`) lists no server rows: every server has its own
  // rail button (rail-stripe.ts; 2026-10-15). It still reads, so the saved order and the
  // Show/Hide menu entries stay current; an empty list hides the box (modules.css).
  if (exclude) rack.servers = [];
  const filtered = !!only || lmOnly;
  const lmRow = !hidden.has("rack:lmstudio") && (lmOnly || (!only && !exclude));
  const sig = JSON.stringify([rack.servers, rack.notes, lmRow,
    lmCandidates.filter((s) => s.transport !== "stdio" && isLoopbackHttp(s.target)).map((s) => [s.name, s.target])]);
  if (sig === drawnSig) return;

  const box = document.createElement("div");
  box.className = "module module-box";
  // no visible head (2026-10-05); the box keeps its accessible name
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "MCP Servers");
  box.innerHTML = `<div class="rack-list"></div>`;
  const list = box.querySelector<HTMLElement>(".rack-list")!;

  // Prefetch: start tools/list for every loopback-http server now, so the first
  // expand renders from a settled (or already-failed) promise instead of waiting
  // on the round trip. A stdio server spawns a process, so it is listed only when
  // its List Tools button is clicked; remote and unapproved ones are never queried.
  // The catch below only drops a failed entry; the row's own catch (in loadTools,
  // on expand) still sees the same rejection.
  for (const s of rack.servers) {
    const key = rackToolsKey(s);
    if (s.transport === "stdio" || !queryable(s) || toolsCache.has(key)) continue;
    const p = fetchTools(s, nextProfile, nextTab);
    // a failed prefetch is dropped so the next rebuild asks again
    p.catch(() => { if (toolsCache.get(key) === p) toolsCache.delete(key); });
    toolsCache.set(key, p);
  }

  // Every field below is config-supplied, so all of it goes in as text (rack-row.ts)
  // and none of it as markup.

  for (const s of rack.servers) {
    // display-only: config keys stay lowercase, the rack reads as titles. Scope moved
    // to the detail; the row key still carries it, telling apart two servers sharing
    // a name in different scopes.
    const serverIcon = BACKEND_ICON_MAP.get(backendLookupName(s.name));
    let toolsLoaded = false;
    const { row, name, detail } = rackRow({
      key: rackServerId(s),
      nameParts: [...(serverIcon ? [iconImg(serverIcon)] : []), text("rack-label", titleWords(s.name) || s.name)],
      onOpen: () => {
        if (!toolsLoaded) void loadTools().then(loadBackends);
      },
    });
    row.dataset.server = s.name; // marks server rows for focus refresh below
    const unapproved = s.approved === false;
    applyDisabled(row, s.disabled || unapproved);

    // Scope and Project rows hidden (2026-10-03: not serving us); flip SHOW_SCOPE_PROJECT to restore.
    if (SHOW_SCOPE_PROJECT) detail.appendChild(detailRow("Scope", label(s.scope)));
    // No Transport row (2026-10-03: it says nothing the user needs); the
    // address/command lives on hover of the server name instead.
    // Raw config key first, so it stays copyable now that the label splits it into words.
    name.title = unapproved ? "Not approved in Claude for this project"
      : `${s.name} · ${[s.target, ...s.args].join(" ")}`;
    const proj = shortenProject(s.project);
    if (SHOW_SCOPE_PROJECT && proj) detail.appendChild(detailRow("Project", proj));

    if (s.envKeys.length) {
      const env = document.createElement("p");
      env.className = "dim sub";
      // key names only — Rust never reads the values
      env.textContent = `Env: ${s.envKeys.join(", ")}`;
      detail.appendChild(env);
    }

    // tools: fetched on first expand, cached for the life of this mount
    const tools = document.createElement("div");
    tools.className = "rack-tools item-btn-list";
    detail.appendChild(tools);
    const loadTools = async () => {
      if (disposed || mine !== shown) return;
      toolsLoaded = true;
      // remote http and unapproved servers are not queried: no tool list, no note
      if (!queryable(s)) return;
      if (s.transport === "stdio") {
        // listing spawns the server, so it waits for a click; one click, one listing
        const ask = document.createElement("button");
        ask.type = "button";
        ask.className = "item-btn";
        ask.append(text("item-btn-name", "List Tools"));
        ask.addEventListener("click", () => {
          ask.remove();
          void listTools(ask);
        });
        tools.appendChild(ask);
        return;
      }
      await listTools(null);
    };
    const listTools = async (ask: HTMLElement | null) => {
      const status = text("dim sub", "Querying…");
      tools.appendChild(status);
      let list: McpTool[];
      let asked = toolsCache.get(rackToolsKey(s));
      if (!asked) {
        asked = fetchTools(s, profile, tab);
        toolsCache.set(rackToolsKey(s), asked); // rows sharing a key reuse one listing
      }
      try {
        // a loopback server's prefetch already started its call; reuse the promise
        // so expand renders from what's already settled
        list = await asked;
      } catch (e) {
        if (disposed || mine !== shown) return;
        // failure is "unreachable", never a fake list. The raw error (socket
        // text, os error code) is hover detail, not row text.
        status.textContent = String(e).startsWith("not listed:") ? "Not Listed" : "Can't Reach Server";
        status.title = firstLine(String(e));
        status.className = "sub tool-err";
        // drop the settled rejection so collapse + re-expand retries
        if (toolsCache.get(rackToolsKey(s)) === asked) toolsCache.delete(rackToolsKey(s));
        if (ask) tools.appendChild(ask); // a stdio server retries on another click
        else toolsLoaded = false;
        return;
      }
      if (disposed || mine !== shown) return;
      status.remove();
      if (!list.length) {
        tools.appendChild(text("dim sub", DASH));
        return;
      }
      for (const t of list) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "item-btn";
        // green dot = advertised by a live server (this list only exists after
        // a successful tools/list); no action yet
        const toolLabel = skillLabel(t.name);
        const [first, ...rest] = toolLabel.split(" ");
        const brand = first.toLowerCase();
        const brandIcon = rest.length && BACKEND_TITLE.has(brand) ? BACKEND_ICON_MAP.get(brand) : undefined;
        const nameEl = text("item-btn-name", brandIcon ? rest.join(" ") : toolLabel);
        // dot left, name in the middle, brand icon on the far right (2026-10-05)
        item.append(text("item-btn-dot", ""), nameEl);
        if (brandIcon) item.append(iconImg(brandIcon));
        item.title = t.description || t.name;
        tools.appendChild(item);
      }
    };

    // backends: the :8399 proxy answers GET /status with one block per backend.
    // Asked of every loopback http row AFTER tools/list
    // settles (a listing updates the proxy's record); a 404 is "no status
    // endpoint", not an error. "Last listed" is a record, not a health check.
    const backends = document.createElement("div");
    backends.className = "rack-backends";
    detail.appendChild(backends);
    const loadBackends = async () => {
      if (disposed || mine !== shown) return;
      if (s.transport === "stdio" || !queryable(s)) return;
      let list: BackendStatus[];
      try {
        list = await invoke("proxy_status", { url: s.target });
      } catch {
        if (disposed || mine !== shown) return;
        backends.replaceChildren(); // no status endpoint is a normal server, not a failure
        return;
      }
      if (disposed || mine !== shown) return;
      const rows: { live: boolean; rank: number; name: string; el: HTMLElement }[] = [];
      // local-llm lists its tools whether or not LM Studio is up (it calls LM Studio only when a
      // tool runs), so the proxy's "live" alone would paint it green while LM Studio is down
      let lmDown = false;
      if (list.some((b) => b.name === "local-llm")) {
        lmDown = await invoke("lmstudio_status").then((st) => st.state !== "up", () => false);
      }
      if (disposed || mine !== shown) return;
      for (const b of list) {
        const item = document.createElement("div");
        item.className = "rack-backend mod-line sub";
        const sum = summarizeBackend(b);
        const { title } = sum;
        let { live, parts } = sum;
        if (b.name === "local-llm" && lmDown) {
          live = false;
          parts = [...parts, "LM Studio Not Running"];
        }
        const dot = text(`mod-dot ${live ? "mod-dot-ok" : "mod-dot-off"}`, live ? "● " : "○ ");
        const iconName = BACKEND_ICON_MAP.get(b.name);
        item.append(dot, text("", [BACKEND_TITLE.get(b.name) ?? b.name, ...parts].join(" · ")));
        if (iconName) item.append(iconImg(iconName)); // far right, like the tool rows
        item.title = title;
        rows.push({ live, rank: backendRank(b.name), name: b.name, el: item });
      }
      // online first, then the fixed order, then alphabetical (2026-10-05)
      rows.sort((a, b) => Number(b.live) - Number(a.live) || a.rank - b.rank || a.name.localeCompare(b.name));
      backends.replaceChildren(...rows.map((r) => r.el));
    };

    list.appendChild(row);
  }

  // LM Studio: not an MCP server, but it sits behind the proxy's local-llm
  // backend, so it lives in this list rather than its own card.
  // Same row shape; the detail asks LM Studio directly and names
  // the proxy row that fronts it (panels/lmstudio.ts).
  if (!hidden.has("rack:lmstudio") && (lmOnly || (!only && !exclude))) {
    let loaded = false;
    const { row, detail } = rackRow({
      key: "lmstudio",
      nameParts: [iconImg("lmstudio"), text("rack-label", "LM Studio")],
      onOpen: () => {
        if (loaded) return;
        loaded = true;
        const candidates = lmCandidates
          .filter((s) => s.transport !== "stdio" && isLoopbackHttp(s.target))
          .map((s) => ({ name: s.name, url: s.target }));
        void renderLmStudioDetail(detail, candidates);
      },
    });
    list.appendChild(row);
  }

  if (!filtered) {
    applyOrder(list, ORDER_KEY);
    enableReorder(list, ORDER_KEY);
  } else if (!rack.servers.length && !lmOnly) {
    list.appendChild(text("dim sub", DASH)); // a filtered view with no match still draws, like the full rack
  }

  for (const n of rack.notes) {
    const p = document.createElement("p");
    p.className = "sub tool-err";
    p.textContent = n;
    list.appendChild(p);
  }

  const openKeys = new Set([...root.querySelectorAll<HTMLElement>(".rack-row.open[data-key]")]
    .map((row) => row.dataset.key));
  shown = mine;
  drawnSig = sig;
  replaceRack(box);

  // expand: the rows open as if clicked (same onPress path: tools fetch, detail render)
  for (const n of list.querySelectorAll<HTMLElement>(".rack-row > .rack-name")) {
    if (opts.expand || openKeys.has(n.parentElement?.dataset.key)) n.click();
  }
  };

  const refresh = (focus: FocusedSession | null) => {
    const { project: next, profile: nextProfile, agent: nextAgent, tab: nextTab, row: nextRow } = mcpFocus(focus);
    const hidden = new Set(getPref("modules.hidden") ?? []);
    const nextVisibility = [...hidden].sort().join("\0");
    if (next === project && nextProfile === profile && nextAgent === agent && nextTab === tab && nextRow === row
      && nextVisibility === visibility && !retryRead) return;
    project = next;
    profile = nextProfile;
    agent = nextAgent;
    tab = nextTab;
    row = nextRow;
    visibility = nextVisibility;
    void rebuild(next, nextProfile, nextAgent, nextTab, nextRow, ++generation, hidden);
  };
  document.addEventListener("vidar-focus", (e) => {
    const focus = (e as CustomEvent<FocusedSession | null>).detail;
    refresh(focus);
  }, { signal: lifetime.signal });
  document.addEventListener("vidar-modules-change", () => {
    const focus = getFocusedSession();
    refresh(focus);
  }, { signal: lifetime.signal });
  visibility = [...new Set(getPref("modules.hidden") ?? [])].sort().join("\0");
  await rebuild(project, profile, agent, tab, row, ++generation, new Set(getPref("modules.hidden") ?? []));
  return dispose;
}
