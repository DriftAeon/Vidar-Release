// Verb registry: verb name → handler(ctx) returning the value to print. ctx is built in
// vidar-drive.mjs (positionals a1/a2, flags, evalJs, send, ledger, …).
import { evalVerb, invoke, click, text, shot } from "./basic.mjs";
import { open, send, answer, state, shortcut, paste, card } from "./rendered.mjs";
import { consoleSinceLoad } from "./console.mjs";
import { closeSpawned, checkClean } from "./ledger.mjs";
import { press, context, dblclick } from "./press.mjs";
import { drag } from "./drag.mjs";
import { key } from "./key.mjs";
import { act } from "./act.mjs";
import { look } from "./look.mjs";
import { snapshotVerb } from "./snapshot.mjs";
import { read } from "./read.mjs";
import { finding } from "./finding.mjs";
import { select } from "./select.mjs";
import { fill } from "./fill.mjs";

export const verbs = Object.assign(Object.create(null), {
  eval: evalVerb,
  invoke,
  click,
  text,
  shot,
  open,
  send,
  answer,
  state,
  shortcut,
  paste,
  card,
  console: consoleSinceLoad,
  "close-spawned": closeSpawned,
  "check-clean": checkClean,
  snapshot: snapshotVerb,
  read,
  press,
  context,
  dblclick,
  drag,
  key,
  act,
  look,
  finding,
  select,
  fill,
});
