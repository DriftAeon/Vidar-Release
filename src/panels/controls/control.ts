// One interactive control, built once and patched in place (docs/shelf/controls-build-once.md
// § Convention). `set()` diffs against the last state and touches only what changed; the node is
// never replaced, so focus, hover and aria-expanded survive a state change.
// State vocabulary: can't act at all (dead, starting) = native `disabled`, which drops focus;
// blocked for a while (turn, card) = aria-disabled="true" + data-block, still focusable; in flight =
// aria-disabled + aria-busy. aria-disabled still delivers clicks (and Enter/Space, which a button
// turns into a click), so every press goes through the guard below, never a caller's own listener.
// No runtime imports: tests load this file straight into node.

export interface ControlState {
  text?: string;
  title?: string;
  /** can't act at all: the native `disabled` */
  disabled?: boolean;
  /** temporarily blocked; a string names the reason ("turn", "card") in data-block */
  blocked?: boolean | string;
  /** a change is in flight */
  pending?: boolean;
  current?: boolean;
  /** only for a menu opener (`menu: true`) */
  expanded?: boolean;
}

export interface ControlOpts extends ControlState {
  /** the button's class list */
  cls: string;
  onPress: () => void;
  /** text goes into a child span of this class; unset: a bare text node */
  textCls?: string;
  /** nodes placed before the text (an icon) */
  lead?: Node[];
  /** how `current` is spelled: aria-current (rows, tabs; default) or aria-pressed (segments) */
  currentAttr?: "aria-current" | "aria-pressed";
  /** opens a menu: aria-haspopup="menu" and aria-expanded kept as "true"/"false" */
  menu?: boolean;
}

export interface Control {
  readonly el: HTMLButtonElement;
  set(patch: ControlState): void;
  /** true while a press would reach onPress (not disabled, blocked or pending) */
  live(): boolean;
}

export function control(o: ControlOpts): Control {
  const b = document.createElement("button");
  b.type = "button";
  b.className = o.cls;
  const currentAttr = o.currentAttr ?? "aria-current";
  if (o.menu) {
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
  }
  if (currentAttr === "aria-pressed") b.setAttribute("aria-pressed", "false");
  if (o.lead) b.append(...o.lead);
  let setText: (t: string) => void;
  if (o.textCls) {
    const span = document.createElement("span");
    span.className = o.textCls;
    b.appendChild(span);
    setText = (t) => { span.textContent = t; };
  } else {
    const node = document.createTextNode("");
    b.appendChild(node);
    setText = (t) => { node.data = t; };
  }

  // last written state; the defaults match a fresh button, so the first set() writes only what differs
  let text = "";
  let title = "";
  let disabled = false;
  let block: string | null = null;
  let pending = false;
  let current = false;
  let ariaDisabled = false;

  const live = () => !b.disabled && b.getAttribute("aria-disabled") !== "true";

  function set(p: ControlState) {
    if (p.text !== undefined && p.text !== text) { text = p.text; setText(text); }
    if (p.title !== undefined && p.title !== title) { title = p.title; b.title = title; }
    if (p.disabled !== undefined && p.disabled !== disabled) { disabled = p.disabled; b.disabled = disabled; }
    if (p.blocked !== undefined) {
      const next = p.blocked === false ? null : p.blocked === true ? "" : p.blocked;
      if (next !== block) {
        block = next;
        if (block === null) delete b.dataset.block;
        else b.dataset.block = block;
      }
    }
    if (p.pending !== undefined && p.pending !== pending) {
      pending = p.pending;
      if (pending) b.setAttribute("aria-busy", "true");
      else b.removeAttribute("aria-busy");
    }
    const nextAria = block !== null || pending;
    if (nextAria !== ariaDisabled) {
      ariaDisabled = nextAria;
      if (ariaDisabled) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    }
    if (p.current !== undefined && p.current !== current) {
      current = p.current;
      if (currentAttr === "aria-pressed") b.setAttribute("aria-pressed", String(current));
      else if (current) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
    // read back from the node: the menu that opens from this control also writes aria-expanded
    if (o.menu && p.expanded !== undefined && p.expanded !== (b.getAttribute("aria-expanded") === "true")) {
      b.setAttribute("aria-expanded", String(p.expanded));
    }
  }

  // the press guard: registered first, so a blocked press stops here (and does not bubble, as a
  // click on a natively disabled button never does)
  b.addEventListener("click", (e) => {
    if (!live()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    o.onPress();
  });

  set(o);
  return { el: b, set, live };
}
