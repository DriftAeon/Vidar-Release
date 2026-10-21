// Settings › General › Editor:
// the vidar.json `editor` object that file:line links open, `{exe, args}`. Exe is a text field,
// Args is one text field split on whitespace (an argument with spaces is hand-edit territory).
// Presets only fill Args. Save sends `{exe, args}`; an empty Exe sends "" and the key is removed.
// commands.rs validate_editor is the authority (.exe that exists, one arg containing {file}); its
// refusal is shown on the row.
//
// Fallback: with no `editor` (or a blank exe) editor.rs resolve() uses a non-blank legacy
// `riderPath` as Rider. The row then says so and offers Clear, which removes `riderPath`; without
// that line the row would look empty while links still open Rider.

import { invoke } from "../ipc";
import { invalidateConfig, loadConfig, onSettingsChanged, type VidarConfig } from "../config";
import { isShortcutsModalOpen, REVERT_EVENT } from "./modal";
import { addSettingRow } from "./registry";

type SetError = (msg: string) => void;

const PRESETS: [string, string][] = [
  ["VS Code", "--goto {file}:{line}"],
  ["Rider", "--line {line} {file}"],
  ["Zed", "{file}:{line}"],
];

interface Saved { exe: string; args: string; riderPath: string }

// read_config lets `editor` through as-is: an object, or a hand-written bare string. Missing or
// null args run as ["{file}"] (editor.rs DEFAULT_ARGS), so that is what the field shows.
function savedOf(cfg: VidarConfig): Saved {
  const ed: unknown = cfg.editor;
  let exe = "";
  let args: string[] | null = null;
  if (typeof ed === "string") exe = ed;
  else if (ed && typeof ed === "object") {
    const o = ed as { exe?: unknown; args?: unknown };
    if (typeof o.exe === "string") exe = o.exe;
    if (Array.isArray(o.args)) args = o.args.filter((a): a is string => typeof a === "string");
  }
  return {
    exe: exe.trim(),
    args: (args && args.length ? args : ["{file}"]).join(" "),
    riderPath: typeof cfg.riderPath === "string" ? cfg.riderPath.trim() : "",
  };
}

let pendingError: string | null = null;

function report(setError: SetError, err: string | null): void {
  if (err === null) {
    setError("");
    return;
  }
  setError(`Not Saved: ${err}`);
  if (!isShortcutsModalOpen()) {
    pendingError = `Not Saved: ${err}`;
    console.warn(`settings: editor not saved: ${err}`);
  }
}

async function patch(key: "editor" | "riderPath", value: unknown): Promise<string | null> {
  try {
    await invoke("patch_settings", { key, value });
    return null;
  } catch (e) {
    return String(e);
  }
}

function button(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ws-btn ${cls}`.trim();
  b.textContent = label;
  return b;
}

function input(cls: string, placeholder: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = "text";
  el.className = `sc-input ${cls}`;
  el.spellcheck = false;
  el.placeholder = placeholder;
  el.setAttribute("aria-label", placeholder);
  return el;
}

const live = new Set<{ root: HTMLElement; render: () => void }>();

function control(setError: SetError): HTMLElement {
  if (pendingError) {
    setError(pendingError);
    pendingError = null;
  }
  const root = document.createElement("div");
  root.className = "ws-list ag-list";

  const exe = input("ag-label", "Exe");
  const args = input("ag-cmd", "Args With {file}");
  const saveBtn = button("Save");
  const presets = document.createElement("div");
  presets.className = "editor-presets";
  const presetLabel = document.createElement("span");
  presetLabel.className = "editor-presets-label";
  presetLabel.textContent = "Presets";
  presets.appendChild(presetLabel);
  const rider = document.createElement("div");
  rider.className = "rider-line";

  let saved: Saved = { exe: "", args: "{file}", riderPath: "" };
  const dirty = () => exe.value.trim() !== saved.exe || args.value.trim().split(/\s+/).join(" ") !== saved.args;
  const paint = () => { saveBtn.disabled = !dirty(); };
  const revert = () => {
    exe.value = saved.exe;
    args.value = saved.args;
    paint();
  };

  const drawRider = () => {
    rider.replaceChildren();
    // Mirrors editor.rs resolve(): riderPath applies only while editor has no non-blank exe.
    if (saved.exe !== "" || saved.riderPath === "") {
      rider.remove(); // not [hidden]: .rider-line's display:flex would override it
      return;
    }
    if (rider.parentElement !== root) root.appendChild(rider);
    const text = document.createElement("span");
    const code = document.createElement("code");
    code.textContent = saved.riderPath;
    text.append("Using Rider Path: ", code);
    const clear = button("Clear", "ws-remove");
    clear.title = "Removes riderPath from vidar.json. Links stop opening Rider after a restart.";
    clear.addEventListener("click", () => {
      clear.disabled = true;
      void patch("riderPath", "").then((err) => {
        report(setError, err);
        render();
      });
    });
    rider.append(text, clear);
  };

  let gen = 0;
  const render = () => {
    const mine = ++gen;
    invalidateConfig();
    void loadConfig().then(({ config }) => {
      if (mine !== gen) return;
      saved = savedOf(config);
      revert();
      drawRider();
    });
  };

  const save = () => {
    if (!dirty()) return;
    const e = exe.value.trim();
    const a = args.value.trim().split(/\s+/).filter((s) => s !== "");
    saveBtn.disabled = true;
    void patch("editor", e === "" ? "" : { exe: e, args: a }).then((err) => {
      report(setError, err);
      // On a refusal the typed values stay, so the user can fix them; on success the file is truth.
      if (err === null) render();
      else paint();
    });
  };

  for (const el of [exe, args]) {
    el.addEventListener("input", paint);
    el.addEventListener(REVERT_EVENT, revert);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") save();
      if (ev.key === "Escape") revert();
      ev.stopPropagation(); // typing is not a shortcut (general.ts)
    });
  }
  saveBtn.addEventListener("click", save);
  for (const [name, value] of PRESETS) {
    const b = button(name);
    b.title = `Args: ${value}`;
    b.addEventListener("click", () => {
      args.value = value;
      paint();
      exe.focus();
    });
    presets.appendChild(b);
  }

  const row = document.createElement("div");
  row.className = "ws-row";
  row.append(exe, args, saveBtn);
  root.append(row, presets);
  live.add({ root, render });
  render();
  return root;
}

let registered = false;

/** The Editor row; general.ts calls this so it sits on the General page. */
export function registerEditorRow(category: string): void {
  if (registered) return;
  registered = true;
  addSettingRow({
    name: "Editor",
    description: "Turning links on or off applies after a restart.", // note-ok: user, 2026-10-01 (restart consequence)
    tip: "Opens file links.",
    category,
    wide: true,
    keywords: () => "editor rider vs code zed file link exe args riderPath",
    control,
  });
  onSettingsChanged((e) => {
    if (!e.keys.includes("editor") && !e.keys.includes("riderPath")) return;
    for (const r of live) {
      if (!r.root.isConnected) live.delete(r);
      else r.render();
    }
  });
}
