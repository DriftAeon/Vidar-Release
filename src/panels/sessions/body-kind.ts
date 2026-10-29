// Pure launch/body classification; gateway routing must survive any body choice.
// @ts-ignore TS5097: the .ts specifier lets node --test load this file without a bundler
import { isAgentId } from "../../agents/id.ts";
import { canRenderAgent } from "../../launcher/agent-kind";
import type { LaunchOpts, SessionAgent, SessionBody } from "./types";

export function resolveBodyKind(opts: LaunchOpts | undefined): { kind: SessionAgent; body: SessionBody } {
  // Adoption attaches to a process Falcon already owns: Codex when the adopter says so
  // (launcher/hosted.ts adoptHosted, gate on), else Claude.
  const kind = opts?.falconSession ? (isAgentId(opts.agent) ? opts.agent : "claude") : (opts?.agent ?? "shell");
  const body: SessionBody = opts?.falconSession
    ? "rendered"
    : opts?.body === "rendered" && canRenderAgent(kind, opts.art) ? "rendered" : "terminal";
  return { kind, body };
}
