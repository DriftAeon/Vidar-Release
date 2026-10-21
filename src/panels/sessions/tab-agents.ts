// Child-agent subtabs paint the Rendered agents block's published summary (agents-block.ts
// subscribeAgents). The block owns lifecycle and its drawer; selecting a subtab focuses that tab
// and opens that agent's row through openAgentRow. The parent carries one square per tracked child,
// closed views included; subtabs are built from the open (not closed) rows only.
import { closeAgentTab, openAgentRow, subscribeAgents, type AgentSummary } from "../rendered/agents-block";
import type { AgentState } from "../rendered/agents-drawer";
import { tabTitleCase } from "./tab-state-format";
import type { TerminalSession } from "./types";

const WORDS: Record<AgentState, string> = { running: "Running", needs: "Needs You", done: "Done", failed: "Failed" };
const PHASES: Record<AgentState, string> = { running: "working", needs: "needs", done: "dead", failed: "lost" };
/** Dots past this many are carried by the subtab list alone. */
const MAX_DOTS = 8;

function text(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}
function attr(node: HTMLElement, name: string, value: string) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/** Drag the parent and its subtabs together, keeping only real tabs in persisted order. */
export function moveTabFamily(button: HTMLElement, before: Element | null) {
  const strip = button.parentElement!;
  const family = button.nextElementSibling;
  const children = family instanceof HTMLElement && family.dataset.parentTab === button.dataset.id ? family : null;
  strip.insertBefore(button, before);
  if (children) strip.insertBefore(children, before);
}

interface Entry { session: TerminalSession; group: HTMLElement; dots: HTMLElement; rows: Map<string, HTMLButtonElement> }

export function initTabAgents(strip: HTMLElement, sessions: ReadonlyMap<string, TerminalSession>, activate: (id: string) => void): () => void {
  const entries = new Map<string, Entry>();
  const blocks = new Map<HTMLElement, readonly AgentSummary[]>(); // live agents blocks, by their element
  let disposed = false;

  function remove(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.group.remove();
    entry.dots.remove();
    entries.delete(id);
  }

  /** The tab's live block: the one its container holds (a body switch disposes the old one). */
  function blockOf(session: TerminalSession): HTMLElement | null {
    for (const host of blocks.keys()) if (session.container.contains(host)) return host;
    return null;
  }

  function buildRow(id: string, session: TerminalSession, agentId: string): HTMLButtonElement {
    const owner = blockOf(session);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "bar-btn agent-subtab";
    const face = document.createElement("span");
    face.className = "tab-face";
    const wheel = document.createElement("span");
    wheel.className = "session-wheel";
    face.appendChild(wheel);
    const name = document.createElement("span");
    name.className = "tab-title";
    const state = document.createElement("span");
    state.className = "tab-sub";
    row.append(face, name, state);
    const close = document.createElement("span");
    close.className = "session-close";
    close.title = "Close Tab";
    close.setAttribute("aria-label", "Close Tab");
    close.setAttribute("role", "button");
    close.tabIndex = 0;
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const host = sessions.get(id) === session ? blockOf(session) : null;
      if (host === owner && host && blocks.get(host)?.some((a) => a.id === agentId)) closeAgentTab(host, agentId);
    });
    close.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      // the row is about to leave: keep keyboard focus on the next subtab, else the previous, else the parent
      const target = row.nextElementSibling ?? row.previousElementSibling ?? sessions.get(id)?.button;
      if (target instanceof HTMLElement) target.focus();
      close.click();
    });
    row.appendChild(close);
    row.addEventListener("click", () => {
      // a replay/body switch can retire the block between paint and click
      const host = sessions.get(id) === session ? blockOf(session) : null;
      if (!host || host !== owner || !blocks.get(host)?.some((a) => a.id === agentId)) return;
      activate(id);
      openAgentRow(host, agentId);
      refresh(id);
    });
    row.addEventListener("contextmenu", (ev) => ev.preventDefault()); // no WebView2 menu (Reload) on a subtab
    return row;
  }

  function refresh(id: string) {
    const entry = entries.get(id);
    if (!entry || sessions.get(id) !== entry.session || entry.session.button.parentElement !== strip) return;
    const { session, group, dots, rows } = entry;
    const host = blockOf(session);
    const tracked = (host && blocks.get(host)) || [];
    const agents = tracked.filter((a) => !a.closed);
    const live = new Set(agents.map((a) => a.id));
    for (const [agentId, row] of rows) {
      if (!live.has(agentId)) { row.remove(); rows.delete(agentId); }
    }
    const parentActive = session.button.classList.contains("active");
    for (const a of agents) {
      let row = rows.get(a.id);
      if (!row) { row = buildRow(id, session, a.id); rows.set(a.id, row); }
      const label = tabTitleCase(a.label.trim() || "Agent");
      const word = WORDS[a.state];
      text(row.querySelector<HTMLElement>(".tab-title")!, label);
      text(row.querySelector<HTMLElement>(".tab-sub")!, word);
      const tip = [label, word, a.title].filter(Boolean).join("\n");
      if (row.title !== tip) row.title = tip;
      if (row.dataset.agent !== session.agent) row.dataset.agent = session.agent;
      if (row.dataset.phase !== PHASES[a.state]) row.dataset.phase = PHASES[a.state];
      const selected = parentActive && a.selected;
      attr(row, "aria-pressed", String(selected));
      row.classList.toggle("active", selected);
      row.classList.toggle("dead", a.state === "done" || a.state === "failed");
    }
    // keep DOM identity/focus across redraws, and follow the block's order on replay
    agents.forEach((a, i) => {
      const row = rows.get(a.id)!;
      if (group.children[i] !== row) group.insertBefore(row, group.children[i] ?? null);
    });
    paintDots(dots, tracked);
    if (group.hidden !== (agents.length === 0)) group.hidden = agents.length === 0;
    attr(group, "aria-label", `${tabTitleCase(session.button.title || "Tab")} Agents`);
    if (session.button.nextElementSibling !== group) strip.insertBefore(group, session.button.nextElementSibling);
  }

  function paintDots(dots: HTMLElement, agents: readonly AgentSummary[]) {
    const shown = agents.slice(0, MAX_DOTS);
    while (dots.children.length > shown.length) dots.lastElementChild!.remove();
    while (dots.children.length < shown.length) {
      const dot = document.createElement("span");
      dot.className = "tab-agent-dot";
      dots.appendChild(dot);
    }
    shown.forEach((a, i) => {
      const dot = dots.children[i] as HTMLElement;
      if (dot.dataset.state !== a.state) dot.dataset.state = a.state;
      const tip = `${tabTitleCase(a.label.trim() || "Agent")}: ${WORDS[a.state].toLowerCase()}`;
      if (dot.title !== tip) dot.title = tip;
    });
    if (dots.hidden !== (shown.length === 0)) dots.hidden = shown.length === 0;
  }

  function sync() {
    if (disposed) return;
    for (const [id, entry] of entries) {
      if (sessions.get(id) !== entry.session || entry.session.button.parentElement !== strip) remove(id);
    }
    for (const [id, session] of sessions) {
      if (session.button.parentElement !== strip) continue;
      if (!entries.has(id)) {
        const group = document.createElement("div");
        group.className = "tab-agents";
        group.dataset.parentTab = id;
        group.setAttribute("role", "group");
        group.hidden = true;
        const dots = document.createElement("span");
        dots.className = "tab-agent-dots";
        dots.hidden = true;
        (session.button.querySelector(".tab-rc") ?? session.button).appendChild(dots);
        entries.set(id, { session, group, dots, rows: new Map() });
      }
      refresh(id);
    }
  }

  const unsubscribe = subscribeAgents((host, agents) => {
    if (disposed) return;
    if (agents) blocks.set(host, agents);
    else blocks.delete(host);
    for (const [id, entry] of entries) {
      if (entry.session.container.contains(host) || entry.rows.size) refresh(id);
    }
  });
  // tab add/remove and drag, the active class (selection) and a rename (button title)
  const observer = new MutationObserver((records) => {
    if (records.some((r) => r.target === strip || (r.type === "attributes" && r.target instanceof HTMLElement && r.target.classList.contains("session-btn")))) sync();
  });
  observer.observe(strip, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "title"] });
  queueMicrotask(sync); // createSession installs its map entry after building the button.
  return () => {
    disposed = true;
    unsubscribe();
    observer.disconnect();
    for (const id of [...entries.keys()]) remove(id);
  };
}
