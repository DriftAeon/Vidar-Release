// Runes tab DOM: set sections and rune cards, ported from the signed-off sets view
// (tools/runes/view/cards.mjs). A card's summary is Kind slot, name, then +N / Scope / Activate chips;
// an opened card shows the frontmatter bar (Edit, Open Folder) over the body. State is dimming only.
import { invoke } from "../ipc";
import { iconImg, type ColorIcon } from "../icon-img";
import { renderMarkdownOrText } from "../panels/markdown-build";
import { isPluginTarget, type TracedLibrary, type TracedSet } from "./trace";
import type { RuneItem, RuneSet, RuneSetMember } from "./types";

export interface CardCtx {
  openInDocument: (path: string) => void;
  note: (msg: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const TC = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const KIND_NAME: Record<string, string> = { rule: "Rule", fact: "Fact", procedure: "Procedure" };
// The signed-off sets view used rules.svg, a book and todo_list.svg. Those assets are
// not in the app icon set, so these are the closest installed equivalents.
const KIND_ICON: Record<string, ColorIcon> = { rule: "shield", fact: "read", procedure: "flow" };
const SCOPE_ICON: Record<string, ColorIcon> = { global: "globe", vidar: "vidar" };
const ACT_ICON: Record<string, ColorIcon> = { always: "lock", paths: "floppy", recall: "restore" };
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, "");

// rune display name (data.mjs runeName): drop a leading segment that repeats the folder, then Title Case
const ACRO: Record<string, string> = { ui: "UI", cli: "CLI", json: "JSON", dom: "DOM", npm: "npm", rg: "rg", exe: "EXE",
  pty: "PTY", md: "MD", rs: "RS", ps1: "PS1", ps51: "PS 5.1", utf8: "UTF-8", css: "CSS", git: "Git", vs: "vs",
  powershell: "PowerShell", readme: "README", textcontent: "textContent" };
const MINOR = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs"]);
export function runeName(r: RuneItem): string {
  const segs = r.id.split("-"), folder = baseName(dirName(r.path));
  const words = segs[0] === folder && segs.length > 1 ? segs.slice(1) : segs;
  return words.map((w, i) => ACRO[w] ?? (i > 0 && MINOR.has(w) ? w : TC(w))).join(" ");
}

export const setTitle = (s: RuneSet): string =>
  s.target ? baseName(s.target).replace(/\.md$/i, "") : s.id.split("-").map(TC).join(" ");

/** The set header's condition slot: empty for every-session sets, a floppy icon for Load on Touch
 *  (paths in the tooltip, as the sets view), text for plugin, recall and not-loaded sets. */
function fillCondition(cond: HTMLElement, s: RuneSet): void {
  if (isPluginTarget(s)) { cond.textContent = "Via Plugin Hook"; return; }
  if (s.tier === 1) return;
  if (s.tier === 2) {
    cond.title = `Load on Touch\nLoads when Claude touches:\n${s.paths.join("\n")}`;
    cond.appendChild(iconImg("floppy"));
    return;
  }
  cond.textContent = s.tier === 3 ? "Pointer Lines, Read on Recall" : "Not Loaded";
}

/** Hue class per set (data.mjs hues mapped onto tokens in styles/runes.css). */
function hueOf(s: RuneSet): string {
  const b = s.target ? baseName(s.target).toLowerCase() : "";
  if (s.tier === 1) return b === "agents.md" ? "hue-agents" : "hue-claude";
  if (s.tier === 2) return "hue-path";
  return s.tier === 3 ? "hue-recall" : "hue-none";
}

function iconChip(cls: string, icon: ColorIcon, title: string): HTMLElement {
  const c = el("span", cls);
  c.title = title;
  c.setAttribute("aria-label", title);
  c.appendChild(iconImg(icon));
  return c;
}

export interface ScopeKey { icons: Record<string, ColorIcon>; names: Record<string, string> }
/** A Bare library's scope (`bare_actives` `scope`), with the icons the Bare set head uses. */
export const BARE_SCOPE: ScopeKey = { icons: { global: "globe", project: "folder" }, names: { global: "Global", project: "Project" } };

/** Compact key for the card icons, using the same lookup as the cards; `scope` swaps the Scope group. */
export function runeIconKey(scope?: ScopeKey): HTMLElement {
  const key = el("div", "runes-key");
  const groups: [string, Record<string, ColorIcon>, Record<string, string>][] = [
    ["Kind", KIND_ICON, KIND_NAME],
    ["Scope", scope?.icons ?? SCOPE_ICON, scope?.names ?? { global: "Global", vidar: "Vidar" }],
    ["Activate", ACT_ICON, { always: "Always", paths: "Paths", recall: "Recall" }],
  ];
  for (const [label, entries, names] of groups) {
    const group = el("span", "runes-key-group");
    group.appendChild(el("span", "runes-key-label", label));
    for (const [kind, icon] of Object.entries(entries)) {
      const item = el("span", "runes-key-item");
      item.title = names[kind];
      item.setAttribute("aria-label", names[kind]);
      item.appendChild(iconImg(icon));
      group.appendChild(item);
    }
    key.appendChild(group);
  }
  return key;
}

function actButton(label: string, icon: ColorIcon, run: () => void): HTMLButtonElement {
  const b = el("button", "runes-act");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.append(iconImg(icon), el("span", "", label));
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

function openedBody(r: CardRune, ctx: CardCtx, barScope?: string): HTMLElement {
  const rb = el("div", "runes-rb");
  const bar = el("div", "runes-fmbar");
  const fms = el("span", "runes-fms");
  const scopes = el("span", "runes-fsv");
  scopes.append(barScope ?? (r.scope.length ? r.scope.map(TC).join(", ") : "[]"));
  fms.append(fm("Name", r.id, " fname"), fm("Kind", TC(r.kind)), fm("Scope", scopes), fm("Activate", TC(r.activate), r.activate === "recall" ? " a-recall" : ""));
  const acts = el("span", "runes-acts");
  acts.append(
    actButton("Edit", "document-edit", () => ctx.openInDocument(r.path)),
    actButton("Open Folder", "folder", () => {
      invoke("open_folder", { path: r.path }).catch((e) => ctx.note(`Open Folder Failed: ${String(e)}`));
    }),
  );
  bar.append(fms, acts);
  const body = el("div", "runes-rbody");
  if (r.description) body.appendChild(el("div", "runes-rd", r.description));
  const built = renderMarkdownOrText(baseName(r.path), r.body.trim());
  const rt = el("div", "runes-rt");
  if (built.fellBack) rt.appendChild(el("pre", "doc-text", r.body));
  else rt.appendChild(built.el);
  body.appendChild(rt);
  rb.append(bar, body);
  return rb;
}

/** The fields a card shows (a RuneItem, or a Bare brick's rune). */
export type CardRune = Pick<RuneItem, "id" | "scope" | "activate" | "description" | "path" | "body"> & { kind: string };

export interface CardOpts {
  /** The card's visible name. */
  name: string;
  /** `is-dim`: not loaded (ordinary view) or Off (Bare). */
  dim: boolean;
  /** Extra summary classes after `runes-blk card`, e.g. " rc" or " ps". */
  cls?: string;
  title: string;
  /** Chips before the scope chips (the ordinary +N). */
  lead?: HTMLElement[];
  /** The scope chips: icon and tooltip each. */
  scopes: { icon: ColorIcon; title: string }[];
  /** Controls after the Activate chip (the Bare switch). */
  tail?: HTMLElement[];
  /** The opened bar's Scope value; default the rune's scope list. */
  barScope?: string;
}

/** One rune card: a `details` whose summary is Kind slot, name, then lead / Scope / Activate / tail chips,
 *  and whose frontmatter bar and body are built on first open. */
export function cardDetails(r: CardRune, o: CardOpts, ctx: CardCtx): HTMLDetailsElement {
  const det = el("details", "runes-rn");
  fillers.set(det, () => {
    if (det.childElementCount === 1) det.appendChild(openedBody(r, ctx, o.barScope));
  });
  if (o.dim) det.classList.add("is-dim");
  const sum = el("summary", `runes-blk card${o.cls ?? ""}`);
  sum.title = o.title;
  const kslot = el("span", "runes-kslot");
  const kind = iconChip("runes-chip k", KIND_ICON[r.kind] ?? "question", `Kind: ${KIND_NAME[r.kind] ?? TC(r.kind)}`);
  kslot.appendChild(kind);
  const chips = el("span", "runes-chips");
  for (const c of o.lead ?? []) chips.appendChild(c);
  for (const s of o.scopes) chips.appendChild(iconChip("runes-chip", s.icon, s.title));
  const act = iconChip(`runes-chip${r.activate === "recall" ? " a-recall" : ""}`, ACT_ICON[r.activate] ?? "question", `Activate: ${TC(r.activate)}`);
  chips.appendChild(act);
  for (const c of o.tail ?? []) chips.appendChild(c);
  sum.append(kslot, el("span", "runes-rname", o.name), chips);
  det.appendChild(sum);
  // the body is built on first open: a library of runes renders no markdown until asked
  det.addEventListener("toggle", () => fillCard(det));
  return det;
}

// Open-state keys live outside the DOM (the shape test pins the markup): `lib/set` and `lib/set/rune`.
const openKeyOf = new WeakMap<HTMLDetailsElement, string>();
const fillers = new WeakMap<HTMLDetailsElement, () => void>();

/** Build an open card's body now (idempotent; the async toggle would build it a task later). */
export function fillCard(det: HTMLDetailsElement): void {
  if (det.open) fillers.get(det)?.();
}

/** The keys of the open sets and cards under `host`. */
export function openKeys(host: ParentNode): Set<string> {
  const out = new Set<string>();
  for (const d of host.querySelectorAll("details")) {
    const k = openKeyOf.get(d);
    if (k && d.open) out.add(k);
  }
  return out;
}

/** Open the sets and cards under `host` whose key is in `keys`, bodies built at once. */
export function reopen(host: ParentNode, keys: Set<string>): void {
  if (!keys.size) return;
  for (const d of host.querySelectorAll("details")) {
    const k = openKeyOf.get(d);
    if (!k || !keys.has(k)) continue;
    d.open = true;
    fillCard(d);
  }
}

function runeCard(t: TracedLibrary, ctx: CardCtx, m: RuneSetMember, inSet: TracedSet): HTMLElement {
  const r = t.lib.runes.find((x) => x.id === m.id);
  if (!r) {
    const miss = el("div", "runes-blk missing");
    miss.appendChild(el("span", "runes-rname", m.id));
    return miss;
  }
  const others = (t.setsOf.get(r.id) ?? []).filter((x) => x !== inSet.set.id);
  const lead: HTMLElement[] = [];
  if (others.length) {
    const also = el("span", "runes-chip also", `+${others.length}`);
    also.title = `Also in ${others.join(", ")}`;
    lead.push(also);
  }
  const chipScope = r.scope.filter((sc) => !sc.startsWith("!"));
  const card = cardDetails(r, {
    name: runeName(r),
    dim: t.runeLoaded.get(r.id) === false,
    cls: m.recall ? " rc" : inSet.set.tier === 2 ? " ps" : "",
    title: `${r.id}\n${r.description}${others.length ? `\nAlso in ${others.join(", ")}` : ""}${m.recall ? "\nRecall: pointer line only" : ""}`,
    lead,
    scopes: (chipScope.length ? chipScope : ["(none)"]).map((sc) => ({
      icon: SCOPE_ICON[sc] ?? "question", title: `Scope: ${sc === "(none)" ? "None" : TC(sc)}`,
    })),
  }, ctx);
  openKeyOf.set(card, `${t.lib.key}/${inSet.set.id}/${r.id}`);
  return card;
}

export function setSection(t: TracedLibrary, ts: TracedSet, ctx: CardCtx): HTMLElement {
  const s = ts.set;
  const det = el("details", `runes-set ${hueOf(s)}`);
  if (ts.state === "Not Loaded" || ts.state === "On Touch") det.classList.add("is-dim");
  const sum = el("summary", "runes-set-head");
  sum.title = `${s.id}\n${s.target ?? "No file"}${s.paths.length ? `\n${s.paths.join("\n")}` : ""}`;
  const scp = el("span", "runes-scp");
  scp.appendChild(iconImg(s.scope.includes("global") ? "globe" : "vidar"));
  const cond = el("span", "runes-cond");
  fillCondition(cond, s);
  sum.append(scp, el("span", "runes-sn", setTitle(s)), cond, el("span", "runes-sc", String(s.members.length)));
  const tray = el("div", "runes-tray");
  for (const m of s.members) tray.appendChild(runeCard(t, ctx, m, ts));
  det.append(sum, tray);
  openKeyOf.set(det, `${t.lib.key}/${s.id}`);
  return det;
}
