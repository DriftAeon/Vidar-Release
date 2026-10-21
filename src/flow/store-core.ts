// Storage leaf: envelope load/save, id/name/updatedAt stamping, layout.v1
// migration, template instantiation, seed-if-absent. Leaf module — only `import type` crosses out (node --test rule),
// so this file takes storage as a parameter and never touches window/browser storage/S/the DOM.

import type { FlowAddon, FlowEdge, FlowField, FlowGraph, FlowNode, FlowTemplate, ModelId } from "./model";

// A Map-backed stub in tests, the Flow file store (file-storage.ts) from store.ts in the app. Hoisted to
// prefs-core.ts; re-exported so store.ts keeps its import.
import type { StorageLike } from "../prefs-core";
export type { StorageLike };

// Restated here (not imported) so this leaf compiles standalone under node --test;
// LEGACY_LAYOUT_KEY matches the deleted persist.ts's own LAYOUT_KEY verbatim, so a pre-Wave-1
// saved layout is still found; the other two are §4.1's new keys.
export const GRAPHS_KEY = "vidar.flow.graphs.v1";
export const TEMPLATES_KEY = "vidar.flow.templates.v1";
export const LEGACY_LAYOUT_KEY = "vidar.flow.layout.v1";

export interface GraphsEnvelope {
  v: 1;
  activeGraphId: string | null;
  graphs: FlowGraph[];
}

export interface TemplatesEnvelope {
  v: 1;
  templates: FlowTemplate[];
}

/** Legacy layout shape (the deleted persist.ts module's storage format): `{ nodes, edges }`, no
 *  id/name/updatedAt. */
export interface LegacyLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

function newId(prefix: string): string {
  // crypto.randomUUID is a runtime global (WebCrypto), not a module import — allowed in a leaf.
  const rand = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${rand}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Tri-state read result: `absent` (no key) and `invalid` (present but unparsable or wrong `v`)
 *  are kept apart so a caller about to seed over the key can back up `raw` first — collapsing
 *  them to one `null` (as `loadGraphsEnvelope` below still does, for callers that only care
 *  whether they got usable data) is what let a truncated write or a downgraded version silently
 *  wipe stored graphs/templates on the next mount. */
export type EnvelopeRead<T> =
  | { status: "absent"; raw: null; env: null }
  | { status: "invalid"; raw: string; env: null }
  | { status: "ok"; raw: string; env: T };

function readEnvelope<T>(
  storage: StorageLike,
  key: string,
  parse: (parsed: unknown) => T | null,
): EnvelopeRead<T> {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: "absent", raw: null, env: null };
  }
  if (!raw) return { status: "absent", raw: null, env: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    const env = parse(parsed);
    if (env === null) return { status: "invalid", raw, env: null };
    return { status: "ok", raw, env };
  } catch {
    return { status: "invalid", raw, env: null };
  }
}

function parseGraphsEnvelope(parsed: unknown): GraphsEnvelope | null {
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.graphs)) return null;
  const activeGraphId = typeof parsed.activeGraphId === "string" ? parsed.activeGraphId : null;
  return { v: 1, activeGraphId, graphs: parsed.graphs as FlowGraph[] };
}

/** Reads `GRAPHS_KEY`. Returns `null` when the key is absent, unparsable, or its `v` doesn't
 *  match the envelope version 1 — callers treat all three the same (§4.1: absent ⇒ first-load
 *  path; a version mismatch has no v1 migration defined, so it is likewise treated as absent
 *  rather than thrown). Use `readGraphsEnvelope` instead when "absent" and "invalid" need telling
 *  apart (e.g. before seeding over the key). */
export function loadGraphsEnvelope(storage: StorageLike): GraphsEnvelope | null {
  return readEnvelope(storage, GRAPHS_KEY, parseGraphsEnvelope).env;
}

/** Same read as `loadGraphsEnvelope`, keeping "absent" apart from "invalid" and the raw string
 *  when invalid, so the caller can back it up before it gets overwritten by the seed path. */
export function readGraphsEnvelope(storage: StorageLike): EnvelopeRead<GraphsEnvelope> {
  return readEnvelope(storage, GRAPHS_KEY, parseGraphsEnvelope);
}

/** How many `.bak-<stamp>` backups `backupInvalidEnvelope`/`backupInvalidRunsEnvelope` keep per
 *  key — older ones are dropped so the backups don't grow unbounded into the same quota they're
 *  guarding against. */
export const MAX_BAK_PER_KEY = 5;

/** Tracks `.bak-<stamp>` suffixes for `key` in an index entry (`${key}.bakindex`, no dash so it
 *  never collides with a `startsWith("${key}.bak-")` scan for the backups themselves) —
 *  `StorageLike` has no `key()`/`length` to enumerate real keys, so the leaf keeps its own
 *  manifest instead of widening the storage contract. Drops the oldest entries over
 *  `MAX_BAK_PER_KEY` and removes their backup keys. */
function pruneBakKeys(storage: StorageLike, key: string, newSuffix: string): void {
  const indexKey = `${key}.bakindex`;
  let list: string[] = [];
  try {
    const raw = storage.getItem(indexKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    list = [];
  }
  // Dedupe: a same-`now` double call within the same millisecond produces the same suffix — an
  // existing entry is dropped before the re-push so the index never lists a suffix twice, which
  // would otherwise leave a stale entry pointing at an already-evicted backup key.
  list = list.filter((s) => s !== newSuffix);
  list.push(newSuffix);
  while (list.length > MAX_BAK_PER_KEY) {
    const old = list.shift();
    if (old !== undefined) {
      try { storage.removeItem(`${key}.bak-${old}`); } catch { /* best-effort */ }
    }
  }
  try {
    storage.setItem(indexKey, JSON.stringify(list));
  } catch {
    // best-effort — a lost index just means the next prune over-keeps; no data loss
  }
}

/** Copies a present-but-invalid raw envelope string to `${key}.bak-<stamp>` before the seed path
 *  overwrites it, so a truncated write or a future envelope version (after a downgrade) never
 *  silently loses the user's stored data. `now` (an ISO timestamp) is
 *  de-punctuated so the backup key stays one plain storage-key token. Prunes older backups for
 *  `key` down to `MAX_BAK_PER_KEY`. Returns whether the backup write itself succeeded. */
export function backupInvalidEnvelope(storage: StorageLike, key: string, raw: string, now: string): boolean {
  const suffix = now.replace(/[:.]/g, "-");
  let ok = true;
  try {
    storage.setItem(`${key}.bak-${suffix}`, raw);
  } catch {
    ok = false; // best-effort, same guard as saveGraphsEnvelope
  }
  // Only list a backup that actually landed — pushing on failure would leave the index pointing
  // at a key that was never written.
  if (ok) pruneBakKeys(storage, key, suffix);
  return ok;
}

/** Returns whether the write succeeded, so a caller can surface a save-failure status note
 *  instead of the loss being silent. */
export function saveGraphsEnvelope(storage: StorageLike, env: GraphsEnvelope): boolean {
  try {
    storage.setItem(GRAPHS_KEY, JSON.stringify(env));
    return true;
  } catch {
    return false; // best-effort persistence only, same guard the deleted persist.ts used
  }
}

function parseTemplatesEnvelope(parsed: unknown): TemplatesEnvelope | null {
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.templates)) return null;
  return { v: 1, templates: parsed.templates as FlowTemplate[] };
}

export function loadTemplatesEnvelope(storage: StorageLike): TemplatesEnvelope | null {
  return readEnvelope(storage, TEMPLATES_KEY, parseTemplatesEnvelope).env;
}

/** Same read as `loadTemplatesEnvelope`, keeping "absent" apart from "invalid" — see
 *  `readGraphsEnvelope`. */
export function readTemplatesEnvelope(storage: StorageLike): EnvelopeRead<TemplatesEnvelope> {
  return readEnvelope(storage, TEMPLATES_KEY, parseTemplatesEnvelope);
}

/** Returns whether the write succeeded — see `saveGraphsEnvelope`. */
export function saveTemplatesEnvelope(storage: StorageLike, env: TemplatesEnvelope): boolean {
  try {
    storage.setItem(TEMPLATES_KEY, JSON.stringify(env));
    return true;
  } catch {
    return false; // best-effort, same as saveGraphsEnvelope
  }
}

function loadLegacyLayout(storage: StorageLike): LegacyLayout | null {
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_LAYOUT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return { nodes: parsed.nodes as FlowNode[], edges: parsed.edges as FlowEdge[] };
    }
  } catch {
    // falls through to null
  }
  return null;
}

/** Stamps `id`/`name`/`updatedAt` onto a graph missing any of them — never overwrites a value
 *  already present. `now` is a parameter (not `Date.now()` inline) so tests stay deterministic. */
export function stampGraph(
  graph: Partial<Pick<FlowGraph, "id" | "name" | "updatedAt">> & Pick<FlowGraph, "nodes" | "edges">,
  now: string,
): FlowGraph {
  return {
    id: graph.id ?? newId("graph"),
    name: graph.name ?? "Untitled flow",
    nodes: graph.nodes,
    edges: graph.edges,
    updatedAt: graph.updatedAt ?? now,
  };
}

/** §4.1: "an existing vidar.flow.layout.v1 is migrated into one graph named 'Legacy layout'".
 *  Runs only when the graphs key is absent (caller's concern, `seedGraphsIfAbsent` below), so it
 *  never re-imports.
 *
 *  Does not replay the deleted persist.ts's own `loadSavedLayout` old-coordinate fix-up — that
 *  fix-up only repositioned the legacy mock graph's five node ids at their exact pre-Wave-0
 *  (x,y), which a post-Wave-0 layout.v1 key can no longer match, so it would be dead code here
 *  Does backfill `value` on any older addon that lacks one (the
 *  `FlowAddon.value` field is new; legacy addons carried only `kind`/`label`), so a reader of
 *  `addon.value` never sees `undefined` on a migrated node. */
export function migrateLegacyLayout(layout: LegacyLayout, now: string): FlowGraph {
  const nodes = layout.nodes.map((n) =>
    n.addons
      ? { ...n, addons: n.addons.map((a) => (a.value === undefined ? { ...a, value: a.label } : a)) }
      : n,
  );
  return stampGraph({ name: "Legacy layout", nodes, edges: layout.edges }, now);
}

/** One piece of legacy content the load-time normalisation below removed. §2's FlowNode/FlowGraph
 *  have no note field, so the record is this list (store.ts logs it with console.info) plus a
 *  `.bak-<stamp>` copy of the pre-normalisation envelope; the layout.v1 key also stays in place. */
export interface LegacyDrop {
  graphId: string;
  nodeId: string;
  what: "node" | "addon" | "field";
  kind: string;   // the node kind, addon kind, or field key that was dropped
  text: string;   // its content: the addon's value, the field's value, or the node's title+fields
}

// Pre-v1 kinds (the deleted MOCK_GRAPH/persist.ts era). Restated here, leaf-module rule.
const LEGACY_NODE_KINDS = new Set(["trigger", "review"]);
const LEGACY_ADDON_KINDS = new Set(["rule", "skill", "model", "hook", "permission"]);

/** Legacy `model` values were aliases ("sonnet", "opus"); v1's `FlowNode.model` is a provider id.
 *  Core claude ids only: a module's model has no legacy alias and fails validate.ts if absent. */
const LEGACY_MODEL_IDS: Record<string, ModelId> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-4-5-20251001",
  fable: "claude-fable-5-1",
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-opus-5-5": "claude-opus-5-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-fable-5-1": "claude-fable-5-1",
};

/** Legacy `permission` values named a mode, not a tool list. "read-only" → the read tools, which
 *  `permission-allowlist` auto-approves (everything else still pauses for Approve/Deny). */
function legacyAllowlist(value: string): string {
  return value.trim().toLowerCase() === "read-only" ? "Read,Grep,Glob" : value;
}

/** A graph is "legacy" only if it carries a pre-v1 node or addon kind. A v1 graph holding a
 *  reserved kind (`tool`, `effort`) from a future version is left alone for validate.ts to flag. */
function isLegacyGraph(graph: FlowGraph): boolean {
  return graph.nodes.some(
    (n) => LEGACY_NODE_KINDS.has(n.kind as string) || (n.addons ?? []).some((a) => LEGACY_ADDON_KINDS.has(a.kind as string)),
  );
}

function nodeText(n: FlowNode): string {
  return [n.title, ...n.fields.map((f) => `${f.k}: ${f.v}`)].join("\n");
}

function withField(fields: FlowField[], k: string, v: string, first = false): FlowField[] {
  if (fields.some((f) => f.k === k)) return fields;
  return first ? [{ k, v }, ...fields] : [...fields, { k, v }];
}

/** Rewrites one legacy graph to v1 kinds. Per kind:
 *  - node `trigger` → `input` (id becomes "input" when free, so `{{input}}` resolves; edges follow);
 *    gains v1's shape/content fields, content left empty for the user to fill (validate warns).
 *  - node `review` → `agent` with `{k:"preset",v:"review"}`; legacy `agent` stays `agent`. Both gain
 *    the required `task` field (empty unless present: no invented task text).
 *  - node `tool` (legacy only; reserved v2 kind, no v1 equivalent) → dropped, its in-edge bridged
 *    to its out-edge so the chain stays connected.
 *  - addon/field `model` → `node.model` (alias mapped); addon `permission` → `permission-allowlist`.
 *  - addons `rule`/`skill`/`hook`/`effort` → dropped (no v1 transport, §3).
 *  Idempotent: its output is not legacy, so a second call returns `changed:false` — that is what
 *  makes it run once per graph. */
export function normalizeLegacyGraph(graph: FlowGraph): { graph: FlowGraph; changed: boolean; drops: LegacyDrop[] } {
  if (!isLegacyGraph(graph)) return { graph, changed: false, drops: [] };
  const drops: LegacyDrop[] = [];
  const drop = (nodeId: string, what: LegacyDrop["what"], kind: string, text: string) =>
    drops.push({ graphId: graph.id, nodeId, what, kind, text });

  let edges = graph.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } }));
  const nodes: FlowNode[] = [];
  for (const src of graph.nodes) {
    const kind = src.kind as string;
    if (kind === "tool") {
      drop(src.id, "node", kind, nodeText(src));
      for (const a of src.addons ?? []) drop(src.id, "addon", a.kind, a.value ?? a.label);
      const inE = edges.find((e) => e.to.node === src.id);
      const outE = edges.find((e) => e.from.node === src.id);
      edges = edges.filter((e) => e.to.node !== src.id && e.from.node !== src.id);
      if (inE && outE) edges.push({ id: outE.id, from: inE.from, to: outE.to });
      continue;
    }

    const node: FlowNode = { ...src, fields: src.fields.map((f) => ({ ...f })) };
    const isAgent = kind === "agent" || kind === "review";
    let model: ModelId | undefined = src.model;
    // Maps a legacy model alias onto the node's model; returns false when it can't be kept (not
    // an agent, unknown alias, or conflicting with a model already set) so the caller records it.
    const takeModel = (v: string): boolean => {
      const mapped = isAgent ? LEGACY_MODEL_IDS[v.trim().toLowerCase()] : undefined;
      if (!mapped) return false;
      model ??= mapped;
      return model === mapped;
    };
    const addons: FlowAddon[] = [];
    for (const a of src.addons ?? []) {
      const value = a.value ?? a.label;
      if (a.kind === ("model" as string)) {
        if (!takeModel(value)) drop(src.id, "addon", a.kind, value);
      } else if (a.kind === ("permission" as string)) {
        const list = legacyAllowlist(value);
        addons.push({ kind: "permission-allowlist", label: list, value: list }); // label = value, as inspector.ts's ADD does
      } else if (LEGACY_ADDON_KINDS.has(a.kind as string) || a.kind === "effort") {
        drop(src.id, "addon", a.kind, value);
      } else {
        addons.push({ ...a, value });
      }
    }
    const modelField = node.fields.find((f) => f.k === "model");
    if (modelField) {
      if (!takeModel(modelField.v)) drop(src.id, "field", "model", modelField.v);
      node.fields = node.fields.filter((f) => f !== modelField);
    }

    if (kind === "trigger") {
      node.kind = "input";
      node.fields = withField(withField(node.fields, "content", "", true), "shape", "free-text", true);
      node.fieldSpecs = [
        { k: "shape", required: true, kind: "select", options: ["free-text", "structured"] },
        { k: "content", required: true, kind: "text" },
      ];
      node.inputs = [];
      if (node.id !== "input" && !graph.nodes.some((n) => n.id === "input")) {
        const oldId = node.id;
        node.id = "input";
        for (const e of edges) {
          if (e.from.node === oldId) e.from.node = "input";
          if (e.to.node === oldId) e.to.node = "input";
        }
      }
    } else if (isAgent) {
      node.kind = "agent";
      node.fields = withField(node.fields, "task", "", true);
      if (kind === "review") node.fields = withField(node.fields, "preset", "review");
      if (!node.fieldSpecs?.some((s) => s.k === "task")) {
        node.fieldSpecs = [...(node.fieldSpecs ?? []), { k: "task", required: true, kind: "text" }];
      }
      if (model) node.model = model;
    }
    if (!isAgent) {
      // input/output never carry addons in v1 (§3); anything left here has no transport.
      for (const a of addons) drop(src.id, "addon", a.kind, a.value);
      addons.length = 0;
    }
    if (addons.length) node.addons = addons;
    else delete node.addons;
    nodes.push(node);
  }
  return { graph: { ...graph, nodes, edges }, changed: true, drops };
}

/** Applies `normalizeLegacyGraph` to every graph in the envelope. `changed` tells the caller to
 *  back up the pre-normalisation raw envelope and save the result. */
export function normalizeLegacyEnvelope(env: GraphsEnvelope): { env: GraphsEnvelope; changed: boolean; drops: LegacyDrop[] } {
  let changed = false;
  const drops: LegacyDrop[] = [];
  const graphs = env.graphs.map((g) => {
    const r = normalizeLegacyGraph(g);
    if (r.changed) changed = true;
    drops.push(...r.drops);
    return r.graph;
  });
  return { env: changed ? { ...env, graphs } : env, changed, drops };
}

/** First-load graphs seed: migrates the legacy layout when present, otherwise starts empty.
 *  Never seeds from templates or from the (now-deleted) mock graph (§7: "Never seeds
 *  MOCK_GRAPH"). Idempotent
 *  only in the sense that callers must gate this on `loadGraphsEnvelope` returning `null`
 *  first — calling it twice would re-migrate the still-present legacy layout key. */
export function seedGraphsIfAbsent(storage: StorageLike, now: string): GraphsEnvelope {
  const legacy = loadLegacyLayout(storage);
  if (legacy) {
    const graph = migrateLegacyLayout(legacy, now);
    return { v: 1, activeGraphId: graph.id, graphs: [graph] };
  }
  return { v: 1, activeGraphId: null, graphs: [] };
}

/** Bumped when the starter literals in `templates.ts` change and stored copies should follow
 *  (2: the vertical stack that came with orthogonal edges; 3: six linear starters and
 *  the Academy card retitled Analyze / Telemetry; 4: Diagnose And Fix's Review Fix sees the
 *  problem and must list any cut that leaves the symptom unfixed). */
export const STARTERS_REV = 9; // 9: Codex MCP A/B Bench retired
export const STARTERS_REV_KEY = "vidar.flow.startersRev";

/** Once per `rev`: replaces each stored template whose id matches a starter with the starter's
 *  current literal, removes retired starter ids, and appends missing starters. User templates
 *  (other ids) are untouched.
 *  Writes the templates and the rev marker, returns the templates now current. A refused write
 *  (read-only or unreadable store) never throws, so Flow still mounts; the rev marker is written
 *  only after the templates landed, so a refused save is retried on the next load. */
export function reseedStarters(storage: StorageLike, templates: FlowTemplate[], starters: FlowTemplate[], rev: number, retiredIds: readonly string[] = []): FlowTemplate[] {
  if (Number(storage.getItem(STARTERS_REV_KEY)) >= rev) return templates;
  const byId = new Map(starters.map((t) => [t.id, t]));
  const next = templates.filter((t) => !retiredIds.includes(t.id)).map((t) => byId.get(t.id) ?? t);
  for (const s of starters) if (!next.some((t) => t.id === s.id)) next.push(s);
  if (saveTemplatesEnvelope(storage, { v: 1, templates: next })) {
    try {
      storage.setItem(STARTERS_REV_KEY, String(rev));
    } catch {
      // best-effort: a lost marker only means the reseed runs again next load
    }
  }
  return next;
}

/** Seeds `TEMPLATES_KEY` with `defaults` when the key is absent; returns whatever templates are
 *  now current (the freshly-seeded defaults, or what was already stored). Takes the defaults as
 *  a parameter — `templates.ts`'s two §6 literals in the app, arbitrary fixtures in tests. */
export function seedTemplatesIfAbsent(storage: StorageLike, defaults: FlowTemplate[]): FlowTemplate[] {
  const existing = loadTemplatesEnvelope(storage);
  if (existing) return existing.templates;
  saveTemplatesEnvelope(storage, { v: 1, templates: defaults });
  return defaults;
}

/** In place, on a cloned draft: an agent node whose model is not in `wiredIds` takes the first
 *  wired id. Available models, non-agent nodes and an empty `wiredIds` are left alone. */
export function adaptModelsToWired(nodes: FlowNode[], wiredIds: readonly string[]): void {
  const first = wiredIds[0];
  if (first === undefined) return;
  for (const n of nodes) {
    if (n.kind === "agent" && !wiredIds.includes(n.model as string)) n.model = first as ModelId;
  }
}

/** Describe the agent stages as they will appear in a newly instantiated starter draft. */
export function starterDescription(template: FlowTemplate, wiredIds: readonly string[], modelLabel: (id: ModelId) => string): string {
  const nodes = structuredClone(template.graph.nodes);
  adaptModelsToWired(nodes, wiredIds);
  return nodes.filter((n) => n.kind === "agent")
    .map((n) => `${n.title} (${modelLabel(n.model as ModelId)})`).join(" → ");
}

/** New graph from a template: a fresh graph id/updatedAt, but every node id kept verbatim from
 *  the template (§7: "keeping node ids") — the template's task placeholders (§4.2) reference
 *  those ids, so renaming them would break every `{{ref}}` in the instantiated graph.
 *
 *  `structuredClone`s the nodes/edges wholesale (WebView2 and Node 24 both have it) rather than
 *  hand-copying `fields`/`addons` only, which left `fieldSpecs`/`inputs`/`outputs` (and each
 *  `fieldSpecs` entry) shared with the template literal in `S.templates` — an in-place edit to an
 *  instantiated node's ports or field specs would have mutated the stored template. */
export function instantiateTemplate(template: FlowTemplate, now: string, wiredIds?: readonly string[]): FlowGraph {
  const nodes = structuredClone(template.graph.nodes);
  if (wiredIds) adaptModelsToWired(nodes, wiredIds);
  return {
    id: newId("graph"),
    name: template.name,
    nodes,
    edges: structuredClone(template.graph.edges),
    updatedAt: now,
  };
}

/** Save's name for a graph joining the user list: `name` itself when free, else `name 2`,
 *  `name 3`, … — the first suffix no taken name already holds (exact match, case kept). */
export function uniqueGraphName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

export type DeleteGraphResult =
  | { ok: true; env: GraphsEnvelope; activeChanged: boolean }
  | { ok: false; reason: "protected" | "missing" };

/** Delete for the picker's User list: `env` without graph `id`. A template or starter id
 *  (`protectedIds`) is refused even if a graph somehow carries it, and so is an id the list
 *  does not hold. Deleting the active graph leaves none active (`null`): the canvas shows the
 *  empty state until New or a template, never a fallback graph or an Untitled draft (user,
 *  2026-10-16). Runs live in their own store and are not touched. */
export function deleteGraphFromEnvelope(env: GraphsEnvelope, id: string, protectedIds: readonly string[]): DeleteGraphResult {
  if (protectedIds.includes(id)) return { ok: false, reason: "protected" };
  if (!env.graphs.some((g) => g.id === id)) return { ok: false, reason: "missing" };
  const graphs = env.graphs.filter((g) => g.id !== id);
  const activeChanged = env.activeGraphId === id;
  const activeGraphId = activeChanged ? null : env.activeGraphId;
  return { ok: true, env: { v: 1, activeGraphId, graphs }, activeChanged };
}

/** Drops graph entries that aren't well-formed (missing array `nodes`/`edges`), stamps
 *  id/name/updatedAt onto every survivor, and resolves `activeGraphId` to a graph that actually
 *  exists in the (filtered) list — a dangling id falls back to the first remaining graph, or
 *  `null` when none remain; a stored `null` (the open flow was deleted) stays `null`. Without this, a stored entry missing an id reached `S.graphs` unstamped, and a stale
 *  `activeGraphId` (naming no graph) left `S.nodes`/`S.edges` empty with every later
 *  `scheduleGraphSave` silently a no-op, since it exits at `idx === -1`.
 *  Call on every load, not just first-load seeding — a hand-edited or downgraded-then-upgraded
 *  envelope can carry either problem even when `v` and top-level shape are fine. */
export function normalizeGraphsEnvelope(env: GraphsEnvelope, now: string): GraphsEnvelope {
  const graphs = env.graphs
    .filter(
      (g): g is FlowGraph =>
        isRecord(g) && Array.isArray((g as Partial<FlowGraph>).nodes) && Array.isArray((g as Partial<FlowGraph>).edges),
    )
    .map((g) => stampGraph(g, now));
  const activeGraphId =
    env.activeGraphId === null || graphs.some((g) => g.id === env.activeGraphId) ? env.activeGraphId : graphs[0]?.id ?? null;
  return { v: 1, activeGraphId, graphs };
}
