// Relay form for an approval card (view type "card"): the card's label/value rows in the ask modal's
// look (.ask-row, .ask-label, .ask-value) and the shared Approve / Deny pair. One click answers; the
// item resolves through the source, which answers the ask that is still in flight.

import { btn, el } from "../panels/rendered/dom";
import type { RelayItem } from "./store";
import { renderNodeMatrix } from "../control/node-matrix";

export interface CardForm {
  dispose(): void;
}

/** Builds the form for `item` into `host` (replacing its children); null unless item.view is a card. */
export function createCardForm(host: HTMLElement, item: RelayItem, opts: { onNote?(msg: string): void } = {}): CardForm | null {
  if (item.view.type !== "card") return null;
  const form = el("div", "relay-ask-form relay-card-rows");
  if (item.view.matrix) form.append(renderNodeMatrix(item.view.matrix));
  else for (const [label, value] of item.view.rows) {
    const row = el("div", "ask-row");
    row.append(el("span", "ask-label", label), el("span", "ask-value", value));
    form.append(row);
  }
  let commentEl: HTMLTextAreaElement | null = null;
  if (item.view.comment) {
    commentEl = el("textarea", "q-other relay-ask-comment");
    commentEl.rows = 3;
    commentEl.maxLength = 4000;
    commentEl.placeholder = "Additional Info";
    commentEl.setAttribute("aria-label", "Additional Info");
    form.append(commentEl);
  }
  const actions = el("div", "relay-ask-actions");
  let sending = false;
  const decide = async (verdict: "approve" | "deny") => {
    if (sending) return;
    sending = true;
    approve.disabled = true;
    deny.disabled = true;
    if (commentEl) commentEl.disabled = true;
    try {
      await item.resolve({ verdict, comment: (commentEl?.value ?? "").trim() });
    } catch (e) {
      opts.onNote?.(e instanceof Error ? e.message : String(e));
      approve.disabled = false;
      deny.disabled = false;
      if (commentEl) commentEl.disabled = false;
      sending = false;
    }
  };
  const approve = btn("Approve", "relay-approve", () => void decide("approve"));
  const deny = btn("Deny", "relay-deny", () => void decide("deny"));
  actions.append(approve, deny);
  form.append(actions);
  host.replaceChildren(form);
  return { dispose() {} };
}
