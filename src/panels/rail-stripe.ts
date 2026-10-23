// src\panels\rail-stripe.ts — buttons at the bottom of the empty right rail, each opening a drawer:
// one per MCP server the focused tab's config lists (2026-10-15: "one button per mcp server"),
// LM Studio, and Proxy MCP at the bottom (a drawer, chosen over a popover and a peek, 2026-10-10).
// Content is the rack itself, filtered to the one row (rack.ts initRack `only` / `lmStudioOnly`).
// A drawer is fixed on body (menus escape overflow) and never widens the rail; Escape and an outside
// press close it; one is open at a time. Look: styles/rail.css.
import { iconImg, type ColorIcon } from "../icon-img";
import { invoke } from "../ipc";
import { getPref } from "../prefs";
import { mcpFocus, mcpFocusKey } from "./mcp-focus";
import { initRack, type McpRack, type RackOptions } from "./rack";
import { isProxyServer, rackServerId, railServers, type RailServer } from "./rack-modules";
import { getFocusedSession, type FocusedSession } from "./sessions";

interface Drawer { close: () => void; btn: HTMLButtonElement; surface: HTMLElement; remove: () => void }

// The same reader the rack uses for this focus (rack.ts rebuild): a Codex tab's own config,
// else Claude's, with the tab's launch profile selecting its home.
function readFocused(s: FocusedSession | null): { key: string; read: () => Promise<McpRack> } {
  const f = mcpFocus(s);
  const { tab, project, profile } = f;
  return { key: mcpFocusKey(f), read: f.agent === "codex"
    ? () => invoke("read_codex_mcp_servers", { tab, profile })
    : () => invoke("read_mcp_servers", { project, profile }) };
}

export function initRailStripe(host: HTMLElement, signal: AbortSignal): void {
  const drawers: Drawer[] = [];

  const make = (title: string, icon: ColorIcon, rack: RackOptions, before: Element | null = null): Drawer => {
    let isOpen = false;
    let rackLifetime: AbortController | null = null;
    const own = new AbortController();
    signal.addEventListener("abort", () => own.abort(), { signal: own.signal });
    const opts = { signal: own.signal };

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool-btn rail-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.append(iconImg(icon));

    const surface = document.createElement("div");
    surface.className = "rail-surface rail-drawer hidden";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-label", title);
    document.body.appendChild(surface);
    host.insertBefore(btn, before);

    const close = () => {
      if (!isOpen) return;
      rackLifetime?.abort();
      rackLifetime = null;
      surface.classList.add("hidden");
      btn.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      isOpen = false;
    };

    const show = () => {
      for (const d of drawers) if (d.btn !== btn) d.close();
      // runs down to the bottom bar's top edge (the bar's rect, not the rail's)
      const barTop = document.getElementById("bottombar")?.getBoundingClientRect().top ?? window.innerHeight;
      const gap = `${Math.max(0, window.innerHeight - barTop)}px`;
      surface.style.bottom = gap;
      surface.style.setProperty("--rail-bottom", gap);
      surface.classList.remove("hidden");
      btn.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      isOpen = true;
      rackLifetime = new AbortController();
      void initRack(surface, rack, rackLifetime.signal);
    };

    btn.addEventListener("click", () => { if (isOpen) close(); else show(); }, opts);

    document.addEventListener("pointerdown", (e) => {
      if (!isOpen) return;
      const t = e.target as Node;
      if (surface.contains(t) || host.contains(t)) return; // the buttons decide for themselves
      close();
    }, opts);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !isOpen) return;
      const back = surface.contains(document.activeElement) ? btn : null;
      close();
      back?.focus();
    }, opts);
    // the bottom edge is measured on open; a resize would leave it stale
    window.addEventListener("resize", close, opts);

    const remove = () => {
      rackLifetime?.abort();
      own.abort();
      surface.remove();
      btn.remove();
      const i = drawers.findIndex((d) => d.btn === btn);
      if (i >= 0) drawers.splice(i, 1);
    };
    signal.addEventListener("abort", () => {
      rackLifetime?.abort();
      surface.remove();
    }, opts);
    const drawer = { close, btn, surface, remove };
    drawers.push(drawer);
    return drawer;
  };

  // LM Studio first in the DOM: the stack is bottom-aligned, so it sits above Proxy MCP;
  // the per-server buttons go above both, in the rack's saved order
  const lm = make("LM Studio", "lmstudio", { lmStudioOnly: true, expand: true });
  const proxyDrawer = make("Proxy MCP", "proxy", { only: isProxyServer, expand: true });
  let servers: { sig: string; drawers: Drawer[] } = { sig: "", drawers: [] };

  const placeServers = (shown: RailServer[]) => {
    const sig = JSON.stringify(shown.map((e) => [e.id, e.title, e.icon]));
    if (sig === servers.sig) return;
    for (const d of servers.drawers) d.remove();
    servers = {
      sig,
      drawers: shown.map((e) => make(e.title, e.icon as ColorIcon,
        { only: (s) => !isProxyServer(s) && rackServerId(s) === e.id, expand: true }, lm.btn)),
    };
  };

  // A button shows only while its module is visible for the focused tab (same ids as the rack).
  // Keep the last button list per focus so a failed read can still apply saved visibility; an
  // empty successful read has no row for a drawer to show.
  // lastKey: the focus key whose read is on screen or in flight; a focus event for the same key
  // (a tab switch inside one project) rereads nothing, a modules change always does.
  let generation = 0;
  let lastKey: string | null = null;
  const known = new Map<string, ReturnType<typeof railServers>>();
  const sync = async (): Promise<void> => {
    const mine = ++generation;
    const hidden = new Set(getPref("modules.hidden") ?? []);
    const container = hidden.has("rack:container");
    const lmShown = !container && !hidden.has("rack:lmstudio");
    let list: ReturnType<typeof railServers> = { proxy: null, others: [] };
    if (container) lastKey = null;
    else {
      const { key, read } = readFocused(getFocusedSession());
      lastKey = key;
      list = known.get(key) ?? list;
      try {
        const rack = await read();
        if (signal.aborted || mine !== generation) return;
        list = railServers(rack.servers, getPref("order.rack") ?? []);
        if (list.proxy || list.others.length) known.set(key, list);
      } catch {
        if (signal.aborted || mine !== generation) return;
        lastKey = null; // a failed read is retried on the next focus
      }
    }
    const proxyShown = !!list.proxy && !hidden.has(list.proxy.id);
    for (const [d, shown] of [[lm, lmShown], [proxyDrawer, proxyShown]] as const) {
      d.btn.classList.toggle("hidden", !shown);
      if (!shown) d.close();
    }
    placeServers(list.others.filter((e) => !hidden.has(e.id)));
  };
  const resync = () => { void sync(); };
  document.addEventListener("vidar-modules-change", resync, { signal });
  document.addEventListener("vidar-focus", () => {
    if (readFocused(getFocusedSession()).key !== lastKey) resync();
  }, { signal });
  resync();

  signal.addEventListener("abort", () => host.replaceChildren());
}
