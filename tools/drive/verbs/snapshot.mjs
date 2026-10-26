// Load the page reader from disk: the drive's eval argv path is capped at 32K.
import fs from "node:fs";

const reader = fs.readFileSync(new URL("../snapshot-reader.mjs", import.meta.url), "utf8")
  .replace(/^export /gm, "");

export async function snapshot(ctx, { delta = true } = {}) {
  const expression = `(() => { ${reader}\nreturn pageSnapshot(${JSON.stringify(ctx.PORT)}, ${delta}); })()`;
  return ctx.evalJs(expression);
}

export function snapshotVerb(ctx) {
  if (ctx.a1 !== undefined && ctx.a1 !== "--full") {
    throw Object.assign(new Error("usage: snapshot [--full]"), { exitCode: 2 });
  }
  return snapshot(ctx, { delta: ctx.a1 !== "--full" });
}
