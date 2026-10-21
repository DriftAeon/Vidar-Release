// Settings › General › Document App: the vidar.json `documentApp` exe that Open Externally
// uses on a document (`chrome.rs` open_document). One text field and Save, the Editor row's
// pattern (editor.ts); blank sends "" and the key is removed, so the Windows default app opens
// documents. commands.rs validate_document_app is the authority (existing .exe, never
// .cmd/.bat); its refusal is shown on the row.

import { invoke } from "../ipc";
import { invalidateConfig, loadConfig, onSettingsChanged } from "../config";
import { REVERT_EVENT } from "./modal";
import { addSettingRow } from "./registry";

const live = new Set<{ root: HTMLElement; render: () => void }>();

function control(setError: (msg: string) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "ws-list ag-list";

  const exe = document.createElement("input");
  exe.type = "text";
  exe.className = "sc-input ag-label";
  exe.spellcheck = false;
  exe.placeholder = "Exe";
  exe.setAttribute("aria-label", "Exe");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ws-btn";
  saveBtn.textContent = "Save";

  let saved = "";
  const dirty = () => exe.value.trim() !== saved;
  const paint = () => { saveBtn.disabled = !dirty(); };
  const revert = () => { exe.value = saved; paint(); };

  let gen = 0;
  const render = () => {
    const mine = ++gen;
    invalidateConfig();
    void loadConfig().then(({ config }) => {
      if (mine !== gen) return;
      saved = typeof config.documentApp === "string" ? config.documentApp.trim() : "";
      revert();
    });
  };

  const save = () => {
    if (!dirty()) return;
    saveBtn.disabled = true;
    invoke("patch_settings", { key: "documentApp", value: exe.value.trim() }).then(
      () => { setError(""); render(); },
      (e) => { setError(`Not Saved: ${String(e)}`); paint(); }, // the typed value stays, to fix
    );
  };

  exe.addEventListener("input", paint);
  exe.addEventListener(REVERT_EVENT, revert);
  exe.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") save();
    if (ev.key === "Escape") revert();
    ev.stopPropagation(); // typing is not a shortcut (general.ts)
  });
  saveBtn.addEventListener("click", save);

  const row = document.createElement("div");
  row.className = "ws-row";
  row.append(exe, saveBtn);
  root.append(row);
  live.add({ root, render });
  render();
  return root;
}

let registered = false;

/** The Document App row; general.ts calls this right after the Editor row. */
export function registerDocumentAppRow(category: string): void {
  if (registered) return;
  registered = true;
  addSettingRow({
    name: "Document App",
    tip: "Opens documents from Open Externally. Blank uses the Windows default app.",
    category,
    wide: true,
    keywords: () => "document app open externally markdown md typora vs code exe default",
    control,
  });
  onSettingsChanged((e) => {
    if (!e.keys.includes("documentApp")) return;
    for (const r of live) {
      if (!r.root.isConnected) live.delete(r);
      else r.render();
    }
  });
}
