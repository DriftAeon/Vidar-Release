#!/usr/bin/env node
// tools\control\client.mjs — identity plus one bus round trip for `ctl.<verb>`
// Exit codes: 0 ok, 1 err
// <reason> (Vidar's own refusal), 2 timeout, 3 bus unavailable, 4 no token in
// env (not a Vidar tab).

import { connect, BusTimeoutError } from "../bus/bus-client.mjs";

export const EXIT = { OK: 0, ERR: 1, TIMEOUT: 2, BUS_UNAVAILABLE: 3, NO_TOKEN: 4 };

/** `{ token }` for a PTY tab (`VIDAR_CTL_TOKEN`, minted and registered in
 *  pty.rs, scrubbed from Falcon spawns), else `{ falcon_session, secret }`
 *  for a Falcon-hosted tab (`FALCON_SESSION`, plus `VIDAR_CTL_SECRET` when
 *  Falcon exported one; a session without it sends no `secret`), else null —
 *  the caller is not a Vidar tab at all. */
export function identity() {
  const token = process.env.VIDAR_CTL_TOKEN;
  if (token) return { token };
  const session = process.env.FALCON_SESSION;
  if (!session) return null;
  const secret = process.env.VIDAR_CTL_SECRET;
  return secret ? { falcon_session: session, secret } : { falcon_session: session };
}

function fail(exitCode, message) {
  const err = new Error(message);
  err.exitCode = exitCode;
  throw err;
}

/** `act`-class verbs park behind an approval card a human has to answer
 *  (`control\card.rs`, `CARD_TTL` 280 s); the default 30 s client timeout is
 *  shorter than that, so a card left open would time out the client before
 *  it could ever be answered. The table is here so a client
 *  calling `prompt`/`spawn`/`ask` never has to know the value. */
const VERB_TIMEOUT_MS = { prompt: 300_000, spawn: 300_000, ask: 300_000 };

/** One `ctl.<verb>` request; the promise rejects with `.exitCode` set so
 *  `vidar.mjs` has one catch site. Resolves to Vidar's `{ ok, line }`. */
export async function request(verb, args = {}, { timeoutMs = VERB_TIMEOUT_MS[verb] ?? 30_000 } = {}) {
  const id = identity();
  if (!id) fail(EXIT.NO_TOKEN, "no token in env — not a Vidar tab");

  let client;
  try {
    client = await connect(`vidar.mjs ${verb}`);
  } catch (error) {
    fail(EXIT.BUS_UNAVAILABLE, error.message);
  }
  try {
    // Identity last: no payload key (`token`, `falcon_session`, `secret`) can overwrite it.
    return await client.request(`ctl.${verb}`, { ...args, ...id }, { timeoutMs });
  } catch (error) {
    fail(error instanceof BusTimeoutError ? EXIT.TIMEOUT : EXIT.BUS_UNAVAILABLE, error.message);
  } finally {
    client.close();
  }
}
