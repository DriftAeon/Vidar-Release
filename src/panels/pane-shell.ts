// The workbench pane shell shared by Display and Document: a column with a head row
// over a framed body (styles/workbench.css .wb-pane / .wb-pane-head / .wb-pane-frame).
// Plain DOM, no CSS or Tauri imports, so jsdom tests can load the panels.

export interface PaneShellOpts {
  id: string;
  head: { id?: string; cls?: string };
  frame: { id?: string; cls?: string };
  /** The frame itself scrolls: the framed box is an outer element and `frame` is the scroller inside it,
   *  so its scrollbar can sit past the box's border, in #workbench's right gutter. */
  scroll?: boolean;
}

export interface PaneShell {
  root: HTMLElement;
  head: HTMLElement;
  frame: HTMLElement;
}

function part(base: string, o: { id?: string; cls?: string }): HTMLElement {
  const el = document.createElement("div");
  if (o.id) el.id = o.id;
  el.className = o.cls ? `${o.cls} ${base}` : base;
  return el;
}

export function paneShell(o: PaneShellOpts): PaneShell {
  const root = document.createElement("div");
  root.id = o.id;
  root.className = "wb-pane";
  const head = part("wb-pane-head", o.head);
  const frame = part(o.scroll ? "wb-pane-scroll" : "wb-pane-frame", o.frame);
  if (o.scroll) {
    const box = document.createElement("div");
    box.className = "wb-pane-frame wb-pane-box";
    box.append(frame);
    root.append(head, box);
  } else {
    root.append(head, frame);
  }
  return { root, head, frame };
}
