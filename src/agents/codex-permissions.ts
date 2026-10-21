// Codex's session mode selection -> app-server thread and turn policy.
// The table is contracts/codex-policy.json, shared with Falcon-hosted Codex (src-falcon codex/driver/policy.rs).
import type { PermissionMode } from "./protocol";
import policy from "../../contracts/codex-policy.json" with { type: "json" };

interface ModePolicy { approvalPolicy: string; approvalsReviewer: string; sandbox: string }
const MODES = policy.modes as Record<PermissionMode, ModePolicy>;
const TURN_SANDBOX = policy.turnSandbox as Record<string, string>;

export function codexThreadPolicy(mode: PermissionMode) {
  // The shared `auto` selection has agent-specific semantics: Codex Auto Review.
  const { approvalPolicy, approvalsReviewer, sandbox } = MODES[mode];
  return { approvalPolicy, approvalsReviewer, sandbox };
}

/** thread/start and thread/resume params: cwd, the mode's policy, the pinned model if any, and the Bare
 *  rune payload when given (callers pass it for thread/start only). */
export function threadParams(cwd: string, mode: PermissionMode, model?: string, developerInstructions?: string): Record<string, unknown> {
  return { cwd, ...codexThreadPolicy(mode), ...(model ? { model } : {}), ...(developerInstructions ? { developerInstructions } : {}) };
}

export function codexTurnPolicy(mode: PermissionMode) {
  const { approvalPolicy, approvalsReviewer, sandbox } = MODES[mode];
  return { approvalPolicy, approvalsReviewer, sandboxPolicy: { type: TURN_SANDBOX[sandbox] } };
}
