// Settings › Agents › Guards rows registration (control and value text: bare-guards.ts): one for a
// Bare Claude tab (`bareGuards`), one for a Bare Codex tab (`bareCodexGuards`).
import { invoke } from "../ipc";
import { guardsControl } from "./bare-guards";
import { addSettingRow } from "./registry";

type GuardLists = { guards: unknown[]; codexGuards?: unknown[] };

/** `bare_actives` reads both guard lists along with the row's sets; a Bare row key keeps it to one call. */
const guardCount = (rowKey: string, list: keyof GuardLists): Promise<number> =>
  (invoke("bare_actives", { rowKey }) as Promise<GuardLists>).then((a) => (a[list] ?? []).length);

export function registerGuardsRow(category: string): void {
  addSettingRow({
    name: "Guards",
    tip: "Guard hooks a Bare Claude tab keeps, from bareGuards in vidar.json.",
    category,
    keywords: () => "bare guard hooks bareGuards",
    control: () => guardsControl(document, () => guardCount("claude-bare", "guards")),
  });
  addSettingRow({
    name: "Codex Guards",
    tip: "Guard hooks a Bare Codex tab keeps, from bareCodexGuards in vidar.json.",
    category,
    keywords: () => "bare codex guard hooks bareCodexGuards",
    control: () => guardsControl(document, () => guardCount("codex-bare", "codexGuards")),
  });
}
