// Type-level half of the bridge golden tests: the fixtures under tests/golden/ must be assignable to
// the frontend's wire types, and each key list below must equal its type's keys exactly (a key
// missing or extra fails tsc). bridge-golden.test.mjs runs tsc on this file
// (tests/golden/tsconfig.json) and compares the lists with the fixtures and the Rust sources at run
// time. The Rust half: src-tauri/src/bridge_golden.rs, src-falcon/src/bridge_golden.rs.

import type { FalconList, FalconSessionSummary } from "../../src/ipc";
import type { Decision, DecisionView } from "../../src/panels/display-decision";
import type { Dispatch } from "../../src/panels/sessions/astra-bridge";
import falconList from "./falcon-list.json" with { type: "json" };
import decision from "./display-decision.json" with { type: "json" };
import decisionView from "./display-decision-view.json" with { type: "json" };
import dispatch from "./review-dispatch.json" with { type: "json" };

/** `keys` lists every key of T and nothing else. */
function exactKeys<T>() {
  return <const K extends readonly (keyof T)[]>(keys: K & ([Exclude<keyof T, K[number]>] extends [never] ? unknown : never)) => keys;
}
/** `members` lists every member of the string union U and nothing else. */
function exactMembers<U extends string>() {
  return <const K extends readonly U[]>(members: K & ([Exclude<U, K[number]>] extends [never] ? unknown : never)) => members;
}

export const SESSION_SUMMARY_KEYS = exactKeys<FalconSessionSummary>()([
  "session", "generation", "agent", "cwd", "conversation", "pid", "model", "permission_mode",
  "attached", "exited", "queued_prompts", "pending_permissions", "degraded", "last_holder", "rules_file", "tab_name",
  "gateway", "profile", "env_names", "payload_file", "row_key", "sets", "mcp_file",
]);
export const DECISION_KEYS = exactKeys<Decision>()(["file", "sha256", "verdict", "comment", "atMs", "request"]);
export const DECISION_VIEW_KEYS = exactKeys<DecisionView>()(["decision", "current"]);
export const VERDICTS = exactMembers<Decision["verdict"]>()(["approve", "deny", "dismiss"]);
export const DISPATCH_KEYS = exactKeys<Dispatch>()(["id", "tab", "text", "requester"]);

// JSON imports widen string literals, so the verdict union is checked through
// VERDICTS instead; a gateway is any module id string.
type WideSummary = Omit<FalconSessionSummary, "gateway"> & { gateway?: string };
const goldenList: Omit<FalconList, "sessions"> & { sessions: WideSummary[] } = falconList;
const goldenDecision: Omit<Decision, "verdict"> & { verdict: string } = decision;
const goldenDecisionView: Omit<DecisionView, "decision"> & { decision: typeof goldenDecision } = decisionView;
const goldenDispatch: Dispatch = dispatch;
