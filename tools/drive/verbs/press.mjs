// press <ref|selector>: real mouse press at the target's centre (sandbox only), with the hit report.
// context (right button, fires contextmenu) and dblclick (clickCount 1 then 2, fires dblclick) share the same path.
import { pressTarget, drainExternal } from "../drive-input.mjs";

const mouse = (usage, kind) => async (ctx) => {
  if (!ctx.a1) throw new Error(`usage: ${usage} <ref|selector>`);
  const out = await pressTarget(ctx, ctx.a1, kind);
  const external = await drainExternal(ctx);
  return external.length ? { ...out, external } : out;
};

export const press = mouse("press", "click");
export const context = mouse("context", "context");
export const dblclick = mouse("dblclick", "double");
