// The caption row above a card section (asterisk for required, optional trailing text). A leaf so
// inspector.ts and inspector-run.ts share it without importing each other.

import { text } from "./state";

export function capLabel(labelText: string, opts: { required?: boolean; extra?: string } = {}): HTMLElement {
  const cap = document.createElement("div");
  cap.className = "flow-pop-cap";
  const left = document.createElement("span");
  if (opts.required) {
    const star = document.createElement("span");
    star.className = "flow-inspector-req";
    star.textContent = "*";
    left.append(star);
  }
  left.append(document.createTextNode(labelText));
  cap.append(left);
  if (opts.extra) cap.append(text("", opts.extra));
  return cap;
}
