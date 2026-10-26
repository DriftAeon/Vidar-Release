// key <combo>: real key event (sandbox only), then the focused element's role and name.
import { pressKey, drainExternal } from "../drive-input.mjs";

export async function key(ctx) {
  if (!ctx.a1) throw new Error("usage: key <combo>  e.g. Enter, Ctrl+K, Shift+Tab");
  const out = await pressKey(ctx, ctx.a1);
  const external = await drainExternal(ctx);
  return external.length ? { ...out, external } : out;
}
