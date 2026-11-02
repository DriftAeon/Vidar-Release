/** Shared DOM builders; per-file copies of these drifted in classes and signature. */

/** A `ws-btn` settings button; extra classes follow the base one. */
export function wsButton(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ws-btn ${cls}`.trim();
  b.textContent = label;
  return b;
}

/** A `type="button"` button; text first so lint-copy's `button(` sink judges the label. */
export function button(text: string, cls: string, onClick?: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.disabled = disabled;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

/** One side of a confirm row's decision pair; `cls` follows the pair class. */
export interface PairSide { label: string; run: () => void; cls?: string; disabled?: boolean }

/** A decision-pair confirm row (decision-pair.css): `note`, then `acts` (default `div.swap-confirm-actions`) holding
 *  yes (`.swap-yes`, the red or green fill) and no (`.swap-no`, grey), appended to `root`. `doc` owns the new nodes. */
export function confirmRow(o: {
  root: HTMLElement; note: HTMLElement; yes: PairSide; no: PairSide; acts?: HTMLElement; doc?: Document;
}): { yes: HTMLButtonElement; no: HTMLButtonElement } {
  const doc = o.doc ?? document;
  const side = (base: string, s: PairSide): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = s.cls ? `${base} ${s.cls}` : base;
    b.textContent = s.label;
    if (s.disabled) b.disabled = true;
    b.addEventListener("click", s.run);
    return b;
  };
  let acts = o.acts;
  if (!acts) {
    acts = doc.createElement("div");
    acts.className = "swap-confirm-actions";
  }
  const yes = side("swap-yes", o.yes);
  const no = side("swap-no", o.no);
  acts.append(yes, no);
  o.root.append(o.note, acts);
  return { yes, no };
}

/** A span with a class; text is set only when given. */
export function span(cls: string, text?: string): HTMLSpanElement {
  const e = document.createElement("span");
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A `type="button"` whose label is an icon node: `label` is its aria-label, `tip` its tooltip. */
export function iconBtn(icon: Node, label: string, tip: string, cls = "cx-ico"): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.title = tip;
  b.setAttribute("aria-label", label);
  b.append(icon);
  return b;
}

/** A `type="button"` with a text label and an optional tooltip. */
export function textBtn(label: string, cls: string, tip?: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.textContent = label;
  if (tip) b.title = tip;
  return b;
}

/** An element with an optional class; text is set only when given (textContent, never HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
