// Pure launch/body classification; gateway routing must survive any body choice.
import { canRenderAgent } from "../../launcher/agent-kind";
import type { LaunchOpts, SessionAgent, SessionBody } from "./types";

export function resolveBodyKind(opts: LaunchOpts | undefined): { kind: SessionAgent; body: SessionBody } {
  // Adoption attaches to a process Falcon already owns: Codex when the adopter says so
  // (launcher/hosted.ts adoptHosted, gate on), else Claude.
  const kind = opts?.falconSession ? (opts.agent === "codex" ? "codex" : "claude") : (opts?.agent ?? "shell");
  const body: SessionBody = opts?.falconSession
    ? "rendered"
    : opts?.body === "rendered" && canRenderAgent(kind, opts.art) ? "rendered" : "terminal";
  return { kind, body };
}
