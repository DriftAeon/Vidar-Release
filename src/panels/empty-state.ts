// The shared empty state (centred stack): icon, title, optional note and path, then
// actions, then an optional alert line. Not Connected (Jira, Slack, Notion) and Not a Git Repository
// (Changes) draw through it; the CSS is src/styles/empty-state.css. Remote or runtime text goes in through
// textContent or title only.
import { iconImg } from "../icon-img";
import { lucide } from "../icons";

export type ModuleBrand = "jira" | "slack" | "notion";

export interface EmptyStateOptions {
  icon: Element;
  title: string;
  note?: string;
  path?: string;
  actions?: HTMLElement[];
  /** One line under the actions, with the alert icon. */
  alert?: string | null;
}

export const HIDE_TIP = "Hides this tab. Settings › Modules shows it again.";

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function button(cls: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.addEventListener("click", () => run());
  return b;
}

/** The module's colour mark, sized by the empty-state CSS. */
export function brandIcon(brand: ModuleBrand): Element {
  const img = iconImg(brand);
  img.classList.add("es-icon");
  return img;
}

/** The pane's own line icon (Lucide), drawn at the same size and weight as the brand marks. */
export function lineIcon(name: Parameters<typeof lucide>[0]): Element {
  return lucide(name, "icn es-icon");
}

/** A main action: the decision pair's green (`.ws-btn.ws-add`, decision-pair.css). */
export function goButton(label: string, run: () => void): HTMLButtonElement {
  const b = button("ws-btn ws-add", run); // copy-ok: class names, not copy
  b.textContent = label;
  return b;
}

/** Hide as an icon-only Sheen button; the tooltip names it. */
export function hideButton(run: () => void): HTMLButtonElement {
  const b = button("ws-btn cx-ico es-ico", run); // copy-ok: class names, not copy
  b.title = "Hide"; // copy-ok: single-word tooltip
  b.setAttribute("aria-label", "Hide");
  b.append(lucide("eye-off"));
  return b;
}

/** Not Connected actions: Connect, then Hide. */
export function connectActions(connect: () => void, hide: () => void): HTMLElement[] {
  return [goButton("Connect", connect), hideButton(hide)];
}

function parts(o: EmptyStateOptions): HTMLElement[] {
  const out: HTMLElement[] = [];
  o.icon.classList.add("es-icon");
  out.push(o.icon as HTMLElement, span("es-title", o.title));
  if (o.note) out.push(span("es-note", o.note));
  if (o.path) out.push(span("es-path", o.path));
  if (o.actions?.length) {
    const acts = document.createElement("div");
    acts.className = "es-acts";
    acts.append(...o.actions);
    out.push(acts);
  }
  if (o.alert) {
    const a = document.createElement("div");
    a.className = "es-alert";
    a.append(lucide("circle-alert"), span("es-alert-msg", o.alert));
    out.push(a);
  }
  return out;
}

/** Draws into an existing host (the pane's empty element): marks it `.empty-state`, replaces its children. */
export function fillEmptyState(host: HTMLElement, o: EmptyStateOptions): void {
  host.classList.add("empty-state");
  host.replaceChildren(...parts(o));
}

/** The host goes back to the pane's plain empty look (titles, errors). */
export function clearEmptyState(host: HTMLElement): void {
  host.classList.remove("empty-state");
}

/** A standalone empty state (Notion's notice, which has no shared host). */
export function buildEmptyState(o: EmptyStateOptions, cls = ""): HTMLElement {
  const host = document.createElement("div");
  if (cls) host.className = cls;
  fillEmptyState(host, o);
  return host;
}
