// Settings › Audio: the Speak Rewrite row. One bind holds the Rewrite adapter select plus the
// Model and Effort selects that adapter offers; each change writes `voice_slots_pick` (the full
// pick) and repaints from the row it returns. The pure parts (names, option lists, prefill, the
// pick) are exported without DOM for tests.
import { invoke } from "../ipc";
import { AGENTS } from "../agents/descriptor";
import { AGENT_IDS } from "../agents/id";
import type { AgentId } from "../agents/id";
import type { VoiceSlotAdapter, VoiceSlotPick, VoiceSlotStatus } from "../ipc-voice";
import type { LmStatus } from "../panels/lmstudio";
import { onSettingsChanged } from "../config";
import { moduleOn } from "../modules/registry";
import { effortSelect, modelSelect } from "./agent-selects";
import { redraw } from "./live-list";
import { addSettingRow } from "./registry";

export const LM_ADAPTER = "voice-stock/openai-compat";
const AGENT_MODEL_TIP = "Full model id passed to the selected agent.";
const LM_MODEL_TIP = "A model LM Studio has downloaded; the first rewrite loads it.";

type Option = { value: string; label: string };
type LmModelLike = { id: string; kind: string; state: string };

export function adapterName(a: { id: string; label: string }): string {
  const agent = adapterAgent(a.id);
  if (agent) return AGENTS[agent].name;
  if (a.id === LM_ADAPTER) return "LM Studio";
  return a.label;
}

/** An adapter's first path component names its agent module. */
function adapterAgent(id: string, ids: readonly string[] = AGENT_IDS): AgentId | undefined {
  return ids.find((agent) => id.startsWith(`${agent}/`)) as AgentId | undefined;
}

/** The adapter a fresh Speak Rewrite pick starts from; undefined when neither agent is usable. */
export function defaultAdapter(adapters: readonly VoiceSlotAdapter[], on: (module: string) => boolean, ids: readonly string[] = AGENT_IDS): VoiceSlotAdapter | undefined {
  for (const id of ids) {
    const found = adapters.find((a) => adapterAgent(a.id, ids) === id);
    if (found && on(id)) return found;
  }
  return undefined;
}

/** The select's adapters: an agent adapter whose module is off drops out (unless it is the saved
 *  pick, so the row never hides what is set), and the default adapter leads. */
export function usableAdapters(adapters: readonly VoiceSlotAdapter[], on: (module: string) => boolean, current = "", ids: readonly string[] = AGENT_IDS): VoiceSlotAdapter[] {
  const kept = adapters.filter((a) => a.id === current || !adapterAgent(a.id, ids) || on(adapterAgent(a.id, ids)!));
  const lead = defaultAdapter(kept, on, ids);
  return lead ? [lead, ...kept.filter((a) => a !== lead)] : kept;
}

export function adapterOptions(adapters: readonly VoiceSlotAdapter[]): Option[] {
  return adapters.map((a) => ({ value: a.id, label: adapterName(a) }));
}

/** LM Studio's LLM entries; embedding models are never offered. */
export function lmLlms(lm: { models?: readonly LmModelLike[] } | null): LmModelLike[] {
  return (lm?.models ?? []).filter((m) => !/embed/i.test(m.kind));
}

/** The Model select's options for the picked adapter; empty when it takes no model id. */
export function modelOptions(adapter: VoiceSlotAdapter | undefined, lm: { models?: readonly LmModelLike[] } | null): Option[] {
  if (!adapter?.modelIds) return [];
  if (adapter.id === LM_ADAPTER) return lmLlms(lm).map((m) => ({ value: m.id, label: m.id }));
  return adapter.suggestedModels.map((m) => ({ value: m.id, label: m.label ?? m.id }));
}

/** What a freshly chosen adapter starts with: an agent's first suggestion, or LM Studio's loaded LLM. */
export function prefillPick(adapter: VoiceSlotAdapter, lm: { models?: readonly LmModelLike[] } | null): VoiceSlotPick {
  if (adapterAgent(adapter.id) && adapter.suggestedModels.length > 0 && adapter.efforts.length > 0) {
    const model = adapter.suggestedModels[0].id;
    const pick: VoiceSlotPick = { adapter: adapter.id, model };
    if (adapter.efforts.includes("low")) pick.effort = "low";
    return pick;
  }
  const pick: VoiceSlotPick = { adapter: adapter.id };
  if (adapter.id === LM_ADAPTER) {
    const llms = lmLlms(lm);
    const model = (llms.find((m) => m.state === "loaded") ?? llms[0])?.id;
    if (model) pick.model = model;
  }
  return pick;
}

/** The pick to write: empty fields omitted, effort dropped when the adapter lists none. */
export function buildPick(adapter: VoiceSlotAdapter | undefined, model: string, effort: string): VoiceSlotPick | null {
  if (!adapter) return null;
  const pick: VoiceSlotPick = { adapter: adapter.id };
  if (model !== "") pick.model = model;
  if (effort !== "" && adapter.efforts.length > 0) pick.effort = effort;
  return pick;
}

/** The row's error text: a broken or missing slot shows its reason, anything else clears it. */
export function rowError(row: VoiceSlotStatus | { state: string; reason: string | null }): string {
  return (row.state === "broken" || row.state === "missing") && row.reason ? row.reason : "";
}

function adapterSelect(value: string, options: Option[], onPick: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "sc-select";
  sel.setAttribute("aria-label", "Rewrite");
  const add = (v: string, text: string) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = text;
    sel.appendChild(o);
  };
  add("", "None");
  for (const o of options) add(o.value, o.label);
  if (value !== "" && !options.some((o) => o.value === value)) add(value, `${value} (Not Listed)`);
  sel.value = value;
  sel.addEventListener("change", () => onPick(sel.value));
  return sel;
}

const live = new Set<{ root: HTMLElement; load: () => void }>();
let listening = false;

function rewriteControl(setError: (msg: string) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "sc-bind";
  let row: VoiceSlotStatus | null = null;
  let lm: LmStatus | null = null;
  let gen = 0;

  const paint = () => redraw(root, () => {
    if (!row) return;
    const r = row;
    const adapters = r.adapters ?? [];
    const current = r.adapter ?? "";
    const adapter = adapters.find((a) => a.id === current);
    const write = (pick: VoiceSlotPick | null) => {
      const mine = ++gen;
      invoke("voice_slots_pick", { slot: "rewrite", pick }).then((next) => {
        if (mine !== gen) return;
        row = next;
        setError(rowError(next));
        paint();
      }, (e) => {
        if (mine !== gen) return;
        setError(String(e));
        paint();
      });
    };
    root.appendChild(adapterSelect(current, adapterOptions(usableAdapters(adapters, moduleOn, current)), (id) => {
      const next = adapters.find((a) => a.id === id);
      write(next ? prefillPick(next, lm) : null);
    }));
    const model = r.model ?? "";
    const effort = r.effort ?? "";
    if (adapter?.modelIds) {
      const tip = adapter.id === LM_ADAPTER ? LM_MODEL_TIP : AGENT_MODEL_TIP;
      root.appendChild(modelSelect(model, modelOptions(adapter, lm), (m) => write(buildPick(adapter, m, effort)), tip));
    }
    if (adapter && adapter.efforts.length > 0) {
      root.appendChild(effortSelect(effort, (l) => write(buildPick(adapter, model, l)), adapter.efforts));
    }
  });

  const load = () => {
    const mine = ++gen;
    void Promise.all([
      invoke("voice_slots_status_one", { slot: "rewrite" }),
      invoke("lmstudio_status").catch(() => null),
    ]).then(([r, l]) => {
      if (mine !== gen) return;
      row = r;
      lm = l;
      setError(rowError(r));
      paint();
    }, (e) => {
      if (mine !== gen) return;
      setError(String(e));
    });
  };

  live.add({ root, load });
  if (!listening) {
    listening = true;
    onSettingsChanged((e) => {
      if (!e.keys.includes("voiceSlots")) return;
      for (const r of live) {
        if (!r.root.isConnected) live.delete(r);
        else r.load();
      }
    });
  }
  load();
  return root;
}

let registered = false;

/** One Settings › Audio row: the model that rewrites a reply into speech. */
export function registerVoiceRewriteRow(): void {
  if (registered) return;
  registered = true;
  addSettingRow({
    name: "Speak Rewrite",
    tip: "Which model rewrites a reply into speech before it is read aloud. Applies on the next Speak press.",
    category: "audio",
    keywords: () => "rewrite speak claude lm studio model effort sonnet opus haiku",
    control: rewriteControl,
  });
}
