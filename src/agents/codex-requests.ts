// Codex server requests translated into approval/question events for the shared Rendered cards.
// Wire responses retain the request's IDs and permissions; a form cannot widen a grant.
import type { AgentEvent } from "./protocol";
import { REFUSALS } from "./codex-methods";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const keyOf = (id: unknown): string => `sr:${String(id)}`;
const enumValues = (schema: Json): unknown[] => {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((option) => obj(option).const);
  const items = obj(schema.items);
  if (Array.isArray(items.enum)) return items.enum;
  if (Array.isArray(items.anyOf)) return items.anyOf.map((option) => obj(option).const);
  return [];
};
const supportedElicitationField = (schema: Json): boolean => {
  const choices = enumValues(schema), itemSchema = obj(schema.items);
  const hasEnum = Array.isArray(schema.enum) || Array.isArray(schema.oneOf)
    || Array.isArray(itemSchema.enum) || Array.isArray(itemSchema.anyOf);
  if (schema.type === "array") return hasEnum && choices.length > 0 && choices.every((value) => typeof value === "string");
  if (!["string", "boolean", "integer", "number"].includes(str(schema.type))) return false;
  if (!hasEnum) return true;
  return choices.length > 0 && choices.every((value) => schema.type === "string"
    ? typeof value === "string" : schema.type === "boolean" ? false : typeof value === "number");
};
const supportedElicitationForm = (params: Json): boolean => {
  if (!["form", "openai/form", "openaiForm"].includes(str(params.mode))) return false;
  const schema = obj(params.requestedSchema), properties = obj(schema.properties);
  return schema.type === "object" && params.requestedSchema !== null && typeof params.requestedSchema === "object"
    && !Array.isArray(params.requestedSchema) && schema.properties !== null && typeof schema.properties === "object"
    && !Array.isArray(schema.properties)
    && arr(schema.required).every((field) => typeof field === "string" && Object.hasOwn(properties, field))
    && Object.values(properties).every((field) => supportedElicitationField(obj(field)));
};
const validElicitationValue = (schema: Json, value: unknown): boolean => {
  const choices = enumValues(schema);
  const itemSchema = obj(schema.items);
  const hasEnum = Array.isArray(schema.enum) || Array.isArray(schema.oneOf)
    || Array.isArray(itemSchema.enum) || Array.isArray(itemSchema.anyOf);
  if (hasEnum) {
    if (schema.type === "array") return Array.isArray(value) && value.length >= (typeof schema.minItems === "number" ? schema.minItems : 0)
      && value.length <= (typeof schema.maxItems === "number" ? schema.maxItems : Infinity)
      && value.every((item) => typeof item === "string" && choices.includes(item));
    return (schema.type === "string" ? typeof value === "string" : typeof value === "number") && choices.includes(value);
  }
  if (schema.type === "string") return typeof value === "string"
    && value.length >= (typeof schema.minLength === "number" ? schema.minLength : 0)
    && value.length <= (typeof schema.maxLength === "number" ? schema.maxLength : Infinity);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return typeof value === "number" && Number.isInteger(value)
    && value >= (typeof schema.minimum === "number" ? schema.minimum : -Infinity)
    && value <= (typeof schema.maximum === "number" ? schema.maximum : Infinity);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value)
    && value >= (typeof schema.minimum === "number" ? schema.minimum : -Infinity)
    && value <= (typeof schema.maximum === "number" ? schema.maximum : Infinity);
  return false;
};
const formContent = (params: Json, decision: Decision): Json | null => {
  if (decision.behavior !== "allow") return null;
  const mode = str(params.mode);
  if (!["form", "openai/form", "openaiForm"].includes(mode)) return null;
  if (!supportedElicitationForm(params)) return null;
  const updatedInput = obj(decision.updatedInput);
  if (!Object.hasOwn(updatedInput, "content") || !updatedInput.content || typeof updatedInput.content !== "object"
    || Array.isArray(updatedInput.content)) return null;
  const supplied = obj(updatedInput.content), schema = obj(params.requestedSchema), properties = obj(schema.properties);
  if (schema.type !== "object" || !params.requestedSchema || typeof params.requestedSchema !== "object"
    || Array.isArray(params.requestedSchema)) return null;
  const required = arr(schema.required).filter((field): field is string => typeof field === "string"), content: Json = {};
  if (!required.every((field) => Object.hasOwn(supplied, field))) return null;
  for (const [field, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(properties, field)) continue;
    if (!validElicitationValue(obj(properties[field]), value)) return null;
    content[field] = value;
  }
  return content;
};
type Decision = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message?: string };
/** Why an allowed form answer is refused (Falcon `answers.rs` FORM_MISFIT): sending a decline
 *  would tell the MCP server no while the user said yes, so nothing is sent and the card stays. */
export const FORM_MISFIT = "The form answer is missing a required field or has a value that does not fit; the card stays open.";

export class CodexRequests {
  private pending = new Map<string, { id: unknown; method: string; params: Json }>();
  private respond: (id: unknown, result: Json) => void;
  private error: (id: unknown, message: string) => void;
  constructor(respond: (id: unknown, result: Json) => void, error: (id: unknown, message: string) => void) {
    this.respond = respond;
    this.error = error;
  }

  request(m: Json, raw: string, changes: unknown[]): AgentEvent[] {
    const method = str(m.method), params = obj(m.params), key = keyOf(m.id);
    let tool: string, input: Json;
    switch (method) {
      case "item/tool/requestUserInput":
        tool = "AskUserQuestion";
        input = { questions: arr(params.questions) };
        break;
      case "item/permissions/requestApproval":
        tool = "Permissions";
        input = { permissions: params.permissions, cwd: params.cwd, reason: params.reason, scope: "turn" };
        break;
      case "mcpServer/elicitation/request":
        tool = "MCP Elicitation";
        input = Object.fromEntries(["serverName", "mode", "title", "description", "message", "url",
          "elicitationId", "challenge", "requestedSchema"].filter((field) => params[field] !== undefined)
          .map((field) => [field, params[field]]));
        if (params.mode === "openai/userVerification")
          input.unsupportedReason = "This request needs device verification proof, which Vidar cannot provide";
        else if (params.mode !== "url" && !supportedElicitationForm(params))
          input.unsupportedReason = "This form uses fields Vidar cannot collect";
        break;
      case "item/commandExecution/requestApproval":
        tool = "Command";
        input = { command: params.command ?? null, cwd: params.cwd ?? null };
        if (params.reason) input.reason = params.reason;
        if (params.proposedExecpolicyAmendment) input.proposedExecpolicyAmendment = params.proposedExecpolicyAmendment;
        break;
      case "item/fileChange/requestApproval":
        tool = "Edit";
        input = changes.length ? { changes } : { changes: [], note: "diff not received yet — the item's start notification has not arrived" };
        if (params.reason) input.reason = params.reason;
        if (params.grantRoot) input.grantRoot = params.grantRoot;
        break;
      default: {
        const refusal = REFUSALS[method];
        if (refusal === "rpc-error" || refusal === undefined) {
          this.error(m.id, `${method} is not supported by Vidar`);
          return refusal === undefined ? [{ kind: "unknown", type: `server-request:${method} (refused)`, raw }]
            : [{ kind: "notice", text: `Refused ${method} (not supported in Vidar)`, level: "warn" }];
        }
        this.respond(m.id, refusal);
        return [{ kind: "notice", text: `Declined ${method} (not drawn by Vidar yet)`, level: "warn" }];
      }
    }
    this.pending.set(key, { id: m.id, method, params });
    return [{ kind: "approval", requestId: key, toolUseId: str(params.itemId) || undefined,
      tool, input, inputBytes: raw.length, suggestions: [] }];
  }

  /** The reason `answer` would refuse this decision (an allowed supported form whose content
   *  does not fit), else null; the request stays pending for a corrected answer. */
  refusal(key: string, decision: Decision): string | null {
    const sr = this.pending.get(key);
    if (!sr || sr.method !== "mcpServer/elicitation/request" || decision.behavior !== "allow") return null;
    return supportedElicitationForm(sr.params) && formContent(sr.params, decision) === null ? FORM_MISFIT : null;
  }

  /** Answers the request; returns the refusal reason instead when the answer is refused. */
  answer(key: string, decision: Decision): string | null {
    const sr = this.pending.get(key);
    if (!sr) return null;
    const refused = this.refusal(key, decision);
    if (refused) return refused;
    let result: Json;
    if (sr.method === "item/tool/requestUserInput") {
      const answers: Json = {}, provided = obj(obj(decision.behavior === "allow" ? decision.updatedInput : null).answers);
      if (decision.behavior === "allow") for (const raw of arr(sr.params.questions)) {
        const q = obj(raw), id = str(q.id), answer = provided[id];
        // The shared single-select form returns a string. Do not split labels on commas.
        if (id && typeof answer === "string" && answer.trim()) answers[id] = { answers: [answer] };
      }
      result = { answers };
    } else if (sr.method === "item/permissions/requestApproval") {
      result = { permissions: decision.behavior === "allow" ? obj(sr.params.permissions) : {}, scope: "turn" };
    } else if (sr.method === "mcpServer/elicitation/request") {
      const content = formContent(sr.params, decision);
      const mode = str(sr.params.mode);
      const accepted = decision.behavior === "allow" && (mode === "url" || content !== null);
      result = accepted ? { action: "accept", ...(content ? { content } : {}) } : { action: "decline" };
    } else result = { decision: decision.behavior === "allow" ? "accept" : "decline" };
    this.pending.delete(key);
    this.respond(sr.id, result);
    return null;
  }

  resolved(id: unknown, reason: string): AgentEvent[] {
    const key = keyOf(id);
    return this.pending.delete(key) ? [{ kind: "approval_done", requestId: key, reason }] : [];
  }
  /** withdraws pending cards: those of one thread when `threadId` is given (a request
   *  without a threadId belongs to every thread), otherwise all of them */
  end(reason: string, threadId?: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [requestId, sr] of this.pending) {
      const owner = str(sr.params.threadId);
      if (threadId !== undefined && owner && owner !== threadId) continue;
      this.pending.delete(requestId);
      events.push({ kind: "approval_done", requestId, reason });
    }
    return events;
  }
}
