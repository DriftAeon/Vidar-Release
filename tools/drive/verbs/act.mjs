// act <press|key|paste|send> <target> [<text>] [--settle ms]: one input, a DOM-quiet wait, then
// {hit, delta, console}. send/paste take their text as the third positional (paste: literal text only).
// Console holds only error entries new since the previous act on this port (cursor in the run state dir).
import { pressTarget, pressKey, gateRealInput, drainExternal, takeTurn, Refusal, settleStartJs, settleWaitJs, SETTLE_QUIET_MS, SETTLE_CAP_MS } from "../drive-input.mjs";
import { stateFile, readState, writeState } from "../run-log.mjs";
import { send as sendVerb, paste as pasteVerb } from "./rendered.mjs";
import { consoleSinceLoad } from "./console.mjs";
import { snapshot as realSnapshot } from "./snapshot.mjs";

const ACTIONS = ["press", "key", "paste", "send"];

async function newConsoleErrors(ctx, env) {
  const all = (await (ctx.consoleVerb ?? consoleSinceLoad)(ctx)).messages.filter((m) => m.level === "error");
  const file = stateFile(env, `console-${ctx.PORT}.json`);
  let cursor = readState(file, { seen: 0 }).seen ?? 0;
  if (cursor > all.length) cursor = 0; // the page reloaded; its store restarted
  writeState(file, { seen: all.length });
  return all.slice(cursor);
}

export async function act(ctx) {
  const env = ctx.env ?? process.env;
  const [verb, target] = [ctx.a1, ctx.a2];
  const third = ctx.cardOpts && !String(ctx.cardOpts).startsWith("--") ? ctx.cardOpts : undefined;
  if (!ACTIONS.includes(verb) || target === undefined) throw new Error("usage: act <press|key|paste|send> <target> [<text>] [--settle ms]");
  if ((verb === "send" || verb === "paste") && third === undefined) throw new Error(`usage: act ${verb} <target> <text>`);
  const quiet = ctx.flags?.settle && ctx.flags.settle !== true ? Number(ctx.flags.settle) : SETTLE_QUIET_MS;
  if (!Number.isFinite(quiet) || quiet < 0) throw new Error("act: --settle needs milliseconds");

  let input;
  if (verb === "send") {
    const refusal = takeTurn(env, ctx.PORT);
    if (refusal) throw new Refusal(refusal);
  }
  if (verb === "press" || verb === "key") await gateRealInput(ctx); // before any eval on an unattested window
  await ctx.evalJs(settleStartJs());
  if (verb === "press") input = await pressTarget(ctx, target);
  else if (verb === "key") input = await pressKey(ctx, target);
  else if (verb === "send") input = await sendVerb({ ...ctx, a1: target, a2: third });
  else input = await pasteVerb({ ...ctx, a1: target, pasteArg: { text: third } });
  const capped = await ctx.evalJs(settleWaitJs(quiet), SETTLE_CAP_MS + 4000);
  const external = verb === "press" || verb === "key" ? await drainExternal(ctx) : [];

  let delta = null, deltaError;
  try { delta = await (ctx.snapshotFn ?? realSnapshot)(ctx, { delta: true }); } catch (e) { deltaError = String(e.message ?? e); }
  const out = { hit: input?.hit ?? null, delta, console: await newConsoleErrors(ctx, env) };
  if (deltaError) out.deltaError = deltaError;
  if (capped) out.settleCapped = true;
  if (external.length) out.external = external;
  if (input?.target) out.target = input.target;
  if (verb !== "press") out.input = input;
  return out;
}
