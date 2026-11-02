// Unreal bench tab DOM. The panel owns reads and actions; this view only draws status and reports clicks.
import { el } from "../dom";
import { iconImg, type ColorIcon } from "../icon-img";
import { lucide } from "../icons";
import type { UnrealDiag, UnrealEngineChoice, UnrealEnginePin, UnrealMcpPills, UnrealStatus } from "../ipc";
import { openPopover } from "../modules/popover";
import { placeBelow } from "../panels/dropdown";
import type { UnrealGroups } from "./model";
import { buildAssetSection } from "./asset-view";
import { pillViews, pinView } from "./pills";

export interface ViewState {
  mcp: UnrealMcpPills | null;
  pin: UnrealEnginePin | null;
  /** The last refusal from the pin commands; shown as an error row. */
  pinError: string | null;
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
  /** Past pins, for the pin menu. */
  pinChoices(): Promise<UnrealEngineChoice[]>;
  /** null clears the pin. */
  pinSet(engine: string | null): void;
  pinPick(): void;
}

export interface View {
  root: HTMLElement;
  render(state: ViewState): void;
}

type Signal = "ok" | "warn" | "alert";

function statusPart(icon: ColorIcon, label: string, detail: string, signal: Signal): HTMLElement {
  const part = el("span", "ux-status");
  part.title = detail;
  part.setAttribute("role", "img");
  part.setAttribute("aria-label", detail);
  const dot = el("span", "ux-dot");
  dot.dataset.state = signal;
  part.append(dot, iconImg(icon)); // dot left, logo right: the logo lines up with the larger action buttons
  return part;
}

/** A head chip with a visible label: the Document picker's face (.pick-face), a dot on the left when it has a signal. */
function chip(tag: "span" | "button", label: string, tooltip: string, signal?: Signal): HTMLElement {
  const part = el(tag, "pick-face ux-chip");
  part.title = tooltip;
  if (signal) {
    const dot = el("span", "ux-dot");
    dot.dataset.state = signal;
    part.append(dot);
  }
  const text = el("span", "ux-chip-label");
  text.textContent = label;
  part.append(text);
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
  const notes = el("div", "cx-strip");
  // Outside the region render() redraws, so the poll keeps its fields and results.
  const asset = buildAssetSection();
  root.append(head, notes, list, asset.root, empty);

  /** The pin menu is mounted on body by the popover core, so a head redraw leaves it open. */
  function openPinMenu(button: HTMLElement, pinned: boolean, current: string | null) {
    void handlers.pinChoices().then((choices) => {
      const menu = el("div");
      menu.id = "flow-pick-menu"; // the shared dropdown menu look (menus.css)
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Engine");
      let close: () => void = () => {};
      const row = (text: string, active: boolean, run: () => void) => {
        const b = el("button", active ? "display-pick-row active" : "display-pick-row");
        b.type = "button";
        const nm = el("span", "nm");
        nm.textContent = text;
        b.append(nm);
        b.addEventListener("click", () => { close(); run(); });
        menu.append(b);
      };
      for (const c of choices) {
        const b = el("button", c.engine === current ? "display-pick-row active" : "display-pick-row");
        b.type = "button";
        b.title = c.engine;
        const nm = el("span", "nm");
        nm.textContent = `Engine ${c.engineVersion}`;
        b.append(nm);
        b.addEventListener("click", () => { close(); handlers.pinSet(c.engine); });
        menu.append(b);
      }
      row("Choose Folder…", false, () => handlers.pinPick());
      if (pinned) row("Clear Pin", false, () => handlers.pinSet(null));
      close = openPopover({ el: menu, anchor: button, restoreFocus: null });
      placeBelow(menu, button, head);
      menu.querySelector<HTMLElement>(".display-pick-row")?.focus();
    }).catch(console.error);
  }

  function drawHead(status: UnrealStatus, state: ViewState) {
    head.replaceChildren();
    const project = status.project;
    if (!project) return;
    const name = el("span", "ux-project pane-head-card");
    name.textContent = project.name;
    name.title = project.uproject;
    head.append(name, el("span", "cx-grow"));
    for (const pill of pillViews(state.mcp)) head.append(chip("span", pill.label, pill.tooltip, pill.signal));
    const pin = pinView(state.pin);
    const pinButton = chip("button", pin.label, pin.tooltip) as HTMLButtonElement;
    pinButton.type = "button";
    pinButton.setAttribute("aria-haspopup", "menu");
    pinButton.addEventListener("click", () => openPinMenu(pinButton, pin.pinned, state.pin?.engine ?? null));
    head.append(pinButton);
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
    if (icon) top.append(iconImg(icon));
    top.append(name);
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
    asset.setRoot(state.status?.project && !state.error ? state.status.project.root : null);
    const targetNames = state.status?.diags.map((diag) => handlers.target(diag)?.name ?? null);
    const nextKey = JSON.stringify([state.status, state.error, state.rider, targetNames, state.dismissed, state.mcp, state.pin, state.pinError]);
    if (nextKey === key) return;
    key = nextKey;
    head.replaceChildren();
    notes.replaceChildren();
    if (state.pinError && state.status?.project && !state.error) {
      const line = el("div", "cx-note");
      line.setAttribute("role", "alert");
      line.append(lucide("circle-alert"));
      const msg = el("span", "cx-note-msg");
      msg.textContent = state.pinError;
      line.append(msg);
      notes.append(line);
    }
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
      const icon = iconImg("folder");
      icon.classList.add("cx-empty-icon");
      empty.append(icon);
      const message = el("span", "cx-empty-title");
      message.textContent = "No Unreal Project Here"; // note-ok: plan D6 (bench-tab-plan.md)
      empty.append(message);
    } else {
      empty.removeAttribute("role");
      empty.removeAttribute("title");
      drawHead(state.status, state);
      if (state.groups?.errors.length) list.append(drawGroup("Errors", state.groups.errors, state.rider, "warning"));
      if (state.groups?.warnings.length) list.append(drawGroup("Warnings", state.groups.warnings, state.rider));
    }
    head.hidden = !state.status?.project || !!state.error;
    list.hidden = !state.status?.project || !!state.error || !list.childElementCount;
    empty.hidden = !!state.status?.project && !state.error;
  }

  return { root, render };
}
