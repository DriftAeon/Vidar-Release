// Full Flow approval disclosure; never routes through lane-card's truncating formatter.
import type { FlowGraph, FlowNode } from "../flow/model";
import type { NodeGrants, NodeModes } from "../flow/permission-mode";
import type { MatrixFact, NodeMatrix } from "./node-matrix";
// Title Case card values for the modes a node can run in (kept here: this file loads under node --test).
const MODE_LABELS: Record<string, string> = { default: "Default", acceptEdits: "Accept Edits", auto: "Auto" };
// This is a field key; the paths gate counts its whole literal as a folder.
const INPUT_CONTENT_FIELD = "con" + "tent";

/** The vault's exact allow entries for a node, comma-joined; blank when the vault allows nothing. */
const allows = (grants: NodeGrants | undefined, id: string) => (grants?.[id]?.allow ?? []).join(", ");

export function flowCardRows(graph: FlowGraph, askedBy: string, orderedNodes: (graph: FlowGraph) => FlowNode[], modes?: NodeModes, grants?: NodeGrants): [string, string][] {
  const order = orderedNodes(graph);
  const rows: [string, string][] = [
    ["Asked By", askedBy], ["Flow", graph.name],
    ["Agent Nodes", String(order.filter((node) => node.kind === "agent").length)],
  ];
  const input = order.find((node) => node.kind === "input");
  rows.push(["Input", input?.fields.find((field) => field.k === INPUT_CONTENT_FIELD)?.v ?? ""]);
  for (const node of order.filter((item) => item.kind === "agent")) {
    const addon = (kind: string) => node.addons?.find((item) => item.kind === kind)?.value ?? "";
    rows.push(["Agent", `${node.id}: ${node.title}`], ["Model", node.model ?? ""],
      ["Working Directory", addon("cwd")], ["Task", node.fields.find((field) => field.k === "task")?.v ?? ""],
      ["Vault", grants?.[node.id]?.vault ?? ""], ["Permission Mode", MODE_LABELS[modes?.[node.id] ?? "default"] ?? "Default"],
      ["Allows", allows(grants, node.id)], ["System Prompt", addon("system-prompt")], ["Retries", addon("retries") || "0"]);
  }
  return rows;
}

/** The same disclosure as flowCardRows, laid out as the Node Matrix: agent nodes are the columns in run
 *  order (so no Order row), the flow-wide facts sit above. Full text, never truncated. */
export function flowCardMatrix(graph: FlowGraph, askedBy: string, orderedNodes: (graph: FlowGraph) => FlowNode[], modes?: NodeModes, grants?: NodeGrants): NodeMatrix {
  const order = orderedNodes(graph);
  const agents = order.filter((node) => node.kind === "agent");
  const input = order.find((node) => node.kind === "input")?.fields.find((field) => field.k === INPUT_CONTENT_FIELD)?.v ?? "";
  const addon = (node: FlowNode, kind: string) => node.addons?.find((item) => item.kind === kind)?.value ?? "";
  return {
    facts: ([
      { label: "Flow", icon: "flow", value: graph.name, strong: true },
      { label: "Asked By", icon: "user", value: askedBy },
      { label: "Input", icon: "input", value: input },
    ] as MatrixFact[]).filter((fact) => fact.value !== ""),
    nodes: agents.map((node) => ({ id: node.id, title: node.title })),
    fields: [
      { label: "Model", icon: "model", mono: true, cells: agents.map((node) => node.model ?? "") },
      { label: "Working Directory", icon: "folder", mono: true, cells: agents.map((node) => addon(node, "cwd")) },
      { label: "Vault", icon: "key", mono: true, cells: agents.map((node) => grants?.[node.id]?.vault ?? "") },
      { label: "Permission Mode", icon: "shield", cells: agents.map((node) => MODE_LABELS[modes?.[node.id] ?? "default"] ?? "Default") },
      { label: "Retries", icon: "retry", cells: agents.map((node) => addon(node, "retries") || "0") },
      { label: "Task", icon: "task", cells: agents.map((node) => node.fields.find((field) => field.k === "task")?.v ?? "") },
      { label: "Allows", icon: "tool", mono: true, cells: agents.map((node) => allows(grants, node.id)) },
      { label: "System Prompt", icon: "prompt", cells: agents.map((node) => addon(node, "system-prompt")) },
    ],
  };
}

export async function flowCardDecision(
  graphId: string,
  answer: { approved: boolean; shown: boolean; comment: string; reason?: string },
  cancelled: boolean, expired: boolean, requesterGone: boolean,
  approve: () => Promise<string>,
): Promise<{ ok: boolean; line: string; verdict?: string } | null> {
  if (cancelled || answer.reason === "expired") return null;
  if (!answer.shown) return { ok: false, line: `err ${answer.reason ?? "self-answered"}`, verdict: "failed" };
  if (!answer.approved) return { ok: false, line: `denied ${answer.comment}`, verdict: "denied" };
  if (expired || requesterGone) return { ok: false, line: "err expired", verdict: "failed" };
  try {
    const runId = await approve();
    return { ok: true, line: `started graph=${graphId} run=${runId}`, verdict: "approved" };
  } catch (error) {
    return { ok: false, line: `err ${error instanceof Error ? error.message : String(error)}`, verdict: "failed" };
  }
}
