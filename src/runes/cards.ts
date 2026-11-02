// Runes tab DOM: set sections and rune cards, ported from the signed-off sets view
// (tools/runes/view/cards.mjs). A card's summary is Kind slot, name, then the +N chip;
// an opened card shows the frontmatter bar (Edit, Open Folder) over the body. State is dimming only.
import { invoke } from "../ipc";
import { iconImg, type ColorIcon } from "../icon-img";
import { whenMarkdown } from "../panels/markdown-lazy";
import { openablePath } from "./bare/cake";
import { noQuickSelect } from "./set-card";
import { KIND_ICON, KIND_NAME } from "./kind-icons";
import { label as caseLabel, titleWords } from "../format";
import type { RuneItem } from "./types";
import { el } from "../dom";
import { baseAny } from "../paths";

export interface CardCtx {
  openInDocument: (path: string) => void;
  note: (msg: string) => void;
}

const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, "");

// rune display name (data.mjs runeName): drop a leading segment that repeats the folder, then Title Case
export function runeName(r: Pick<RuneItem, "id" | "path">): string {
  const segs = r.id.split(/[-_\s]+/).filter(Boolean), folder = baseAny(dirName(r.path));
  const trimmed = segs[0] === folder && segs.length > 1 ? segs.slice(1) : segs;
  // a doubled id (kit MCP `slack-slack`, module and server alike) reads once; the stored id is unchanged
  const words = trimmed.length === 2 && trimmed[0].toLowerCase() === trimmed[1].toLowerCase() ? trimmed.slice(0, 1) : trimmed;
  // an id may be camelCase or snake_case (item runes); a known acronym keeps its spelling (format.ts table)
  return titleWords(words.join("-")) || words.join(" ");
}

function iconChip(cls: string, icon: ColorIcon, title: string): HTMLElement {
  const c = el("span", cls);
  c.title = title;
  c.setAttribute("aria-label", title);
  c.appendChild(iconImg(icon));
  return c;
}

export interface ScopeKey { icons: Record<string, ColorIcon>; names: Record<string, string> }
/** A Bare library's scope, with the icons the Bare set head uses. */
export const BARE_SCOPE: ScopeKey = { icons: { global: "globe", project: "folder" }, names: { global: "Global", project: "Project" } };

/** Compact key for the card icons, using the same lookup as the cards: the Kind icons in one bordered group, no
 *  label, each named on hover. Scope and Activate have no group and no card chip: the opened bar still reads them. */
export function runeIconKey(): HTMLElement {
  const key = el("div", "runes-key");
  const group = el("span", "runes-key-group");
  for (const [kind, icon] of Object.entries(KIND_ICON)) {
    const item = el("span", "runes-key-item");
    item.title = KIND_NAME[kind];
    item.setAttribute("aria-label", KIND_NAME[kind]);
    item.appendChild(iconImg(icon));
    group.appendChild(item);
  }
  key.appendChild(group);
  return key;
}

function actButton(label: string, icon: ColorIcon, run: () => void): HTMLButtonElement {
  const b = el("button", "runes-act");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label; // icon-only: the label is the tooltip
  b.appendChild(iconImg(icon));
  b.addEventListener("click", (e) => { e.preventDefault(); run(); });
  return b;
}

function fm(k: string, v: Node | string, cls = ""): HTMLElement {
  const f = el("span", `runes-fm${cls}`);
  const val = el("span", "runes-fv");
  val.append(v);
  f.append(el("span", "runes-fk", k), val);
  return f;
}

/** What an opened body can vary: the bar's Scope text, the Kind label, extra fields after Activate, and which actions show. */
export interface BodyOpts { barScope?: string; kindName?: string; fields?: [string, string][]; acts?: ("edit" | "folder")[] }

/** Appends the rendered markdown to `host`; a plain-text pre stands in until the parser has loaded. */
function paintMarkdown(host: HTMLElement, name: string, markdown: string, fallbackText: string): void {
  const pre = el("pre", "doc-text", fallbackText);
  host.appendChild(pre);
  whenMarkdown(({ renderMarkdownOrText }) => {
    const built = renderMarkdownOrText(name, markdown);
    if (!built.fellBack && pre.parentNode === host) pre.replaceWith(built.el);
  });
}

/** The opened card: frontmatter bar (Name, Kind, Scope, Activate, then `fields`, and the actions) over the overview and body. */
export function openedBody(r: CardRune, ctx: CardCtx, o: BodyOpts = {}): HTMLElement {
  const rb = el("div", "runes-rb");
  const bar = el("div", "runes-fmbar");
  const fms = el("span", "runes-fms");
  const scopes = el("span", "runes-fsv");
  scopes.append(o.barScope ?? (r.scope.length ? r.scope.map((s) => caseLabel(s)).join(", ") : "[]"));
  fms.append(fm("Name", r.id, " fname"), fm("Kind", o.kindName ?? caseLabel(r.kind)), fm("Scope", scopes), fm("Activate", caseLabel(r.activate), r.activate === "recall" ? " a-recall" : ""));
  for (const [k, v] of o.fields ?? []) fms.appendChild(fm(k, v));
  if (r.origin?.trim()) fms.appendChild(fm("Origin", r.origin));
  if (r.closesWhen?.trim()) fms.appendChild(fm("Closes When", r.closesWhen));
  const path = openablePath(r.path);
  const want = path ? (o.acts ?? ["edit", "folder"]) : [];
  const acts = el("span", "runes-acts");
  if (want.includes("edit")) acts.appendChild(actButton("Edit", "document-edit", () => ctx.openInDocument(path)));
  if (want.includes("folder")) {
    acts.appendChild(actButton("Open Folder", "folder", () => {
      invoke("open_folder", { path }).catch((e) => ctx.note(`Open Folder Failed: ${String(e)}`));
    }));
  }
  bar.append(fms, acts);
  const body = el("div", "runes-rbody");
  if (r.description) body.appendChild(el("div", "runes-rd", r.description));
  const rt = el("div", "runes-rt");
  paintMarkdown(rt, baseAny(r.path), r.body.trim(), r.body);
  body.appendChild(rt);
  for (const [label, markdown] of [["Why", r.why], ["Example", r.example]] as const) {
    if (!markdown?.trim()) continue;
    const section = el("div", "runes-rt");
    section.appendChild(el("h4", "", label));
    paintMarkdown(section, baseAny(r.path), markdown, markdown);
    body.appendChild(section);
  }
  rb.append(bar, body);
  return rb;
}

/** The fields a card shows (a RuneItem, or a Bare brick's rune). */
export type CardRune = Pick<RuneItem, "id" | "scope" | "activate" | "description" | "path" | "body" | "origin" | "closesWhen" | "why" | "example"> & { kind: string };

export interface CardOpts {
  /** The card's visible name. */
  name: string;
  /** `is-dim`: not loaded (ordinary view) or Off (Bare). */
  dim: boolean;
  /** Extra summary classes after `runes-blk card`, e.g. " rc" or " ps". */
  cls?: string;
  title: string;
  /** Chips first (the ordinary +N). */
  lead?: HTMLElement[];
  /** Controls after them (the Bare switch). */
  tail?: HTMLElement[];
  /** The opened bar's Scope value; default the rune's scope list. */
  barScope?: string;
  /** The first path glob, shown beside the name (Bare paths cards); `title` lists every glob. */
  glob?: { text: string; title: string };
}

/** One rune card: a `details` whose summary is Kind slot, name, then lead / Scope / Activate / tail chips,
 *  and whose frontmatter bar and body are built on first open. */
export function cardDetails(r: CardRune, o: CardOpts, ctx: CardCtx): HTMLDetailsElement {
  const det = el("details", "runes-rn");
  lazyBody(det, () => openedBody(r, ctx, { barScope: o.barScope }));
  if (o.dim) det.classList.add("is-dim");
  const sum = el("summary", `runes-blk card${o.cls ?? ""}`);
  sum.title = o.title;
  noQuickSelect(sum);
  const kslot = el("span", "runes-kslot");
  const kind = iconChip("runes-chip k", KIND_ICON[r.kind] ?? "question", KIND_NAME[r.kind] ?? caseLabel(r.kind));
  kslot.appendChild(kind);
  const chips = el("span", "runes-chips");
  for (const c of o.lead ?? []) chips.appendChild(c);
  for (const c of o.tail ?? []) chips.appendChild(c);
  sum.append(kslot, el("span", "runes-rname", o.name));
  if (o.glob) {
    const g = el("span", "runes-glob", o.glob.text);
    g.title = o.glob.title;
    sum.appendChild(g);
  }
  sum.appendChild(chips);
  det.appendChild(sum);
  // open: the body shows what the tooltips say, so the head and its chips drop them until it closes
  const tips = [...sum.querySelectorAll<HTMLElement>("[title]")].concat(sum).map((n) => [n, n.title] as const);
  det.addEventListener("toggle", () => { for (const [n, t] of tips) n.title = det.open ? "" : t; });
  return det;
}

/** Register `det`'s body: `build` runs on first open (a library of runes renders no markdown until asked) and its
 *  element is appended after the summary; `null` appends nothing yet (the caller calls `fillCard` when it has it). */
export function lazyBody(det: HTMLDetailsElement, build: () => HTMLElement | null): void {
  fillers.set(det, () => {
    if (det.childElementCount !== 1) return;
    const body = build();
    if (body) det.appendChild(body);
  });
  det.addEventListener("toggle", () => fillCard(det));
}

const fillers = new WeakMap<HTMLDetailsElement, () => void>();

/** Build an open card's body now (idempotent; the async toggle would build it a task later). */
export function fillCard(det: HTMLDetailsElement): void {
  if (det.open) fillers.get(det)?.();
}

