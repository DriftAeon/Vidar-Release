// select <ref|name> <option label>: sets a native <select> by visible option label (sandbox only) and fires the
// input and change events a user pick would. The target is a snapshot ref (e<n>) or an accessible name / label.
import { gateRealInput, Refusal } from "../drive-input.mjs";

const REF = /^e\d+$/;

/** Page-side: resolve the select, find the option by label, set it, fire input then change. */
export function selectJs(target, label) {
  return `(() => {
  const t = ${JSON.stringify(target)}, want = ${JSON.stringify(label)};
  const norm = (s) => String(s ?? "").trim().replace(/\\s+/g, " ").toLowerCase();
  const isRef = /^e\\d+$/.test(t);
  let el = null;
  if (isRef) {
    el = globalThis.__vidarExplorer?.byRef?.get(t)?.deref() ?? null;
    if (!el || !el.isConnected) return { found: false, stale: true };
  } else {
    const names = (s) => {
      const out = [s.getAttribute("aria-label"), s.getAttribute("title")];
      const by = s.getAttribute("aria-labelledby");
      if (by) out.push(by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
      for (const l of s.labels ?? []) out.push(l.textContent);
      return out.filter(Boolean).map(norm);
    };
    const all = [...document.querySelectorAll("select, [role='combobox'], [role='listbox']")].filter((s) => s.isConnected);
    const hits = all.filter((s) => names(s).includes(norm(t)));
    if (hits.length > 1) return { found: true, ambiguous: hits.length };
    el = hits[0] ?? null;
    if (!el) return { found: false, stale: false };
  }
  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute("aria-label") || el.getAttribute("title") || "";
  if (tag !== "select") return { found: true, notSelect: true, tag, name };
  const opts = [...el.options].map((o) => ({ o, label: (o.label || o.textContent || "").trim().replace(/\\s+/g, " ") }));
  const labels = opts.map((x) => x.label);
  const pick = opts.find((x) => x.label === want) ?? opts.find((x) => norm(x.label) === norm(want));
  if (!pick) return { found: true, noOption: true, labels };
  if (pick.o.disabled) return { found: true, disabledOption: true, label: pick.label };
  el.value = pick.o.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true, set: true, value: el.value, label: pick.label, selected: el.selectedOptions[0]?.label ?? pick.label, name };
})()`;
}

export async function select(ctx) {
  if (!ctx.a1 || ctx.a2 === undefined) throw new Error("usage: select <ref|name> <option label>");
  await gateRealInput(ctx);
  const r = await ctx.evalJs(selectJs(ctx.a1, ctx.a2));
  if (r?.stale && REF.test(ctx.a1)) {
    throw new Refusal(`stale ref: ${ctx.a1} (take a fresh snapshot)`);
  }
  if (!r?.found) throw new Error(`select: no select matches "${ctx.a1}"`);
  if (r.ambiguous) throw new Error(`select: "${ctx.a1}" matches ${r.ambiguous} controls (use a ref from a snapshot)`);
  if (r.notSelect) throw new Error(`select: "${ctx.a1}" is a ${r.tag}, not a native select`);
  if (r.noOption) throw new Error(`select: no option "${ctx.a2}"; available: ${r.labels.map((l) => JSON.stringify(l)).join(", ")}`);
  if (r.disabledOption) throw new Error(`select: option "${r.label}" is disabled`);
  const target = REF.test(ctx.a1) ? { ref: ctx.a1, locator: { role: "combobox", name: r.name, nth: 0 } } : undefined;
  return { selected: r.label, value: r.value, ...(target ? { target } : {}) };
}
