// Unreal bench tab DOM. The panel owns reads and actions; this view only draws status and reports clicks.
import { iconImg, type ColorIcon } from "../icon-img";
import { lucide } from "../icons";
import type { UnrealDiag, UnrealStatus } from "../ipc";
import type { UnrealGroups } from "./model";

export interface ViewState {
  status: UnrealStatus | null;
  groups: UnrealGroups | null;
  /** Keys of the dismissed diagnostics, so a dismiss repaints. */
  dismissed: string[];
  error: string | null;
  rider: boolean;
}

interface Handlers {
  target(diag: UnrealDiag): { id: string; name: string } | null;
  send(diag: UnrealDiag): void;
  open(diag: UnrealDiag): void;
  dismiss(diag: UnrealDiag): void;
  dismissAll(diags: UnrealDiag[]): void;
}

export interface View {
  root: HTMLElement;
  render(state: ViewState): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

type Signal = "ok" | "warn" | "alert";

function statusPart(icon: ColorIcon, label: string, detail: string, signal: Signal): HTMLElement {
  const part = el("span", "ux-status");
  part.title = detail;
  part.setAttribute("role", "img");
  part.setAttribute("aria-label", detail);
  const dot = el("span", "ux-dot");
  dot.dataset.state = signal;
  part.append(iconImg(icon), dot);
  return part;
}

function when(at: number | null): string {
  return at == null ? "" : new Date(at).toLocaleString();
}

function action(icon: ColorIcon, label: string, tooltip: string, disabled: boolean, click: () => void): HTMLElement {
  const wrap = el("span", "ux-action");
  wrap.title = tooltip;
  const button = el("button", "cx-ra");
  button.type = "button";
  button.title = tooltip;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.append(iconImg(icon));
  button.addEventListener("click", click);
  wrap.append(button);
  return wrap;
}

export function buildView(handlers: Handlers): View {
  const root = el("div", "unreal-pane");
  root.id = "unreal-view";
  root.style.display = "none";
  const head = el("div", "cx-head");
  const list = el("div", "cx-list");
  const empty = el("div", "cx-empty");
  root.append(head, list, empty);

  function drawHead(status: UnrealStatus) {
    head.replaceChildren();
    const project = status.project;
    if (!project) return;
    const name = el("span", "ux-project pane-head-card");
    name.textContent = project.name;
    name.title = project.uproject;
    head.append(name, el("span", "cx-grow"));
    const editorLabel = status.editor === "running" ? "Editor Running"
      : status.editor === "unclean" ? "Editor Closed Unclean" : "Editor Closed";
    const editorTip = status.editor === "unclean"
      ? "The last editor log never closed: the editor crashed or was stopped." : editorLabel;
    head.append(statusPart(
      "unreal", editorLabel, editorTip,
      status.editor === "running" ? "ok" : status.editor === "unclean" ? "alert" : "warn",
    ));
    if (status.build) {
      const label = status.build.result === "succeeded" ? "Build Succeeded"
        : status.build.result === "failed" ? "Build Failed" : "Build Unknown";
      head.append(statusPart(
        "hammer", label, [label, when(status.build.at)].filter(Boolean).join(" · "),
        status.build.result === "succeeded" ? "ok" : status.build.result === "failed" ? "alert" : "warn",
      ));
    }
    if (status.liveCoding) {
      const label = status.liveCoding.result === "succeeded" ? "Live Coding Succeeded" : "Live Coding Failed";
      head.append(statusPart(
        "code", label, [label, when(status.liveCoding.at)].filter(Boolean).join(" · "),
        status.liveCoding.result === "succeeded" ? "ok" : "alert",
      ));
    }
  }

  function drawRow(diag: UnrealDiag, rider: boolean): HTMLElement {
    const row = el("div", "cx-row");
    row.title = diag.text;
    row.append(lucide("file-code"));
    const file = el("span", "ux-file");
    const name = diag.file?.split(/[\\/]/).pop() || "Unreal";
    file.textContent = diag.line == null ? name : `${name}(${diag.line})`;
    if (diag.file) file.title = `${diag.file}\n${diag.text}`;
    const message = el("span", "ux-message");
    message.textContent = diag.text;
    const acts = el("span", "cx-racts");
    const dest = handlers.target(diag);
    acts.append(action(
      "send", "Send",
      dest ? `Types this error into ${dest.name} without sending it.` : "Send",
      !dest, () => handlers.send(diag),
    ));
    acts.append(action(
      "rider", "Open in Editor",
      rider ? "Open in Editor" : "Set editor.exe in vidar.json to open files.",
      !rider || !diag.file, () => handlers.open(diag),
    ));
    const dismiss = el("button", "cx-ra");
    dismiss.type = "button";
    dismiss.title = "Dismiss";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.append(lucide("x"));
    dismiss.addEventListener("click", () => handlers.dismiss(diag));
    const dismissWrap = el("span", "ux-action");
    dismissWrap.append(dismiss);
    acts.append(dismissWrap);
    row.append(file, message, acts);
    return row;
  }

  function drawGroup(label: string, diags: UnrealDiag[], rider: boolean, icon?: ColorIcon): HTMLElement {
    const group = el("div", "cx-group");
    const top = el("div", "cx-sec");
    const name = el("span", "cx-sec-label");
    name.textContent = label;
    const count = el("span", "cx-sec-count");
    count.textContent = String(diags.length);
    if (icon) top.append(iconImg(icon));
    top.append(name, count);
    if (diags.length > 1) {
      const all = el("button", "cx-ra");
      all.type = "button";
      all.title = "Dismiss All";
      all.setAttribute("aria-label", "Dismiss All");
      all.append(iconImg("broom"));
      all.addEventListener("click", () => handlers.dismissAll(diags));
      const wrap = el("span", "ux-action ux-sec-action");
      wrap.append(all);
      top.append(wrap);
    }
    const rows = el("div", "cx-rows");
    for (const diag of diags) rows.append(drawRow(diag, rider));
    group.append(top, rows);
    return group;
  }

  let key = "";
  function render(state: ViewState) {
    const targetNames = state.status?.diags.map((diag) => handlers.target(diag)?.name ?? null);
    const nextKey = JSON.stringify([state.status, state.error, state.rider, targetNames, state.dismissed]);
    if (nextKey === key) return;
    key = nextKey;
    head.replaceChildren();
    list.replaceChildren();
    empty.replaceChildren();
    if (state.error) {
      empty.title = state.error;
      empty.setAttribute("role", "alert");
      const message = el("span", "cx-empty-title");
      message.textContent = "Unreal Couldn't Read the Logs";
      empty.append(message);
    } else if (!state.status?.project) {
      empty.removeAttribute("role");
      empty.removeAttribute("title");
      empty.append(lucide("folder-x", "icn cx-empty-icon"));
      const message = el("span", "cx-empty-title");
      message.textContent = "No Unreal Project Here"; // note-ok: plan D6 (bench-tab-plan.md)
      empty.append(message);
    } else {
      empty.removeAttribute("role");
      empty.removeAttribute("title");
      drawHead(state.status);
      if (state.groups?.errors.length) list.append(drawGroup("Errors", state.groups.errors, state.rider, "warning"));
      if (state.groups?.warnings.length) list.append(drawGroup("Warnings", state.groups.warnings, state.rider));
    }
    head.hidden = !state.status?.project || !!state.error;
    list.hidden = !state.status?.project || !!state.error || !list.childElementCount;
    empty.hidden = !!state.status?.project && !state.error;
  }

  return { root, render };
}
