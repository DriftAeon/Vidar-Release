// The integration panels' IPC skeleton (Jira, Slack, Notion): a backend reply is `T | { error }`, and a
// rejected invoke becomes the same `{ error: { kind: "network" } }` shape so callers handle one path.
import { errText } from "./err-text";

export type NetworkError = { kind: "network"; message: string };

/** A rejected invoke as the panel's network error. */
export function networkError(e: unknown): NetworkError {
  return { kind: "network", message: errText(e) };
}

/** Runs one IPC call; a rejection resolves to `{ error: networkError }`, a reply passes through. */
export async function callOrNetwork<R>(run: () => Promise<R>): Promise<R | { error: NetworkError }> {
  try {
    return await run();
  } catch (e) {
    return { error: networkError(e) };
  }
}
