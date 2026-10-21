// Settings › Agents › Macros:
// the vidar.json `macros` list the strip under the tabs shows. Label, Command, a Submit toggle
// (sends Enter after the command) and Remove; Add Macro opens a draft that is written only once
// Label and Command are both non-blank.
//
// Same save rule as the Agents rows: every save re-reads vidar.json and edits that fresh list, and
// a row is addressed by its index plus a snapshot of the entry, so a hand edit made while the page
// was open is refused, never overwritten. Unknown fields on an entry ride along (Rust keeps them,
// schema.rs MacroCfg `extra`); read_config's `null`s on the known fields are dropped on the way out.

import { invoke } from "../ipc";
import { invalidateConfig, loadConfig, onSettingsChanged } from "../config";
import type { Macro } from "../panels/macros";
import { isShortcutsModalOpen, REVERT_EVENT } from "./modal";
import { focusOnNextDraw, isRedrawing, liveList, refreshLive, type Live } from "./live-list";
import { addSettingRow } from "./registry";
import { saveRefusal } from "./save-refusal";

type Entry = Macro & Record<string, unknown>;
type SetError = (msg: string) => void;

const KNOWN = ["label", "command", "submit"];
const STALE = "vidar.json Changed While This Page Was Open; Check The Row And Try Again";

async function readFresh(): Promise<{ list: Entry[]; error: string | null }> {
  invalidateConfig();
  const res = await loadConfig();
  return { list: (res.config.macros ?? []) as Entry[], error: res.error };
}

/** What patch_settings gets: known-field nulls dropped, `submit` only when true. */
function toWire(list: readonly Entry[]): Record<string, unknown>[] {
  return list.map((m) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) {
      if (v === undefined) continue;
      if (v === null && KNOWN.includes(k)) continue;
      if (k === "submit" && v !== true) continue;
      out[k] = v;
    }
    return out;
  });
}

function locate(list: readonly Entry[], i: number, sig: string): number | null {
  if (i < list.length && JSON.stringify(list[i]) === sig) return i;
  const k = list.findIndex((m) => JSON.stringify(m) === sig);
  return k < 0 ? null : k;
}

let pendingError: string | null = null;
const live: Live = new Set();
const refreshAll = () => refreshLive(live);

async function save(setError: SetError, op: (list: Entry[]) => Entry[] | string): Promise<boolean> {
  let err: string | null = null;
  const { list, error } = await readFresh();
  if (error) {
    // A file with errors reads without its bad entries; writing that would drop them.
    err = saveRefusal(error);
  } else {
    const next = op(list);
    if (typeof next === "string") err = next;
    else {
      try {
        await invoke("patch_settings", { key: "macros", value: toWire(next) });
      } catch (e) {
        err = String(e);
      }
    }
  }
  if (err === null) {
    setError("");
  } else {
    setError(`Not Saved: ${err}`);
    if (!isShortcutsModalOpen()) {
      pendingError = `Not Saved: ${err}`;
      console.warn(`settings: macros not saved: ${err}`);
    }
  }
  refreshAll();
  return err === null;
}

function button(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ws-btn ${cls}`.trim();
  b.textContent = label;
  return b;
}

/** Commits on change (blur or Enter), reverts on Escape / REVERT_EVENT; `commit` returning false reverts. */
function field(
  cls: string,
  value: string,
  placeholder: string,
  commit: (v: string) => boolean | void,
  onInput?: (v: string) => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = `sc-input ${cls}`.trim();
  input.spellcheck = false;
  input.value = value;
  input.defaultValue = value;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  const revert = () => { input.value = value; };
  input.addEventListener("change", () => {
    if (isRedrawing()) return;
    const v = input.value.trim();
    if (v === value) return;
    if (commit(v) === false) revert();
  });
  if (onInput) input.addEventListener("input", () => onInput(input.value));
  input.addEventListener(REVERT_EVENT, revert);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") revert();
    e.stopPropagation();
  });
  return input;
}

function submitToggle(on: boolean, onClick: () => void): HTMLButtonElement {
  const b = button("Submit");
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Sends Enter after the command. Click to type it without sending." : "Types the command without sending it. Click to send Enter after it.";
  b.addEventListener("click", onClick);
  return b;
}

interface Draft { label: string; command: string; submit: boolean }
let draft: Draft | null = null;

function control(setError: SetError): HTMLElement {
  if (pendingError) {
    setError(pendingError);
    pendingError = null;
  }
  const draw = (root: HTMLElement, list: Entry[]) => {
    list.forEach((m, i) => {
      const sig = JSON.stringify(m);
      const at = (fresh: Entry[], edit: (fresh: Entry[], k: number) => Entry[]) => {
        const k = locate(fresh, i, sig);
        return k === null ? STALE : edit(fresh, k);
      };
      const replace = (patch: Partial<Macro>) =>
        void save(setError, (fresh) => at(fresh, (f, k) => f.map((x, n) => (n === k ? { ...x, ...patch } : x))));
      const row = document.createElement("div");
      row.className = "ws-row";
      const label = field("ag-label", m.label ?? "", "Label", (next) => {
        if (next === "") return false;
        replace({ label: next });
      });
      const command = field("ag-cmd", m.command ?? "", "Command", (next) => {
        if (next === "") return false;
        replace({ command: next });
      });
      const on = m.submit === true;
      const submit = submitToggle(on, () => {
        submit.disabled = true;
        replace({ submit: !on });
      });
      const remove = button("Remove", "ws-remove");
      remove.addEventListener("click", () => {
        remove.disabled = true;
        void save(setError, (fresh) => at(fresh, (f, k) => f.filter((_, n) => n !== k)));
      });
      row.append(label, command, submit, remove);
      root.appendChild(row);
    });

    if (draft) {
      const d = draft;
      const row = document.createElement("div");
      row.className = "ws-row ag-draft";
      const tryAdd = () => {
        if (d.label.trim() === "" || d.command.trim() === "") return;
        const entry: Entry = { label: d.label.trim(), command: d.command.trim(), submit: d.submit };
        void save(setError, (fresh) => [...fresh, entry]).then((ok) => {
          if (ok && draft === d) {
            draft = null;
            refreshAll();
          }
        });
      };
      const label = field("ag-label", d.label, "Label", (next) => { d.label = next; tryAdd(); }, (raw) => { d.label = raw; });
      const command = field("ag-cmd", d.command, "Command", (next) => { d.command = next; tryAdd(); }, (raw) => { d.command = raw; });
      const submit = submitToggle(d.submit, () => {
        d.submit = !d.submit;
        submit.setAttribute("aria-pressed", String(d.submit));
      });
      const discard = button("Discard", "ws-remove");
      discard.addEventListener("click", () => { draft = null; setError(""); refreshAll(); });
      row.append(label, command, submit, discard);
      root.appendChild(row);
    }

    const add = button("Add Macro", "ws-add");
    add.disabled = draft !== null;
    add.addEventListener("click", () => {
      draft = { label: "", command: "", submit: false };
      focusOnNextDraw(root, ".ag-draft .ag-label");
      refreshAll();
    });
    root.appendChild(add);
  };

  return liveList(live, readFresh, (root, { list }) => draw(root, list));
}

let registered = false;

/** The Macros row, on the page `category` names (the Agents page). */
export function registerMacroRows(category: string): void {
  if (registered) return;
  registered = true;
  addSettingRow({
    name: "Macros",
    tip: "Buttons on the strip under the tabs. Each types its command into the active tab.",
    category,
    wide: true,
    keywords: () => "macro strip command submit",
    control,
  });
  onSettingsChanged((e) => { if (e.keys.includes("macros")) refreshAll(); });
}
