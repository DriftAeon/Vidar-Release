// The shapes a status-line value takes: a pill (a button the user can click to change it, or a
// span when it is read-only) and a plain value. The button pill is a control() (built once,
// patched in place); the model and mode cells differ only in the classes, icon and title they pass.

import { control, type Control, type ControlState } from "../controls/control";
import { el } from "./dom";
import { svgEl, type IconName } from "./icons";

export interface StatusPillOpts {
  icon?: IconName;
  /** classes after `st-btn st-pill` */
  cls: string;
  onPress: () => void;
}

/** A clickable status pill that opens a menu: optional icon, then text. Text, title and state
 *  arrive through `set()`; the icon's tooltip follows the title. */
export function statusPill(o: StatusPillOpts): Control {
  const icon = o.icon ? svgEl(o.icon, "") : null;
  const iconTitle = icon?.querySelector("title") ?? null;
  const c = control({ cls: `st-btn st-pill ${o.cls}`, textCls: "pill-text", lead: icon ? [icon] : undefined, menu: true, onPress: o.onPress });
  return {
    el: c.el,
    live: c.live,
    set(p: ControlState) {
      c.set(p);
      if (iconTitle && p.title !== undefined && iconTitle.textContent !== p.title) iconTitle.textContent = p.title;
    },
  };
}

/** A read-only status pill (a span): optional icon, text. */
export function statusTag(o: { icon?: IconName; text: string; cls: string; title?: string }): HTMLSpanElement {
  const pill = el("span", `st-pill ${o.cls}`);
  if (o.icon) pill.appendChild(svgEl(o.icon, o.title ?? o.text));
  pill.appendChild(el("span", "pill-text", o.text));
  if (o.title !== undefined) pill.title = o.title;
  return pill;
}

/** A read-only status cell. */
export function statusValue(text: string, cls: string, title?: string): HTMLElement {
  const s = el("span", cls, text);
  if (title !== undefined) s.title = title;
  return s;
}
