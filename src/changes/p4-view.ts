// Changes tab, Perforce side DOM (changes.css): the Git / Perforce switch in the head, a read-only
// changelist group (the git group head and row classes, no buttons) and the Not Connected icon.
// Drawn into the pane by changes/view.ts; no state and no IPC here.
import { iconImg } from "../icon-img";
import { lucide } from "../icons";
import perforceIcon from "../assets/perforce.png";
import type { P4Change } from "../ipc";
import { fileType, p4ActionLetter, p4ChangeLabel, truncatePath } from "./model";

export type Backend = "git" | "p4";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

export interface BackendSwitch {
  box: HTMLLabelElement;
  input: HTMLInputElement;
  paint(b: Backend): void;
}

/** Changes icon, the close lock's track (bar-switches.css), Perforce icon; checked = Perforce. Built
 *  once and re-appended after each head redraw, so a flip from the keyboard keeps its element. */
export function buildBackendSwitch(onFlip: (b: Backend) => void): BackendSwitch {
  const box = el("label", "cx-backend"); // a label, so a click on either icon toggles the input
  const input = el("input", "");
  input.type = "checkbox";
  input.setAttribute("aria-label", "Perforce");
  const gitIco = iconImg("changes");
  gitIco.classList.add("cx-bk-git");
  gitIco.alt = "Git";
  gitIco.removeAttribute("aria-hidden");
  const p4Ico = p4Icon("icn cx-bk-p4", "Perforce");
  const track = el("span", "switch");
  track.append(input, el("span", "knob"));
  box.append(gitIco, track, p4Ico);
  input.addEventListener("change", () => onFlip(input.checked ? "p4" : "git"));
  return {
    box,
    input,
    paint(b) {
      input.checked = b === "p4";
      box.classList.toggle("p4", b === "p4");
      box.title = b === "git" ? "Switch to Perforce" : "Switch to Git";
    },
  };
}

/** The P4V app icon; `alt` "" for decoration. */
export function p4Icon(cls: string, alt: string): HTMLImageElement {
  const img = el("img", cls);
  img.src = perforceIcon;
  img.alt = alt;
  img.draggable = false;
  return img;
}

/** A Perforce changelist: head label and count, then one read-only row per opened file. */
export function drawP4Group(c: P4Change, pathBudget: number): HTMLElement {
  const sec = el("div", "cx-group");
  const top = el("div", "cx-sec");
  const hd = p4ChangeLabel(c.change, c.description);
  const label = el("span", "cx-sec-label cx-sec-cl");
  label.textContent = hd.label;
  top.title = hd.title;
  const count = el("span", "cx-sec-count");
  count.textContent = String(c.files.length);
  top.append(label, count);
  sec.append(top);
  const box = el("div", "cx-rows");
  for (const f of c.files) {
    const a = p4ActionLetter(f.action);
    const row = el("div", `cx-row${a.kind === "deleted" ? " cx-del" : ""}`);
    row.title = f.depotFile;
    const letter = el("span", `cx-st cx-st-${a.kind}`);
    letter.textContent = a.letter;
    letter.title = a.title;
    const ft = fileType(f.rel);
    const glyph = lucide(ft.icon, `icn cx-ft cx-ft-${ft.tint}`);
    const { name, dir } = truncatePath(f.rel, pathBudget);
    const path = el("span", "cx-path");
    const fname = el("span", "cx-fname");
    fname.textContent = name;
    const fdir = el("span", "cx-dir");
    fdir.textContent = dir;
    path.append(fname, fdir);
    row.append(letter, glyph, path);
    box.append(row);
  }
  sec.append(box);
  return sec;
}
