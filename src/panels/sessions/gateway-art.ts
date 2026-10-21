// A Claude tab's art says which gateway it runs under. The ids come from the module registry
// (agent.gateway), never a table here; an art the registry does not know fails closed.
import { gatewayModuleRows } from "../../modules/registry";

/** A gateway module id, validated against the registry. */
export type GatewayId = string;

export type ClaudeArt =
  | { kind: "plain" }
  | { kind: "gateway"; id: GatewayId }
  /** Not plain Claude and not a loaded gateway (module removed, or not loaded yet). */
  | { kind: "unknown" };

/** Pure: classify an art against a set of gateway ids. */
export function classifyClaudeArt(art: string | undefined, gateways: ReadonlySet<string>): ClaudeArt {
  if (!art || art === "claude") return { kind: "plain" };
  return gateways.has(art) ? { kind: "gateway", id: art } : { kind: "unknown" };
}

/** Ids of the present agent modules that declare a gateway (an unmet `when` still counts, as in
 *  the launcher); empty before load. */
export function gatewayIds(): Set<string> {
  return new Set(gatewayModuleRows().map((m) => m.id));
}

export const claudeArt = (art: string | undefined): ClaudeArt => classifyClaudeArt(art, gatewayIds());

/** /clear may treat the tab as plain Claude only when the art is plain. */
export const mayActAsPlainClaude = (art: string | undefined): boolean => claudeArt(art).kind === "plain";
