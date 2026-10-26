// Relay form for an approval card (view type "card"): the card's fields as a bold label over a
// full-width value (piped text split into steps, Windows paths as chips) and the shared Approve / Deny pair. One click answers; the
// item resolves through the source, which answers the ask that is still in flight.

import { btn, el } from "../panels/rendered/dom";
import type { RelayItem } from "./store";
import { renderNodeMatrix } from "../control/node-matrix";
import { isMonoField, parseSteps, splitUnverified, type Step } from "./card-fields";

/** One field: a bold label over its value; piped text becomes steps, Windows paths become chips. */
function fieldRow(label: string, raw: string): HTMLElement {
  const { value, unverified } = label === "Asked By" ? splitUnverified(raw) : { value: raw, unverified: false };
  const row = el("div", "relay-card-field");
  const val = el("div", "relay-card-value");
  if (isMonoField(label, value)) val.classList.add("mono");
  const steps = parseSteps(value);
  if (steps.length === 1) fillStep(val, steps[0]);
  else {
    val.classList.add("relay-card-steps");
    for (const s of steps) {
      const step = el("div", "relay-card-step");
      fillStep(step, s);
      val.append(step);
    }
  }
  if (unverified) {
    const flag = el("span", "relay-card-flag", "Unverified");
    flag.title = "Unverified: the asker is the name the request file gives";
    val.append(flag);
  }
  row.append(el("div", "relay-card-label", label), val);
  return row;
}

function fillStep(host: HTMLElement, step: Step): void {
  for (const seg of step) {
    if (seg.kind === "text") {
      host.append(document.createTextNode(seg.text));
      continue;
    }
    const chip = el("span", "relay-card-chip");
    chip.title = seg.path;
    chip.append(el("span", "relay-card-chip-dir", seg.dir), el("span", "relay-card-chip-file", seg.file));
    host.append(chip);
  }
}

export interface CardForm {
  dispose(): void;
}

/** Builds the form for `item` into `host` (replacing its children); null unless item.view is a card. */
export function createCardForm(host: HTMLElement, item: RelayItem, opts: { onNote?(msg: string): void } = {}): CardForm | null {
  if (item.view.type !== "card") return null;
  const form = el("div", "relay-ask-form relay-card-rows");
  const fields = el("div", "relay-card-fields");
  if (item.view.matrix) {
    const f = el("div", "relay-card-field");
    f.append(renderNodeMatrix(item.view.matrix));
    fields.append(f);
  } else for (const [label, raw] of item.view.rows) fields.append(fieldRow(label, raw));
  form.append(fields);
  let commentEl: HTMLTextAreaElement | null = null;
  if (item.view.comment) {
    commentEl = el("textarea", "q-other relay-ask-comment");
    commentEl.rows = 1;
    commentEl.maxLength = 4000;
    commentEl.placeholder = "Additional Info";
    commentEl.setAttribute("aria-label", "Additional Info");
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
  const tail = el("div", "relay-ask-tail");
  if (commentEl) tail.append(commentEl);
  tail.append(actions);
  form.append(tail);
  host.replaceChildren(form);
  return { dispose() {} };
}
