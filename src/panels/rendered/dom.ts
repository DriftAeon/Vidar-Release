// Small DOM helpers for the Rendered body and its rendered/* modules. Text
// goes in through textContent only (the body's no-innerHTML contract).

import { el } from "../../dom";

export { el };

export function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
