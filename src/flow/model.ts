// Flow tab data shapes. Chain-only v1, growth-shaped for v2 branching/judge/gate/fan-out.

export type V1NodeKind = "input" | "agent" | "output";
type ReservedNodeKind = "judge" | "gate" | "tool";   // v2; never offered, validate.ts rejects
type FlowNodeKind = V1NodeKind | ReservedNodeKind;
/** The palette builds from this; validate.ts accepts only these (any other string, legacy included, is invalid). */
export const V1_NODE_KINDS: readonly V1NodeKind[] = ["input", "agent", "output"];

import type { FlowBackend } from "./runner";

// Provider id: the literal string sent to the sidecar's --model / used to pick the
// gateway env. Display id/label live in roster.ts, not here — exactly one id space is kept
// here and display strings map in roster.ts. Core ids are named; any other id is a
// `flowModels` id from an agent module (modules.md), checked against the roster by validate.ts.
export type CoreModelId =
  | "claude-fable-5-1" | "claude-opus-5-5" | "claude-sonnet-5" | "claude-haiku-4-5-20251001";
export type ModelId = CoreModelId | (string & {});

/** The modes a Flow Claude node can spawn in: the user's own mode, resolved once per run in Rust.
 *  bypassPermissions and plan are never members. */
export type PermissionMode = "default" | "acceptEdits" | "auto";

export type V1AddonKind = "system-prompt" | "cwd" | "retries";
type ReservedAddonKind =                                // named, never offered in v1
  | "permission-allowlist"                                     // retired: permissions come from the node's vault; stripped on load
  | "effort"                                                   // needs a sidecar flag; out of v1
  | "budget" | "loop-until" | "fan-out" | "resume" | "output-schema";
export type FlowAddonKind = V1AddonKind | ReservedAddonKind;
/** The inspector's ADD picker builds from this array, never from FlowAddonKind. */
export const V1_ADDON_KINDS: readonly V1AddonKind[] = ["system-prompt", "cwd", "retries"];

export interface FlowAddon {
  kind: FlowAddonKind;
  label: string;
  value: string; // required. "system-prompt": text; "cwd": absolute dir; "retries": "0" | "1" | "2" (§4.2)
}

/** Recorded on agent nodes as the field {k:"preset", v:<AgentPreset>} (no FlowNode change);
 *  the inspector shows it read-only. engine.ts finds the Academy node by this, never by title. */
export type AgentPreset =
  | "plan" | "review" | "revise" | "execute" | "brainstorm-format" | "academy" | "improve" | "custom";

export interface FlowFieldSpec {
  k: string;
  required?: boolean;
  kind?: "text" | "select" | "number";
  options?: string[];
}

export interface FlowField {
  k: string;
  v: string;
}

export interface FlowNode {
  id: string;                   // /^[a-z][a-z0-9_-]*$/, unique within its graph; "input" is the
                                // input node's id, so {{input}} and the input node coincide (§4.2)
  kind: FlowNodeKind;
  title: string;
  subtitle?: string;
  x: number;
  y: number;
  model?: ModelId;              // required for kind:"agent" in v1; enforced by validate.ts
  vault?: string;               // Rune Vault id the node loads (rune_vault_list); unset = the agent's stock vault
  backend?: FlowBackend;       // legacy field: ignored, engine.ts derives the backend from `model`
  fields: FlowField[];          // "task" (agent's prompt-with-placeholders text) lives here
  fieldSpecs?: FlowFieldSpec[];
  inputs: string[];             // named ports, e.g. ["in"]; kept as strings (not indices) so
  outputs: string[];            // v2 multi-port nodes (gate's "pass"/"fail") need no type change
  addons?: FlowAddon[];
}

export interface FlowEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface FlowGraph {   // all five required
  id: string;
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  updatedAt: string;           // ISO 8601
}

export interface FlowTemplate {
  id: string;
  name: string;
  description?: string;
  graph: Omit<FlowGraph, "id" | "updatedAt">;
}

