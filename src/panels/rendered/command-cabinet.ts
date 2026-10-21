// Command cabinet of a Claude Rendered body: an icon button in the status bar, right of the
// effort segments, that opens a grouped list of the slash commands as buttons. A pick does what
// the slash palette's pick does (palette.ts): the composer takes "/name " unsent and keeps focus.

import { DASH } from "../../format";
import { iconImg } from "../../icon-img";
import { btn, el } from "./dom";
import type { RenderedState } from "./state";

/** Answered by the body itself (events.ts LOCAL_COMMANDS), so they work when typed whatever the session lists. */
const RENDERED_CONTROLS = ["model", "effort", "resume", "clear"];

export interface CabinetGroup { title: string; commands: string[] }

/** The session's command names grouped by source: Rendered controls, plugin commands (`plugin:name`), then the rest. */
export function groupCommands(commands: readonly string[], query = ""): CabinetGroup[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  const names = [...new Set(commands.map((c) => c.replace(/^\//, "")))];
  const keep = (c: string) => c.toLowerCase().includes(q);
  const controls = RENDERED_CONTROLS.filter(keep);
  const rest = names.filter((c) => !RENDERED_CONTROLS.includes(c) && keep(c));
  const groups: CabinetGroup[] = [
    { title: "Skills", commands: rest.filter((c) => !c.includes(":")).sort() },
    { title: "Plugins", commands: rest.filter((c) => c.includes(":")).sort() },
    { title: "Rendered Controls", commands: controls },
  ];
  return groups.filter((g) => g.commands.length);
}

export interface CabinetDeps { textarea: HTMLTextAreaElement }

export function createCommandCabinet(S: RenderedState, deps: CabinetDeps) {
  const { textarea } = deps;
  const button = el("button", "st-btn st-pill cabinet-btn");
  button.type = "button";
  button.title = "Commands";
  button.setAttribute("aria-label", "Commands");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.append(iconImg("filing-cabinet"));

  let panel: HTMLElement | null = null;
  let offAway: (() => void) | null = null;

  function close(refocus = false) {
    offAway?.(); offAway = null;
    panel?.remove(); panel = null;
    button.setAttribute("aria-expanded", "false");
    if (refocus && button.isConnected) button.focus();
  }

  function pick(name: string) {
    textarea.value = `/${name} `;
    close();
    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
  }

  const CABINET_MAX_H = 360; // about ten rows; the list scrolls past it
  function place(p: HTMLElement) {
    const r = button.getBoundingClientRect();
    const barTop = (button.closest<HTMLElement>(".rendered-status") ?? button).getBoundingClientRect().top;
    const left = Math.max(8, Math.min(r.right - p.offsetWidth, window.innerWidth - p.offsetWidth - 8));
    p.style.left = `${left}px`;
    p.style.maxHeight = `${Math.max(120, Math.min(barTop - 16, CABINET_MAX_H))}px`;
    p.style.top = `${Math.max(8, barTop - p.offsetHeight - 4)}px`;
  }

  function open() {
    const p = el("div", "cabinet-panel");
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", "Commands");
    const search = el("input", "cabinet-search");
    search.type = "search";
    search.placeholder = "Commands";
    search.setAttribute("aria-label", "Filter Commands");
    const list = el("div", "cabinet-list");
    const draw = () => {
      list.textContent = "";
      const groups = groupCommands(S.commands, search.value);
      for (const g of groups) {
        list.append(el("div", "cabinet-group", g.title));
        for (const c of g.commands) list.append(btn(`/${c}`, "cabinet-row", () => pick(c)));
      }
      if (!groups.length) list.append(el("p", "cabinet-empty", DASH));
      place(p);
    };
    search.addEventListener("input", draw);
    p.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(true); return; }
      if (e.key === "Enter" && e.target === search) {
        e.preventDefault();
        list.querySelector<HTMLButtonElement>("button")?.click();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const rows = [...list.querySelectorAll<HTMLButtonElement>("button")];
      if (!rows.length) return;
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      rows[i < 0 ? (step > 0 ? 0 : rows.length - 1) : (i + step + rows.length) % rows.length].focus();
    });
    p.append(search, list);
    document.body.appendChild(p);
    panel = p;
    button.setAttribute("aria-expanded", "true");
    draw();
    setTimeout(() => {
      if (panel !== p) return; // closed before the opening click finished
      const away = (e: MouseEvent) => { if (!p.contains(e.target as Node) && !button.contains(e.target as Node)) close(); };
      document.addEventListener("click", away);
      offAway = () => document.removeEventListener("click", away);
    }, 0);
    search.focus();
  }

  button.addEventListener("click", () => { if (panel) close(true); else open(); });
  return { button, close };
}
