// The approval record: one shape for every permission ask that waits on the user. Pure types and copy;
// no DOM, no invoke. Titles are the table the retired modal held, plus the Flow, Rendered and subagent cards.

import type { NodeMatrix } from "../control/node-matrix";

export type ApprovalOrigin = "ctl-prompt" | "ctl-spawn" | "ctl-flow" | "astra" | "review-dispatch" | "flow" | "rendered" | "subagent";

/** Card title per origin; the Record type makes tsc enforce coverage. */
export const APPROVAL_TITLES: Record<ApprovalOrigin, string> = {
  "ctl-prompt": "Type Into Tab",
  "ctl-spawn": "Open Agent Tab",
  "ctl-flow": "Run Flow",
  astra: "Open Astra Tab",
  "review-dispatch": "Type Into Astra",
  flow: "Tool Approval",
  rendered: "Tool Approval",
  subagent: "Agent Needs You",
};

export interface ApprovalRecord {
  id: string;
  origin: ApprovalOrigin;
  title: string;
  /** `verified`: the ask came over ctl.* from a known tab */
  asker: { tab: string | null; label: string; verified: boolean };
  rows: [string, string][];
  matrix?: NodeMatrix;
  /** the astra reason */
  question?: string;
  askedAtMs: number;
  /** Rust-stamped; absent on snapshot-derived records */
  expiresAtMs?: number;
  comment: boolean;
  drawInAskerTab: boolean;
}

export type ApprovalAnswer = { verdict: "approve" | "deny"; comment: string; where: string };
export type ApprovalOutcome = ApprovalAnswer | { verdict: "expired" | "cancelled"; reason: string };
