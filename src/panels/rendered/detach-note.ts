// A session adopted from a Jettison handoff is detached from Vidar: the control bus answers
// `err no requester`, and the context injected at SessionStart says nothing about it. The first
// prompt the shell sends carries this one line, once.

import type { AgentTransport } from "./transport";

export const DETACH_NOTE = "[Detached from Vidar: Relay and the control bus are unavailable here; ask with Ask cards in this thread.]";

/** `armed` false returns the transport untouched. Armed, the first user line sent (the wire form
 *  `{"type":"user","content":"..."}`) gets the note in front; the note is spent only once that
 *  send resolves, so a failed send leaves it for the retry. Control lines pass through. */
export function withDetachNote(transport: AgentTransport, armed: boolean): AgentTransport {
  if (!armed) return transport;
  let pending = true;
  return {
    ...transport,
    async send(tabId, gen, line) {
      if (!pending) return transport.send(tabId, gen, line);
      let out = line;
      try {
        const msg = JSON.parse(line);
        if (msg && msg.type === "user" && typeof msg.content === "string") out = JSON.stringify({ ...msg, content: `${DETACH_NOTE}\n${msg.content}` });
      } catch { return transport.send(tabId, gen, line); }
      await transport.send(tabId, gen, out);
      if (out !== line) pending = false;
    },
  };
}
