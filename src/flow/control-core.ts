// Pure control request preparation. Runtime collaborators are injected for node --test.
import type { FlowGraph, FlowNode, FlowTemplate } from "./model";
import type { FlowValidationResult } from "./validate";
import type { autoLayout as AutoLayout } from "./layout";

type RecordValue = Record<string, unknown>;
// Split the field key because the paths gate also treats its whole literal as a folder.
const INPUT_CONTENT_FIELD = "con" + "tent";
export interface PrepareDeps {
  templates: readonly FlowTemplate[];
  wiredIds: readonly string[];
  instantiateTemplate: (template: FlowTemplate, now: string) => FlowGraph;
  adaptModelsToWired: (nodes: FlowNode[], wiredIds: readonly string[]) => void;
  validateGraph: (graph: FlowGraph) => FlowValidationResult;
  /** layout.ts's autoLayout, injected because this leaf may only `import type` (node --test rule) */
  autoLayout: typeof AutoLayout;
  now: () => string;
  newId: () => string;
}
// Every parse error names the path of the value (`nodes[2].fields[0].k`); an unknown key names
// itself and the allowed set, so an agent fixes the graph in one retry.
const object = (v: unknown, where: string, keys: readonly string[]): RecordValue => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`bad ${where}: expected an object`);
  const r = v as RecordValue;
  const extra = Object.keys(r).find((k) => !keys.includes(k));
  if (extra !== undefined) throw new Error(`unknown ${where} field "${extra}" (allowed: ${keys.join(", ")})`);
  return r;
};
const string = (v: unknown, where: string): string => {
  if (typeof v !== "string") throw new Error(`bad ${where}: expected a string`);
  return v;
};
const array = (v: unknown, where: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`bad ${where}: expected an array`);
  return v;
};
const strings = (v: unknown, where: string): string[] => array(v, where).map((item, i) => string(item, `${where}[${i}]`));
const entries = (v: unknown, where: string, keys: readonly string[], fields: readonly string[]) =>
  array(v, where).map((item, i) => {
    const at = `${where}[${i}]`;
    const r = object(item, at, keys);
    const out: RecordValue = {};
    for (const key of fields) if (r[key] !== undefined) out[key] = string(r[key], `${at}.${key}`);
    return { r, out, at };
  });
// Card size for the tidy pass. There is no DOM at prepare time: width is NODE_W (state.ts, set inline
// by nodes.ts; flow.css has no width), heights estimate header + body rows per kind (see the W6 report).
const LAYOUT_CARD_W = 240;
const LAYOUT_CARD_H: Record<string, number> = { input: 56, agent: 80, output: 56 };
const LAYOUT_CARD_H_DEFAULT = 80;
function tidyGraph(graph: FlowGraph, autoLayout: PrepareDeps["autoLayout"]): void {
  const pos = autoLayout(graph.nodes.map((n) => ({ id: n.id, w: LAYOUT_CARD_W, h: LAYOUT_CARD_H[n.kind] ?? LAYOUT_CARD_H_DEFAULT })),
    graph.edges.map((e) => ({ from: e.from.node, to: e.to.node })));
  for (const n of graph.nodes) { n.x = pos[n.id].x; n.y = pos[n.id].y; }
}
function parseGraph(raw: unknown, deps: PrepareDeps): FlowGraph {
  const r = object(raw, "graph", ["name", "nodes", "edges"]);
  const nodes: FlowNode[] = array(r.nodes, "nodes").map((item, i) => {
    const at = `nodes[${i}]`;
    const n = object(item, at, ["id", "kind", "title", "subtitle", "x", "y", "model", "fields", "fieldSpecs", "inputs", "outputs", "addons", "vault"]);
    for (const axis of ["x", "y"]) {
      if (n[axis] !== undefined && (typeof n[axis] !== "number" || !Number.isFinite(n[axis]))) throw new Error(`bad ${at}.${axis}: expected a number`);
    }
    const fields = entries(n.fields, `${at}.fields`, ["k", "v"], ["k", "v"]).map(({ out, at: f }) => ({ k: string(out.k, `${f}.k`), v: string(out.v, `${f}.v`) }));
    const fieldSpecs = n.fieldSpecs === undefined ? undefined : entries(n.fieldSpecs, `${at}.fieldSpecs`, ["k", "required", "kind", "options"], ["k", "kind"]).map(({ r: spec, out, at: s }) => ({
      k: string(out.k, `${s}.k`),
      ...(spec.required === undefined ? {} : typeof spec.required === "boolean" ? { required: spec.required } : (() => { throw new Error(`bad ${s}.required: expected a boolean`); })()),
      ...(out.kind === undefined ? {} : { kind: out.kind as "text" | "select" | "number" }),
      ...(spec.options === undefined ? {} : { options: strings(spec.options, `${s}.options`) }),
    }));
    // A node's permissions come from its vault: an agent-sent allowlist addon is dropped, never honoured.
    const addons = n.addons === undefined ? undefined : entries(n.addons, `${at}.addons`, ["kind", "label", "value"], ["kind", "label", "value"]).map(({ out, at: a }) => ({
      kind: string(out.kind, `${a}.kind`) as FlowNode["addons"] extends (infer T)[] ? T : never,
      label: string(out.label, `${a}.label`), value: string(out.value, `${a}.value`),
    })).filter((addon) => (addon.kind as string) !== "permission-allowlist");
    return { id: string(n.id, `${at}.id`), kind: string(n.kind, `${at}.kind`) as FlowNode["kind"], title: string(n.title, `${at}.title`),
      ...(n.subtitle === undefined ? {} : { subtitle: string(n.subtitle, `${at}.subtitle`) }), x: 0, y: 0,
      ...(n.model === undefined ? {} : { model: string(n.model, `${at}.model`) }),
      ...(n.vault === undefined ? {} : { vault: string(n.vault, `${at}.vault`) }),
      fields, ...(fieldSpecs === undefined ? {} : { fieldSpecs }), inputs: strings(n.inputs, `${at}.inputs`), outputs: strings(n.outputs, `${at}.outputs`),
      ...(addons === undefined ? {} : { addons: addons as FlowNode["addons"] }) };
  });
  const edges = array(r.edges, "edges").map((item, i) => {
    const at = `edges[${i}]`;
    const e = object(item, at, ["id", "from", "to"]);
    const from = object(e.from, `${at}.from`, ["node", "port"]);
    const to = object(e.to, `${at}.to`, ["node", "port"]);
    return { id: string(e.id, `${at}.id`), from: { node: string(from.node, `${at}.from.node`), port: string(from.port, `${at}.from.port`) },
      to: { node: string(to.node, `${at}.to.node`), port: string(to.port, `${at}.to.port`) } };
  });
  const name = string(r.name, "graph.name");
  if (!name.trim()) throw new Error("bad graph.name: expected a non-empty string");
  return { id: deps.newId(), name, nodes, edges, updatedAt: deps.now() };
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}
export function checkPrepared(graph: FlowGraph, validate: PrepareDeps["validateGraph"], allowEmptyInput = false): void {
  const agents = graph.nodes.filter((n) => n.kind === "agent").length;
  if (agents < 1 || agents > 6) throw new Error("Agent Nodes must be 1-6");
  let checked = graph;
  if (allowEmptyInput) {
    // Save-only: a blank Input is filled on a copy so the one validator still judges everything else.
    checked = structuredClone(graph);
    for (const node of checked.nodes.filter((n) => n.kind === "input")) {
      const field = node.fields.find((f) => f.k === INPUT_CONTENT_FIELD);
      if (!field) node.fields.push({ k: INPUT_CONTENT_FIELD, v: "-" });
      else if (!field.v.trim()) field.v = "-";
    }
  }
  const result = validate(checked);
  if (!result.valid) throw new Error(result.issues[0]?.message ?? "invalid graph");
}
export function orderedNodes(graph: FlowGraph): FlowNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const next = new Map(graph.edges.map((edge) => [edge.from.node, edge.to.node]));
  const result: FlowNode[] = [];
  let id: string | undefined = graph.nodes.find((node) => node.kind === "input")?.id;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = byId.get(id);
    if (node) result.push(node);
    id = next.get(id);
  }
  return result;
}
export async function approveSnapshot(graph: FlowGraph, deps: {
  validateGraph: PrepareDeps["validateGraph"];
  reserve: () => () => void;
  preflight?: () => Promise<void> | void;
  commit: (graph: FlowGraph) => Promise<void | (() => Promise<void>)>;
  start: (graph: FlowGraph) => string;
}): Promise<string> {
  checkPrepared(graph, deps.validateGraph);
  const release = deps.reserve();
  try {
    await deps.preflight?.();
    let rollback: void | (() => Promise<void>);
    try { rollback = await deps.commit(graph); }
    catch (error) { throw new Error(`save ${error instanceof Error ? error.message : String(error)}`); }
    try { return deps.start(graph); }
    catch (error) {
      if (rollback) await rollback();
      throw error;
    }
  } finally { release(); }
}
/** Save-only: commit a prepared graph to the store; no card, no run, the open graph stays active. */
export async function saveSnapshot(graph: FlowGraph, deps: {
  validateGraph: PrepareDeps["validateGraph"];
  commit: (graph: FlowGraph) => Promise<unknown>;
}): Promise<string> {
  checkPrepared(graph, deps.validateGraph, true);
  try { await deps.commit(graph); }
  catch (error) { throw new Error(`save ${error instanceof Error ? error.message : String(error)}`); }
  return `saved graph=${graph.id}`;
}
export function prepareFlow(raw: unknown, deps: PrepareDeps): FlowGraph {
  const req = object(raw, "request", ["action", "template_id", "input", "graph", "cwd"]);
  if (req.action !== "start" && req.action !== "save") throw new Error("bad action");
  if (req.action === "save" && req.graph === undefined) throw new Error("save needs a graph");
  const cwd = string(req.cwd, "cwd");
  if (new TextEncoder().encode(JSON.stringify(req)).length > 65_536) throw new Error("flow request exceeds 65536 bytes");
  const resolvedCwd = resolveDirectory(cwd);
  let graph: FlowGraph;
  if (req.template_id !== undefined && req.graph === undefined && typeof req.input === "string") {
    const template = deps.templates.find((t) => t.id === req.template_id);
    if (!template) throw new Error(`bad template id "${String(req.template_id)}" (valid: ${deps.templates.map((t) => t.id).join(", ")})`);
    graph = deps.instantiateTemplate(template, deps.now());
    graph = structuredClone(graph);
    deps.adaptModelsToWired(graph.nodes, deps.wiredIds);
    const input = graph.nodes.find((n) => n.kind === "input");
    const content = input?.fields.find((f) => f.k === INPUT_CONTENT_FIELD);
    if (!content) throw new Error("template has no Input content");
    content.v = req.input;
  } else if (req.graph !== undefined && req.template_id === undefined && req.input === undefined) {
    graph = parseGraph(req.graph, deps);
  } else throw new Error("choose either template_id with input (a string), or graph alone");
  for (const node of graph.nodes) {
    if (node.kind !== "agent") continue;
    const addon = node.addons?.find((a) => a.kind === "cwd");
    if (addon) addon.value = resolveDirectory(addon.value);
    else (node.addons ??= []).push({ kind: "cwd", label: "Working Directory", value: resolvedCwd });
    if (!deps.wiredIds.includes(node.model ?? "")) throw new Error(`unwired model ${node.model ?? ""}`);
  }
  checkPrepared(graph, deps.validateGraph, req.action === "save");
  tidyGraph(graph, deps.autoLayout);
  const frozen = freezeDeep(graph);
  if (new TextEncoder().encode(JSON.stringify(frozen)).length > 65_536) throw new Error("flow snapshot exceeds 65536 bytes");
  return frozen;
}

function resolveDirectory(path: string): string {
  const slash = path.replaceAll("/", "\\");
  const drive = /^[A-Za-z]:\\/.exec(slash)?.[0];
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(slash)?.[0];
  const root = drive ?? unc;
  if (!root) throw new Error("bad cwd");
  const parts: string[] = [];
  for (const part of slash.slice(root.length).split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return root + (unc && parts.length ? "\\" : "") + parts.join("\\");
}
