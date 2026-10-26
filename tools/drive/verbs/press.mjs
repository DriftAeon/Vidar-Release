// press <ref|selector>: real mouse press at the target's centre (sandbox only), with the hit report.
import { pressTarget, drainExternal } from "../drive-input.mjs";

export async function press(ctx) {
  if (!ctx.a1) throw new Error("usage: press <ref|selector>");
  const out = await pressTarget(ctx, ctx.a1);
  const external = await drainExternal(ctx);
  return external.length ? { ...out, external } : out;
}
