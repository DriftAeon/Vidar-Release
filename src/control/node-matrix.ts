// Node Matrix: the body of the Run Flow ask, the Open Astra Tab ask and the Relay tool approval card
// (2026-10-20). Single-valued facts sit in an icon grid above; per-node fields are a table
// with nodes as columns and icon labels (tooltip = the field name) in a sticky first column. A value every
// node shares spans one cell; a long value folds to one line and opens on click. Four columns fit a card;
// from the fifth the table scrolls inside its own wrapper, so a column never squishes.
// Everything is set as textContent / attributes: no value is parsed as markup.

export type MatrixIcon = "flow" | "user" | "input" | "model" | "folder" | "shield" | "retry" | "task" | "key"
  | "prompt" | "opens" | "request" | "tool" | "node";

export interface MatrixFact {
  /** the tooltip on the icon (Title Case) */
  label: string;
  icon: MatrixIcon;
  value: string;
  mono?: boolean;
  /** bold, for the card's headline fact */
  strong?: boolean;
  /** shown under the grid as a wrapped mono block instead of a grid row (a command, a payload) */
  block?: boolean;
}
export interface MatrixNode { id: string; title: string }
export interface MatrixField {
  label: string;
  icon: MatrixIcon;
  /** one value per node, in node order */
  cells: string[];
  mono?: boolean;
}
export interface NodeMatrix {
  facts: MatrixFact[];
  nodes: MatrixNode[];
  fields: MatrixField[];
}

/** A value longer than this (or with a line break) folds. */
export const FOLD_AT = 48;
const SVG_NS = "http://www.w3.org/2000/svg";

type Shape = [tag: "path" | "circle" | "rect", attrs: Record<string, string>];
const p = (d: string): Shape => ["path", { d }];
// Lucide glyphs (ISC), geometry as in the approved mock.
const SHAPES: Record<MatrixIcon, Shape[]> = {
  flow: [["rect", { x: "3", y: "3", width: "8", height: "8", rx: "2" }], p("M7 11v4a2 2 0 0 0 2 2h4"), ["rect", { x: "13", y: "13", width: "8", height: "8", rx: "2" }]],
  user: [p("M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"), ["circle", { cx: "12", cy: "7", r: "4" }]],
  input: [p("M17 6H3M21 12H3M15 18H3")],
  model: [["rect", { x: "4", y: "4", width: "16", height: "16", rx: "2" }], ["rect", { x: "9", y: "9", width: "6", height: "6", rx: "1" }], p("M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2")],
  folder: [p("M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z")],
  shield: [p("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"), p("m9 12 2 2 4-4")],
  retry: [p("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"), p("M3 3v5h5")],
  task: [p("M3 6h.01M3 12h.01M3 18h.01M8 6h13M8 12h13M8 18h13")],
  key: [["circle", { cx: "7.5", cy: "15.5", r: "5.5" }], p("m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3")],
  prompt: [p("M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"), p("M14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8")],
  opens: [["rect", { x: "2", y: "4", width: "20", height: "16", rx: "2" }], p("M2 8h20M6 4v4M10 4v4")],
  request: [p("M4 9h16M4 15h16M10 3 8 21M16 3l-2 18")],
  tool: [p("m4 17 6-6-6-6M12 19h8")],
  node: [["circle", { cx: "12", cy: "12", r: "3" }], ["circle", { cx: "12", cy: "12", r: "9" }]],
};

function node(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconEl(icon: MatrixIcon, label: string): HTMLElement {
  const holder = node("span", "nm-ico");
  holder.title = label;
  holder.setAttribute("role", "img");
  holder.setAttribute("aria-label", label);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "nm-i");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of SHAPES[icon]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  holder.append(svg);
  return holder;
}

const folds = (text: string) => text.length > FOLD_AT || text.includes("\n");

/** A folded value: one ellipsised line that opens to the full text on click. */
function foldEl(text: string): HTMLElement {
  const d = node("details", "nm-fold");
  d.append(node("summary", "", text));
  return d;
}

function valueEl(text: string, cls: string): HTMLElement {
  if (folds(text)) {
    const d = foldEl(text);
    if (cls) d.classList.add(...cls.split(" "));
    return d;
  }
  return node("span", cls ? `nm-v ${cls}` : "nm-v", text);
}

export function renderNodeMatrix(m: NodeMatrix): HTMLElement {
  const root = node("div", "nm");
  const grid = m.facts.filter((f) => !f.block);
  if (grid.length) {
    const facts = node("div", "nm-facts");
    for (const f of grid) {
      facts.append(iconEl(f.icon, f.label), valueEl(f.value, [f.mono ? "nm-mono" : "", f.strong ? "nm-strong" : ""].filter(Boolean).join(" ")));
    }
    root.append(facts);
  }
  const fields = m.fields.filter((f) => f.cells.some((c) => c !== ""));
  if (m.nodes.length && fields.length) {
    const wrap = node("div", "nm-scroll");
    const table = node("table", "nm-table") as HTMLTableElement;
    table.style.setProperty("--nm-n", String(m.nodes.length));
    const head = node("tr");
    head.append(node("th"));
    for (const n of m.nodes) {
      const th = node("th", "", n.title);
      th.title = `${n.id}: ${n.title}`;
      head.append(th);
    }
    const thead = node("thead");
    thead.append(head);
    const body = node("tbody");
    for (const f of fields) {
      const tr = node("tr");
      const label = node("td", "nm-key");
      label.append(iconEl(f.icon, f.label));
      tr.append(label);
      const shared = m.nodes.length > 1 && f.cells.every((c) => c === f.cells[0]);
      const cells = shared ? [f.cells[0]] : f.cells;
      for (const text of cells) {
        const td = node("td", [f.mono ? "nm-mono" : "", shared ? "nm-span" : ""].filter(Boolean).join(" ")) as HTMLTableCellElement;
        if (shared) td.colSpan = m.nodes.length;
        if (text) td.append(folds(text) ? foldEl(text) : document.createTextNode(text));
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(thead, body);
    wrap.append(table);
    root.append(wrap);
  }
  for (const f of m.facts.filter((x) => x.block)) {
    const pre = node("div", "nm-pre", f.value);
    pre.title = f.label;
    root.append(pre);
  }
  return root;
}
