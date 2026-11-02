// fill <ref|name> <text>: sets a text <input> or <textarea> through the native value setter (so framework listeners
// see it), then fires input and change. Sandbox only (same gate as `press`). Returns the act payload {hit, delta, console}.
// Refuses password, file and other non-text inputs, read-only or disabled fields, and anything inside the terminal.
import { gateRealInput, Refusal, settleStartJs, settleWaitJs, SETTLE_QUIET_MS, SETTLE_CAP_MS } from "../drive-input.mjs";
import { newConsoleErrors } from "./act.mjs";
import { snapshot as realSnapshot } from "./snapshot.mjs";

const REF = /^e\d+$/;
export const TEXT_TYPES = ["", "text", "search", "email", "url", "tel", "number"];

/** Page-side: resolve by ref or accessible name, vet the element, set the value, fire input then change. */
export function fillJs(target, text) {
  return `(() => {
  const t = ${JSON.stringify(target)}, text = ${JSON.stringify(text)}, TYPES = ${JSON.stringify(TEXT_TYPES)};
  const norm = (s) => String(s ?? "").trim().replace(/\\s+/g, " ").toLowerCase();
  let el = null;
  if (/^e\\d+$/.test(t)) {
    el = globalThis.__vidarExplorer?.byRef?.get(t)?.deref() ?? null;
    if (!el || !el.isConnected) return { found: false, stale: true };
  } else {
    const names = (s) => {
      const out = [s.getAttribute("aria-label"), s.getAttribute("title"), s.getAttribute("placeholder")];
      const by = s.getAttribute("aria-labelledby");
      if (by) out.push(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
      for (const l of s.labels ?? []) out.push(l.textContent);
      return out.filter(Boolean).map(norm);
    };
    const hits = [...document.querySelectorAll("input, textarea")].filter((s) => s.isConnected && names(s).includes(norm(t)));
    if (hits.length > 1) return { found: true, ambiguous: hits.length };
    el = hits[0] ?? null;
    if (!el) return { found: false, stale: false };
  }
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const name = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
  if (el.closest(".xterm, [data-terminal], #terminal")) return { found: true, refuse: "terminal", tag, name };
  if (tag === "input" && type === "password") return { found: true, refuse: "password", tag, name };
  if (tag !== "input" && tag !== "textarea") return { found: true, refuse: "non-text", tag, name };
  if (tag === "input" && !TYPES.includes(type)) return { found: true, refuse: "non-text", tag: "input[type=" + type + "]", name };
  if (el.disabled || el.readOnly) return { found: true, refuse: "locked", tag, name };
  el.scrollIntoView?.({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect(); const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  el.focus();
  const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true, set: true, value: el.value, name, tag,
    hit: { ok: !!top && (top === el || el.contains(top)), at: { x, y }, got: top ? { role: top.getAttribute("role") || top.tagName.toLowerCase(), name: (top.getAttribute("aria-label") || "").slice(0, 80) } : null } };
})()`;
}

export async function fill(ctx) {
  if (!ctx.a1 || ctx.a2 === undefined) throw new Error("usage: fill <ref|name> <text>");
  await gateRealInput(ctx);
  const env = ctx.env ?? process.env;
  const quiet = ctx.flags?.settle && ctx.flags.settle !== true ? Number(ctx.flags.settle) : SETTLE_QUIET_MS;
  if (!Number.isFinite(quiet) || quiet < 0) throw new Error("fill: --settle needs milliseconds");
  await ctx.evalJs(settleStartJs());
  const r = await ctx.evalJs(fillJs(ctx.a1, String(ctx.a2)));
  if (r?.stale && REF.test(ctx.a1)) throw new Refusal(`stale ref: ${ctx.a1} (take a fresh snapshot)`);
  if (!r?.found) throw new Error(`fill: no text field matches "${ctx.a1}"`);
  if (r.ambiguous) throw new Error(`fill: "${ctx.a1}" matches ${r.ambiguous} fields (use a ref from a snapshot)`);
  if (r.refuse === "terminal") throw new Refusal(`refused: fill never types into the terminal (${r.tag} "${r.name}")`);
  if (r.refuse === "password") throw new Refusal(`refused: fill never types into a password field ("${r.name}")`);
  if (r.refuse === "non-text") throw new Refusal(`refused: fill sets text fields only; ${r.tag} "${r.name}" is not one`);
  if (r.refuse === "locked") throw new Refusal(`refused: field "${r.name}" is disabled or read-only`);
  const capped = await ctx.evalJs(settleWaitJs(quiet), SETTLE_CAP_MS + 4000);
  let delta = null, deltaError;
  try { delta = await (ctx.snapshotFn ?? realSnapshot)(ctx, { delta: true }); } catch (e) { deltaError = String(e.message ?? e); }
  const out = { hit: r.hit ?? null, delta, console: await newConsoleErrors(ctx, env) };
  if (deltaError) out.deltaError = deltaError;
  if (capped) out.settleCapped = true;
  if (REF.test(ctx.a1)) out.target = { ref: ctx.a1, locator: { role: "textbox", name: r.name, nth: 0 } };
  out.input = { filled: true, value: r.value };
  return out;
}
