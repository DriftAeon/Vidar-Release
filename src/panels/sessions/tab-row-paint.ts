// Paints tab-state store changes onto the left-bar rows: data-phase, data-need, the reason and
// model line and right column (N4). Attributes and text only; a slot is `hidden` while it has no text.

import { subscribe } from "./tab-state-store";
import { reasonText, type TabState } from "./tab-state";
import { modelRowName } from "../../format";
import type { RelayItem } from "../../relay/store";

function rowOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`button.session-btn[data-id="${CSS.escape(id)}"]`);
}

/** A hidden-until-it-has-text slot span. */
export function tabRowSlot(cls: string): HTMLElement {
  const slot = document.createElement("span");
  slot.className = cls;
  slot.hidden = true; // tab-row-paint shows a slot while it has text
  return slot;
}

/** The row's right column (N4): an amber chip when it needs you, `Stopped`
 *  when dead, `Disconnected` when the host link dropped. One slot is visible at a time; the column's tooltip carries the full reason. */
export function buildRightColumn(): HTMLElement {
  const rc = document.createElement("span");
  rc.className = "tab-rc";
  for (const cls of ["tab-chip", "tab-stopped"]) rc.appendChild(tabRowSlot(cls));
  return rc;
}

function setSlot(row: HTMLElement, cls: string, text: string): void {
  const slot = row.querySelector<HTMLElement>(`.${cls}`);
  if (!slot) return;
  slot.textContent = text;
  slot.hidden = !text;
}

function paint(id: string, st: TabState): void {
  const row = rowOf(id);
  if (!row) return;
  row.dataset.phase = st.phase;
  const need = st.reason?.kind;
  if (need) row.dataset.need = need;
  else delete row.dataset.need;
  // line two: the model only (empty while unknown)
  setSlot(row, "tab-model", st.model ? modelRowName(st.model) : "");
  // right column: needs-you chip > Stopped > nothing
  const r = st.reason;
  const chip = !r ? "" : r.kind === "question" ? "?" : r.kind === "permission" ? "1" : String(r.count); // one pending tool per tab; the tool name stays in the tooltip
  setSlot(row, "tab-chip", chip);
  const ended = st.phase === "dead" ? "Stopped" : st.phase === "lost" ? "Disconnected" : "";
  setSlot(row, "tab-stopped", r ? "" : ended);
  const rc = row.querySelector<HTMLElement>(".tab-rc");
  if (rc) rc.title = r ? reasonText(r) : ended;
}

/** Start painting rows from the store. */
export function startTabRowPaint(): void {
  subscribe((id, st) => {
    if (st) paint(id, st); // null: the button is gone
  });
}

/** Relay.ts render(): the count by kind in the Relay row's reason slot, and its need marker. */
export function paintRelayRow(list: readonly RelayItem[]): void {
  const btn = document.getElementById("relay-btn");
  if (!btn) return;
  const asks = list.filter((i) => i.view.type === "ask").length;
  setSlot(btn, "tab-chip", asks > 0 ? String(asks) : "");
  const rc = btn.querySelector<HTMLElement>(".tab-rc");
  if (rc) rc.title = asks > 0 ? reasonText({ kind: "relay", count: asks }) : ""; // copy-ok: reason kind id, not shown
  if (asks > 0) btn.dataset.need = "relay";
  else delete btn.dataset.need;
}
