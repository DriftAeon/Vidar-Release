// Codex Auto Review: the reviewer's decisions as notices and the fail-safe
// downgrade back to Default. `item/autoApprovalReview/*` is [UNSTABLE] in the
// schema, so every read here is defensive and a malformed payload yields null
// (the adapter then shows its quiet method notice); nothing here may throw.
import type { AgentEvent, PermissionMode } from "./protocol";

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
const cap = (s: string) => s.slice(0, 200);

/** One line per reviewed action. `writeStdin.stdin` is never printed: it can be a password. */
export function summarizeAction(action: Json): string {
  const type = str(action.type);
  switch (type) {
    case "command": return cap(str(action.command));
    case "execve": {
      const argv = Array.isArray(action.argv) ? action.argv.filter((a): a is string => typeof a === "string") : [];
      return cap(argv.length ? argv.join(" ") : str(action.program));
    }
    case "writeStdin": return `Process ${cap(str(action.processId))} Input`;
    case "applyPatch": return cap((Array.isArray(action.files) ? action.files : []).filter((f) => typeof f === "string").join(", "));
    case "networkAccess": return cap(str(action.target) || str(action.host));
    case "mcpToolCall": return cap(`${str(action.server)}.${str(action.toolName)}`);
    case "requestPermissions": return cap(str(action.reason) || type);
    default: return type;
  }
}

/** `item/autoApprovalReview/completed` → a notice, or null when the payload is off-shape.
 *  Approved stays quiet: a visible notice would seal the running tool group. */
export function reviewNotice(params: Json): AgentEvent | null {
  const review = obj(params.review);
  const action = obj(params.action);
  const status = str(review?.status);
  if (!review || !action || !str(action.type)) return null;
  const summary = summarizeAction(action);
  if (status === "approved") return { kind: "notice", text: `Auto Review Approved: ${summary}`, level: "info", quiet: true };
  if (status !== "denied" && status !== "timedOut" && status !== "aborted") return null;
  const rationale = cap(str(review.rationale));
  return { kind: "notice", text: `Auto Review Denied: ${summary}${rationale ? ` - ${rationale}` : ""}`, level: "warn" };
}

/** The server reports the plain user reviewer while the tab is in Auto Review
 *  (`guardian_subagent` is the legacy alias of auto_review, so it is not a downgrade). */
export function reviewerDowngrade(settings: unknown, mode: PermissionMode): boolean {
  return mode === "auto" && obj(settings)?.approvalsReviewer === "user";
}

/** Only an error that names the reviewer or approvals drops Auto Review; any other keeps today's path. */
export function reviewerError(message: string): boolean {
  return /review|approval/i.test(message);
}

/** Settles the mode pill on Default and says why; the error itself is already shown. */
export function downgradeEvents(): AgentEvent[] {
  return [
    { kind: "mode", mode: "default", ack: true },
    { kind: "notice", text: "Auto Review Unavailable, Back To Default", level: "warn" },
  ];
}
