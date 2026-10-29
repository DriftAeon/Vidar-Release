// Pure v1 graph validation: kind whitelist, chain-only topology, required fields, {{ref}}
// resolvability, addon value presence, retries range, structured-content JSON parse. Leaf module
// (only `import type` from model.ts, so it stays importable under `node --test`'s extensionless
// resolution) — no DOM, no S, no scheduleSave.

import type { FlowGraph, FlowNode, V1AddonKind, V1NodeKind } from "./model";

/** Mirrors model.ts's `V1_NODE_KINDS` (a value export; a leaf module restates it locally per §7's
 *  leaf-module rule — this fails to compile if the union in model.ts changes). */
const V1_KINDS: Record<V1NodeKind, true> = { input: true, agent: true, output: true };

/** Mirrors model.ts's `V1_ADDON_KINDS` — same leaf-module restatement as `V1_KINDS` above. A
 *  loaded graph carrying a reserved (`effort`, `budget`, …) or legacy addon kind on a v1 agent
 *  node otherwise passes validation and is silently ignored at runtime. */
const V1_ADDON_KIND_SET: Record<V1AddonKind, true> = {
  "system-prompt": true,
  cwd: true,
  retries: true,
};

/** Mirrors roster.ts's wired core models — same leaf-module restatement (leaf modules can't
 *  import each other under `node --test`). Other ids come from active agent modules'
 *  `flowModels`, handed in by roster.ts through `setPackModelIds`. A loaded graph can name a
 *  model that is not present (its module off or removed); that is an error naming the model,
 *  not only "not blank" (the inspector shows the first wired model while the absent one
 *  would actually run). */
const CORE_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-sonnet-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-haiku-4-5-20251001",
  "codex-default",
]);
let packModelIds: ReadonlySet<string> = new Set();
let liveModelIds: (() => readonly string[]) | null = null;

/** roster.ts hands in the models the running app offers (a module off hides its rows); once set
 *  it replaces the static core list and the pack set, so a graph naming a hidden model fails as
 *  unavailable. `null` restores the static lists. */
export function setLiveModelIds(source: (() => readonly string[]) | null): void {
  liveModelIds = source;
}

function modelAvailable(id: string): boolean {
  if (liveModelIds) return liveModelIds().includes(id);
  return CORE_MODEL_IDS.has(id) || packModelIds.has(id);
}

let liveVaultIds: (() => readonly string[]) | null = null;
let agentOfModel: ((model: string) => string) | null = null;

/** inspector.ts hands in the vault ids `rune_vault_list` returned; until then (or on `null`) an
 *  unknown vault id cannot be told apart from a slow list, so only the stock check runs. */
export function setLiveVaultIds(source: (() => readonly string[]) | null): void {
  liveVaultIds = source;
}

/** The agent id a model runs on (`stock-<agent>` is that agent's own vault); `null` skips the stock check. */
export function setVaultAgentOf(fn: ((model: string) => string) | null): void {
  agentOfModel = fn;
}

/** The `flowModels` ids of the active agent modules; replaces the previous set. */
export function setPackModelIds(ids: readonly string[]): void {
  packModelIds = new Set(ids);
}

/** Mirrors snap.ts's `ID_CHARSET` — same leaf-module restatement. */
const ID_CHARSET = /^[a-z][a-z0-9_-]*$/;

/** Mirrors §4.2's frozen placeholder regex — validate.ts's own copy, since leaf modules cannot
 *  import each other under `node --test` (render.ts restates the same pattern). */
const PLACEHOLDER_RE = /\{\{([a-z0-9_-]+)\}\}/g;

interface FlowValidationIssue {
  nodeId?: string;
  message: string;
}

export interface FlowValidationResult {
  valid: boolean;
  issues: FlowValidationIssue[];
  /** Node ids that fail some per-node check — the inspector/canvas warn-border set (§5's "warn
   *  marker"; §3's "warn border, blocks RUN"). */
  invalidNodeIds: Set<string>;
}

export function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim() === "";
}

function fieldValue(node: FlowNode, k: string): string | undefined {
  return node.fields.find((f) => f.k === k)?.v;
}

/** Chain-only in v1: exactly one `input` node (in-degree 0, out-degree <= 1), exactly one
 *  `output` node (out-degree 0, in-degree <= 1), every other node exactly one in-edge and one
 *  out-edge, no cycles, no branch/merge, and the walk from input reaches every node in the graph
 *  — an orphan or a branch is a topology error (§3: "a node is invalid... if the graph isn't a
 *  single valid chain"). Returns the chain order (input-first) for `checkRefs` to use; returns
 *  `[]` when the node count of inputs/outputs itself is wrong (nothing sane to order).
 */
function checkTopology(graph: FlowGraph, issues: FlowValidationIssue[]): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, string[]>();
  const inCount = new Map<string, number>();
  for (const n of graph.nodes) {
    outEdges.set(n.id, []);
    inCount.set(n.id, 0);
  }
  for (const e of graph.edges) {
    if (!byId.has(e.from.node) || !byId.has(e.to.node)) {
      issues.push({ message: `Edge "${e.id}" references a missing node` });
      continue;
    }
    outEdges.get(e.from.node)!.push(e.to.node);
    inCount.set(e.to.node, (inCount.get(e.to.node) ?? 0) + 1);
  }

  const inputs = graph.nodes.filter((n) => n.kind === "input");
  const outputs = graph.nodes.filter((n) => n.kind === "output");
  if (inputs.length !== 1) {
    issues.push({ message: `Graph must have exactly one input node (found ${inputs.length})` });
    return [];
  }
  if (outputs.length !== 1) {
    issues.push({ message: `Graph must have exactly one output node (found ${outputs.length})` });
    return [];
  }

  for (const n of graph.nodes) {
    const out = outEdges.get(n.id)!.length;
    const inn = inCount.get(n.id) ?? 0;
    if (n.kind === "input") {
      if (inn !== 0) issues.push({ nodeId: n.id, message: `Input node "${n.id}" cannot have an incoming edge` });
      if (out > 1) issues.push({ nodeId: n.id, message: `Input node "${n.id}" cannot branch (more than one outgoing edge)` });
    } else if (n.kind === "output") {
      if (out !== 0) issues.push({ nodeId: n.id, message: `Output node "${n.id}" cannot have an outgoing edge` });
      if (inn > 1) issues.push({ nodeId: n.id, message: `Output node "${n.id}" cannot have more than one incoming edge` });
    } else {
      if (out > 1) issues.push({ nodeId: n.id, message: `Node "${n.id}" cannot branch (more than one outgoing edge)` });
      if (inn > 1) issues.push({ nodeId: n.id, message: `Node "${n.id}" cannot merge (more than one incoming edge)` });
    }
  }

  // Walk the chain from the (unique) input; a branch/merge above already stopped the walk from
  // producing a false chain, a cycle re-visits a node, and an orphan never gets walked to.
  const order: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = inputs[0].id;
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    const outIds: string[] = outEdges.get(cur) ?? [];
    cur = outIds.length === 1 ? outIds[0] : undefined;
  }
  if (cur !== undefined && seen.has(cur)) {
    issues.push({ message: "Graph contains a cycle" });
  }
  const missed = graph.nodes.filter((n) => !seen.has(n.id));
  for (const n of missed) {
    issues.push({ nodeId: n.id, message: `Node "${n.id}" is not connected into the chain` });
  }
  if (missed.length === 0 && order[order.length - 1] !== outputs[0].id) {
    issues.push({ message: "Chain does not terminate at the output node" });
  }
  return order;
}

function checkRequiredFields(node: FlowNode, issues: FlowValidationIssue[]): void {
  for (const spec of node.fieldSpecs ?? []) {
    if (!spec.required) continue;
    if (isBlank(fieldValue(node, spec.k))) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}" is missing required field "${spec.k}"` });
    }
  }
  if (node.kind === "agent") {
    if (isBlank(node.model)) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}" has no model selected` });
    } else if (!modelAvailable(node.model as string)) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}"'s model "${node.model}" is not available` });
    }
  }
}

/** `vault` is optional (unset = the agent's stock vault). A set id must be a known vault, and a stock
 *  vault must be the node's own agent's. */
function checkVault(node: FlowNode, issues: FlowValidationIssue[]): void {
  if (node.kind !== "agent" || isBlank(node.vault)) return;
  const vault = node.vault as string;
  if (vault.startsWith("stock-") && agentOfModel && !isBlank(node.model) && vault !== `stock-${agentOfModel(node.model as string)}`) {
    issues.push({ nodeId: node.id, message: `Node "${node.id}": Stock Vault for Another Agent` });
  } else if (liveVaultIds && !liveVaultIds().includes(vault)) {
    issues.push({ nodeId: node.id, message: `Node "${node.id}": Unknown Vault "${vault}"` });
  }
}

function isAbsoluteWindowsDir(p: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return /^\\\\[^\\/?]+\\[^\\/]+/.test(p);
}

function checkAddons(node: FlowNode, issues: FlowValidationIssue[]): void {
  for (const a of node.addons ?? []) {
    if (!Object.hasOwn(V1_ADDON_KIND_SET, a.kind as string)) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}" has a modifier with an unsupported kind "${a.kind}"` });
      continue;
    }
    if (isBlank(a.value)) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}"'s "${a.kind}" modifier has no value` });
      continue;
    }
    if (a.kind === "retries" && !["0", "1", "2"].includes(a.value.trim())) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}"'s retries must be 0, 1 or 2` });
    }
    // Windows absolute only: `C:\x`, `C:/x` or a UNC `\\server\share`. Existence stays in Rust.
    if (a.kind === "cwd" && !isAbsoluteWindowsDir(a.value.trim())) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}"'s cwd must be an absolute Windows directory` });
    }
  }
}

function checkStructuredContent(node: FlowNode, issues: FlowValidationIssue[]): void {
  if (node.kind !== "input") return;
  if (fieldValue(node, "shape") !== "structured") return;
  const content = fieldValue(node, "content") ?? "";
  try {
    JSON.parse(content);
  } catch {
    issues.push({ nodeId: node.id, message: `Node "${node.id}"'s structured content is not valid JSON` });
  }
}

/** {{ref}} resolvability (§4.2): a ref must be `input` (only when an input node with id "input"
 *  exists) or the id of a node strictly upstream of this one in the chain order — a forward or
 *  self reference is a validate.ts error, never a runtime failure. `order` is `checkTopology`'s
 *  chain order (input-first); refs are still checked against whatever order that returned even
 *  when topology itself reported other errors, so a bad ref is reported independently. */
function checkRefs(node: FlowNode, order: string[], byId: Map<string, FlowNode>, issues: FlowValidationIssue[]): void {
  if (node.kind !== "agent") return;
  const task = fieldValue(node, "task") ?? "";
  const idx = order.indexOf(node.id);
  const upstream = new Set(idx >= 0 ? order.slice(0, idx) : []);
  const seenRefs = new Set<string>();
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(task))) {
    const ref = m[1];
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    if (ref === node.id) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}"'s task references itself ({{${ref}}})` });
      continue;
    }
    if (ref === "input") {
      const inputNode = byId.get("input");
      if (!inputNode || inputNode.kind !== "input") {
        issues.push({
          nodeId: node.id,
          message: `Node "${node.id}"'s task references {{input}} but there is no input node with id "input"`,
        });
      }
      continue;
    }
    const target = byId.get(ref);
    if (!target) {
      issues.push({ nodeId: node.id, message: `Node "${node.id}"'s task references unknown node {{${ref}}}` });
      continue;
    }
    if (!upstream.has(ref)) {
      issues.push({
        nodeId: node.id,
        message: `Node "${node.id}"'s task references {{${ref}}}, which is not upstream of it`,
      });
    }
  }
}

export function validateGraph(graph: FlowGraph): FlowValidationResult {
  const issues: FlowValidationIssue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // Object.hasOwn, not `in`, so a loaded kind/id of "toString" or "constructor" doesn't pass by
  // walking the prototype chain. Ids are also checked for uniqueness and the charset: two agent nodes both id "a" in
  // input→a→output collapse to one entry in checkTopology's byId/seen and "validate" as a chain).
  const seenIds = new Set<string>();
  for (const n of graph.nodes) {
    if (!Object.hasOwn(V1_KINDS, n.kind)) {
      issues.push({ nodeId: n.id, message: `Node "${n.id}" has an unsupported kind "${n.kind}"` });
    }
    if (!ID_CHARSET.test(n.id)) {
      issues.push({ nodeId: n.id, message: `Node "${n.id}" has an invalid id (must match ${ID_CHARSET})` });
    }
    if (seenIds.has(n.id)) {
      issues.push({ nodeId: n.id, message: `Node id "${n.id}" is used by more than one node` });
    } else {
      seenIds.add(n.id);
    }
  }

  const order = checkTopology(graph, issues);
  // A chain with no Agent would "succeed" without doing any work, so it cannot run. Skipped when
  // topology already bailed (order is empty) so the input/output count error stays the only message.
  if (order.length > 0 && !order.some((id) => byId.get(id)?.kind === "agent")) {
    issues.push({ message: "Chain needs at least one Agent node to run" });
  }

  for (const n of graph.nodes) {
    checkRequiredFields(n, issues);
    checkAddons(n, issues);
    checkVault(n, issues);
    checkStructuredContent(n, issues);
    checkRefs(n, order, byId, issues);
  }

  const invalidNodeIds = new Set<string>();
  for (const i of issues) if (i.nodeId) invalidNodeIds.add(i.nodeId);
  return { valid: issues.length === 0, issues, invalidNodeIds };
}
