// Changes tab Asset Diff slot store (DOM half; pure helpers in asset-diff.ts): the expanded keys and
// their last result live here, so a list rebuild redraws each slot from the store instead of losing it.
import { el } from "../dom";
import { errText } from "../err-text";
import type { UnrealAssetDiff } from "../ipc";
import { diffLines } from "./asset-diff";

export type SlotState = { kind: "busy" } | { kind: "done"; diff: UnrealAssetDiff } | { kind: "error"; message: string };
interface Entry { state: SlotState; slot: HTMLElement | null }

export function buildSlots() {
  const entries = new Map<string, Entry>();
  let root = "";

  function paint(e: Entry) {
    const slot = e.slot;
    if (!slot) return;
    slot.replaceChildren();
    if (e.state.kind === "busy") return;
    if (e.state.kind === "error") {
      const line = el("div", "cx-note cx-note-err");
      line.setAttribute("role", "alert");
      const msg = el("span", "cx-note-msg");
      msg.textContent = e.state.message;
      line.append(msg);
      slot.append(line);
      return;
    }
    for (const l of diffLines(e.state.diff)) {
      const row = el("div", "cx-row");
      const t = el("span", l.dim ? "cx-dir" : "cx-fname");
      t.textContent = l.text;
      if (l.tip) row.title = l.tip;
      row.append(t);
      slot.append(row);
    }
  }

  return {
    /** Another repo root drops every expanded slot. */
    forRoot(r: string) { if (r !== root) { root = r; entries.clear(); } },
    state(key: string): SlotState | null { return entries.get(key)?.state ?? null; },
    /** The slot element for a freshly drawn row, or null when that row is collapsed. */
    attach(key: string): HTMLElement | null {
      const e = entries.get(key);
      if (!e) return null;
      e.slot = el("div", "cx-asset-slot");
      paint(e);
      return e.slot;
    },
    /** Collapses an open slot (true); false = it was closed and the caller starts a read. */
    collapse(key: string): boolean {
      const e = entries.get(key);
      if (!e) return false;
      e.slot?.remove();
      entries.delete(key);
      return true;
    },
    /** Starts a read; `after` redraws the pressed row's button; `place` inserts the slot under the row. */
    async open(key: string, read: () => Promise<UnrealAssetDiff>, place: (slot: HTMLElement) => void, after: () => void) {
      const e: Entry = { state: { kind: "busy" }, slot: el("div", "cx-asset-slot") };
      entries.set(key, e);
      place(e.slot!);
      after();
      try {
        e.state = { kind: "done", diff: await read() };
      } catch (err) {
        e.state = { kind: "error", message: errText(err) };
      }
      if (entries.get(key) !== e) return;
      paint(e);
      after();
    },
  };
}
