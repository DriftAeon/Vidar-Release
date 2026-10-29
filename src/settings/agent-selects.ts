// Settings › Agents: the Model and Effort selects of a Rendered row (moved out of agents.ts), and
// the page's Primary Agent select.
// Blank first option = not pinned (the field is unset and toWire strips it); a pinned value the
// list does not hold stays as an extra "(Not Listed)" option, so the select never lies about it.

import { EFFORT_LEVELS } from "../agents/protocol";
import { CODEX_EFFORT_LEVELS } from "../agents/codex-settings";
import { DASH, label } from "../format";
import { AGENTS } from "../agents/descriptor";
import type { PrimaryAgent } from "../agents/primary";

type ModelOption = { value: string; label: string };
type CodexModel = ModelOption & { effortLevels: readonly string[] };

const CLAUDE_MODEL_TIP = "Blank uses the host's default model, which may be Fable. Pin a model to rule it out.";
const CODEX_MODEL_TIP = "Blank uses the Codex CLI's default model.";

function select(label: string, tip: string, value: string, options: ModelOption[], onPick: (v: string) => void,
  shown: (v: string) => string = (v) => v): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "sc-select";
  sel.setAttribute("aria-label", label);
  sel.title = tip;
  const add = (v: string, text: string) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    sel.appendChild(o);
  };
  add("", DASH);
  for (const o of options) add(o.value, o.label);
  if (value !== "" && !options.some((o) => o.value === value)) add(value, `${shown(value)} (Not Listed)`);
  sel.value = value;
  sel.addEventListener("change", () => onPick(sel.value));
  return sel;
}

export function effortSelect(value: string, onPick: (level: string) => void, levels: readonly string[] = EFFORT_LEVELS): HTMLSelectElement {
  return select("Effort", "Blank leaves the effort to the host default.", value,
    levels.map((l) => ({ value: l, label: label(l) })), onPick, label);
}

export function modelSelect(value: string, models: ModelOption[], onPick: (model: string) => void, tip = CLAUDE_MODEL_TIP): HTMLSelectElement {
  return select("Model", tip, value, models, onPick);
}

const ONE_AGENT_TIP = "Only one agent is installed.";

/** The Primary Agent select: one option per active agent, no blank (an unset pick shows the
 *  effective one). One option = shown disabled, with the reason as its tooltip; none = a disabled DASH. */
export function primarySelect(value: PrimaryAgent | null, ids: readonly PrimaryAgent[], onPick: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "sc-select";
  sel.setAttribute("aria-label", "Primary Agent");
  const options = ids.map((id) => ({ value: id, label: AGENTS[id].name }));
  for (const o of options.length ? options : [{ value: "", label: DASH }]) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = value ?? "";
  sel.disabled = options.length < 2;
  if (options.length === 1) sel.title = ONE_AGENT_TIP;
  sel.addEventListener("change", () => onPick(sel.value));
  return sel;
}

/** The Codex Rendered row's effort choices: the pinned model's advertised levels, else Codex's four. */
export function codexEffortLevels(model: string, models: readonly CodexModel[]): readonly string[] {
  const levels = models.find((m) => m.value === model)?.effortLevels;
  return levels?.length ? levels : CODEX_EFFORT_LEVELS;
}

/** Model select over the saved Codex catalog; null when no Codex tab has listed models yet. */
export function codexModelSelect(model: string, models: readonly CodexModel[], onPick: (model: string) => void): HTMLSelectElement | null {
  return models.length ? modelSelect(model, [...models], onPick, CODEX_MODEL_TIP) : null;
}
