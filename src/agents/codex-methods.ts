// Codex app-server method tables (pinned from the 0.163.0 schema): the
// notifications Vidar knows and fallback answers for server requests
// (contracts/codex-server-requests.json). Data only; the Codex request handler reads them.
// Refresh tools/codex-schema/manifest.json with refresh.mjs; the hermetic
// tests/codex-schema-drift.test.mjs gates coverage and refusal response shapes.
import serverRequests from "../../contracts/codex-server-requests.json" with { type: "json" };

type Json = Record<string, unknown>;

/** Every notification method the 0.163.0 experimental schema names. Known-but-unused ones
 *  become quiet notices; anything else is `unknown` (the drift alarm). */
export const KNOWN_NOTIFICATIONS = new Set([
  "error", "thread/started", "thread/status/changed", "thread/archived", "thread/deleted", "thread/unarchived",
  "thread/closed", "thread/reverted", "thread/readState/changed", "skills/changed", "thread/name/updated", "thread/attachment/updated",
  "thread/prediction/updated", "thread/goal/updated",
  "thread/goal/cleared", "thread/queue/changed", "project/changed", "thread/project/updated",
  "thread/environment/connected", "thread/environment/disconnected", "thread/settings/updated",
  "thread/tokenUsage/updated", "turn/started", "hook/started", "turn/completed", "hook/completed",
  "turn/diff/updated", "turn/plan/updated", "item/started", "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed", "autoApprovalReview/strictReviewRequired", "item/completed",
  "item/agentMessage/delta", "item/plan/delta", "command/exec/outputDelta", "process/outputDelta",
  "process/exited", "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "serverRequest/resolved",
  "item/mcpToolCall/progress", "mcpServer/oauthLogin/completed", "mcpServer/startupStatus/updated",
  "mcpServer/event/stream/notification", "account/updated", "account/gatewayOAuth/changed",
  "account/rateLimits/updated", "app/list/updated",
  "remoteControl/status/changed", "externalAgentConfig/import/progress", "externalAgentConfig/import/completed",
  "fs/changed", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "thread/compacted", "model/rerouted", "model/verification", "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted", "turn/moderationMetadata", "model/safetyBuffering/updated", "warning",
  "guardianWarning", "deprecationNotice", "configWarning", "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted", "thread/realtime/started", "thread/realtime/itemAdded",
  "thread/realtime/item/started", "thread/realtime/item/transcript/delta", "thread/realtime/item/completed",
  "thread/realtime/transcript/delta", "thread/realtime/transcript/done", "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp", "thread/realtime/error", "thread/realtime/closed", "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted", "account/login/completed",
]);

export type Disposition = "card" | "refuse" | "error";
interface RequestEntry { disposition: Disposition; refusal?: Json }

/** The shared server-request disposition table, read by Falcon-hosted Codex too
 *  (src-falcon codex/driver/requests.rs). Legacy v1 ReviewDecision's denied
 *  variant requires a rejection object in 0.162.1. */
export const SERVER_REQUESTS = serverRequests.requests as Record<string, RequestEntry>;
/** The JSON-RPC error for an `error` or unknown server request; `{method}` is the method. */
export const UNSUPPORTED = serverRequests.unsupported as { code: number; message: string };

/** Fallback refusals for server → client requests (card methods with a refusal
 *  fall back to it when not drawn), derived from the table. */
export const REFUSALS: Record<string, Json | "rpc-error"> = Object.fromEntries(
  Object.entries(SERVER_REQUESTS).flatMap(([method, entry]): [string, Json | "rpc-error"][] =>
    entry.disposition === "error" ? [[method, "rpc-error"]] : entry.refusal ? [[method, entry.refusal]] : []),
);
