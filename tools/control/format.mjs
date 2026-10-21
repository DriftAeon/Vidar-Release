// tools\control\format.mjs — one line out (every reply <= 200
// bytes except `state`, which lists every tab).

import { EXIT } from "./client.mjs";

/** Prints `reply.line` (already `err <reason>` on a refusal) and returns the
 *  process exit code: 0 if `reply.ok`, else 1. */
export function printReply(reply) {
  process.stdout.write(`${reply.line}\n`);
  return reply.ok ? EXIT.OK : EXIT.ERR;
}
