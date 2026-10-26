// Settings › Workspaces: the list editor for vidar.json `locations` — the folders the launcher
// opens agents in. Name (editable), Browse (re-pick the folder), path, Remove; Add Workspace
// picks a folder and names it after the folder. Every edit saves the whole list at once.
import type { Location } from "../config";
import { folderName, pickFolder, saveWorkspaces, workspaces } from "../launcher/workspaces";
import { REVERT_EVENT } from "./modal";
import { isRedrawing, redraw } from "./live-list";
import { addSettingRow, registerCategory } from "./registry";

const WORKSPACES_CATEGORY = "workspaces";

function button(label: string, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `ws-btn ${cls}`.trim();
  b.textContent = label;
  return b;
}

function editor(setError: (msg: string) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "ws-list";

  const save = async (edit: (fresh: Location[]) => Location[]) => {
    try {
      await saveWorkspaces(edit);
      setError("");
    } catch (e) {
      setError(`Not Saved: ${String(e)}`);
    }
    render();
  };

  const render = () => redraw(root, () => {
    workspaces.forEach((w) => {
      const row = document.createElement("div");
      row.className = "ws-row";

      const name = document.createElement("input");
      name.className = "sc-input ws-name";
      name.spellcheck = false;
      name.value = w.label;
      name.defaultValue = w.label;
      name.setAttribute("aria-label", "Workspace Name");
      name.title = w.label;
      const revert = () => { name.value = w.label; };
      name.addEventListener("change", () => {
        if (isRedrawing()) return;
        const label = name.value.trim();
        if (!label || label === w.label) return revert();
        void save((fresh) => fresh.map((x) => (x.cwd === w.cwd ? { ...x, label } : x)));
      });
      name.addEventListener(REVERT_EVENT, revert);
      name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") name.blur();
        if (e.key === "Escape") revert();
        e.stopPropagation(); // same as General's inputs: typing is not a shortcut
      });

      const browse = button("Browse");
      browse.title = "Choose A Different Folder";
      browse.addEventListener("click", () => {
        void pickFolder(w.cwd).then((cwd) => {
          if (cwd && cwd !== w.cwd) void save((fresh) => fresh.map((x) => (x.cwd === w.cwd ? { ...x, cwd } : x)));
        }, (e) => setError(String(e)));
      });

      const path = document.createElement("span");
      path.className = "ws-path";
      path.textContent = w.cwd;
      path.title = w.cwd;

      const remove = button("Remove", "ws-remove");
      remove.addEventListener("click", () => {
        void save((fresh) => fresh.filter((x) => x.cwd !== w.cwd));
      });
      row.append(name, path, browse, remove);
      root.appendChild(row);
    });
    const add = button("Add Workspace", "ws-add");
    add.addEventListener("click", () => {
      void pickFolder().then((cwd) => {
        if (cwd) void save((fresh) => [...fresh, { label: folderName(cwd), cwd }]);
      }, (e) => setError(String(e)));
    });
    root.appendChild(add);
  });

  render();
  return root;
}

let registered = false;

/** Adds the Workspaces page once, above Keybinds. */
export function registerWorkspaceRows(): void {
  if (registered) return;
  registered = true;
  registerCategory(WORKSPACES_CATEGORY, "Workspaces", "keybinds");
  addSettingRow({
    name: "Workspaces",
    tip: "Folders the launcher opens agents in.",
    category: WORKSPACES_CATEGORY,
    wide: true,
    keywords: () => workspaces.map((w) => `${w.label} ${w.cwd}`).join(" "),
    control: editor,
  });
}
