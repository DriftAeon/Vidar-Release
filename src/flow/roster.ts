// Model roster: the display id/label <-> provider id mapping for `ModelId`. model.ts keeps one id
// space; roster.ts maps display strings. Core models are listed here; every other model comes from
// the `flowModels` of an active agent module (modules.md), so a build without that module has no
// such entry. Not under `node --test` (it reads the module registry).

import { effectivePrimary } from "../agents/primary";
import { moduleOn, modulesOf } from "../modules/registry";
import { getPref } from "../prefs";
import type { ModelId } from "./model";
import { backendOfRunner, setBackendLookup, type FlowBackend } from "./runner";
import { leadRunner } from "./roster-order";
import { setLiveModelIds } from "./validate";

export interface ModelOption {
  /** The literal string sent to the sidecar's --model (model.ts's `ModelId`). */
  id: ModelId;
  /** Display label — the mock's exact strings (flow-mock.html state 3's Model `<select>`). */
  label: string;
  /** false = reserved, never offered by the palette's preset picker or the inspector's `model`
   *  `<select>` ("No preset defaults to Fable... stays selectable"). */
  wired: boolean;
  /** The Flow backend that runs a node on this model (flow.rs's `flow_run_node` arms). */
  runner: FlowBackend;
}

/** The module whose rows a runner's models show under: hidden while that module is off. */
const RUNNER_MODULE: Record<FlowBackend, string> = { sdk: "claude", codex: "codex" };

/** Core models, in display order. */
const CORE_ROSTER: readonly ModelOption[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5", wired: true, runner: "sdk" },
  { id: "claude-opus-5-5", label: "Opus 5.5", wired: true, runner: "sdk" },
  { id: "claude-fable-5-1", label: "Fable 5.1", wired: true, runner: "sdk" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", wired: true, runner: "sdk" },
  { id: "codex-default", label: "Codex Default", wired: true, runner: "codex" },
];

/** Core models of the modules that are on, the saved Codex model list, then the flowModels of
 *  the active agent modules in registry order. */
function currentRoster(): ModelOption[] {
  let out: ModelOption[] = CORE_ROSTER.filter((o) => moduleOn(RUNNER_MODULE[o.runner]));
  if (moduleOn(RUNNER_MODULE.codex)) {
    for (const c of getPref("codexModels") ?? []) {
      if (!out.some((o) => o.id === c.value)) out.push({ id: c.value, label: c.label, wired: true, runner: "codex" });
    }
  }
  // The primary agent's runner group leads: palette and adaptModelsToWired take wired[0].
  if (effectivePrimary() === "codex") out = leadRunner(out, "codex");
  for (const m of modulesOf("agent")) {
    const runner = backendOfRunner(m.agent?.gateway?.runner) ?? "sdk";
    for (const f of m.flowModels ?? []) {
      if (!out.some((o) => o.id === f.id)) out.push({ id: f.id, label: f.label, wired: true, runner });
    }
  }
  return out;
}

setLiveModelIds(() => currentRoster().filter((o) => o.wired).map((o) => o.id as string));
setBackendLookup((id) => currentRoster().find((o) => o.id === id)?.runner);

/** The palette's preset picker and the inspector's `model` `<select>` both build from this —
 *  anything `wired:false` never appears in either. */
export function wiredModels(): ModelOption[] {
  return currentRoster().filter((m) => m.wired);
}

/** Display label for a provider id; falls back to the id itself for an id this roster doesn't
 *  know (a saved graph naming a model whose module is no longer active). */
export function modelLabel(id: ModelId): string {
  return currentRoster().find((m) => m.id === id)?.label ?? id;
}
