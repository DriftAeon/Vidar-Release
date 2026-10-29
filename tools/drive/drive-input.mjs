// Explorer hands: CDP input helpers (centre-point mouse press, key combos, hit report), the
// attested-sandbox gate for real input, the no-press list, the explorer-mode allowlist and the
// VIDAR_DRIVE_TURNS cap. The verbs (verbs/press.mjs, key.mjs, act.mjs) are thin callers.
import { stateFile, readState, writeState } from "./run-log.mjs";

export { appendRunLog, logVerb } from "./run-log.mjs";

/** A refusal exits 2 (vidar-drive.mjs reads exitCode). */
export class Refusal extends Error {
  constructor(message) { super(message); this.exitCode = 2; }
}

export const EXPLORER_VERBS = ["state", "snapshot", "read", "act", "press", "key", "paste", "send", "shot", "look", "console", "finding"];

/** @returns {string|null} the refusal message, or null to proceed. Counts a `send` against VIDAR_DRIVE_TURNS. */
export function explorerRefusal(cmd, env, port) {
  if (env.VIDAR_DRIVE_EXPLORER === "1" && !EXPLORER_VERBS.includes(cmd)) return `refused in explorer mode: ${cmd}`;
  return cmd === "send" ? takeTurn(env, port) : null;
}

/** Counts one send on this port; refuses past VIDAR_DRIVE_TURNS. @returns {string|null} */
export function takeTurn(env, port) {
  const cap = Number(env.VIDAR_DRIVE_TURNS);
  if (!Number.isInteger(cap) || cap < 1) return null;
  const file = stateFile(env, `turns-${port}.json`);
  const used = readState(file, { sends: 0 }).sends ?? 0;
  if (used >= cap) return `refused: turn cap ${cap} reached`;
  writeState(file, { sends: used + 1 });
  return null;
}

// Matched on the target's role, name and a few DOM facts; any match refuses the press with exit 2.
export const NO_PRESS = [
  { id: "window-control", name: /^(close|minimi[sz]e|maximi[sz]e|restore)( window)?$/i, inCaption: true },
  { id: "window-control-named", name: /\b(close|minimi[sz]e|maximi[sz]e) window\b/i },
  { id: "quit", name: /^(quit|exit)( vidar)?$/i },
  { id: "restart", name: /^restart\b/i },
  { id: "swap", name: /\bswap\b/i },
  // Whole class tokens only: \b also hit the shared decision pair (swap-yes / swap-no, decision-pair.css) that the Runes,
  // Flow and Settings confirms use. The real swap UI (button, RMB menu, confirm with its Yes/No) is refused by container.
  { id: "swap-class", cls: /(^|\s)(swap|restart|quit)(\s|$)/i },
  { id: "swap-ui", inSwapUi: true },
  { id: "relay-approve-deny", cls: /\brelay-(approve|deny)\b/ },
  { id: "relay-approve-deny-name", role: /^button$/i, name: /^(approve|deny)$/i, inRelay: true },
];

/** @param {{role?:string,name?:string,cls?:string,inCaption?:boolean,inRelay?:boolean,inSwapUi?:boolean}} d @returns {string|null} matcher id */
export function matchNoPress(d) {
  for (const m of NO_PRESS) {
    if (m.role && !m.role.test(d.role ?? "")) continue;
    if (m.name && !m.name.test(d.name ?? "")) continue;
    if (m.cls && !m.cls.test(d.cls ?? "")) continue;
    if (m.inCaption && !d.inCaption) continue;
    if (m.inRelay && !d.inRelay) continue;
    if (m.inSwapUi && !d.inSwapUi) continue;
    return m.id;
  }
  return null;
}

/** Real input runs only in the card sandbox: devCards.preConnect plus the root attestation (the same pair `card`/`answer` use). */
export async function gateRealInput(ctx) {
  const no = (why) => new Refusal(`refused: real input needs the attested sandbox${why ? `\n(${why})` : ""}`);
  const load = ctx.loadDevCards ?? (() => import(new URL("../sandbox/dev-cards.mjs", import.meta.url).href));
  let dc;
  try { dc = await load(); } catch (e) { throw no(`sandbox module unavailable: ${e?.message ?? e}`); }
  const pre = dc.preConnect({ port: ctx.PORT });
  if (!pre.ok) throw no(pre.reason);
  const r = await dc.attest(pre.appRoot, (js, ms) => ctx.evalJs(js, ms));
  if (!r.ok) throw no(r.reason);
  await installExternalGuard(ctx); // sandbox only: past the attestation, never on a live-window port
}

/** IPC commands that leave the app (browser, file manager, editor, native dialogs, login console, screen overlay). */
export const EXTERNAL_COMMANDS = ["open_url", "open_in_browser", "open_folder", "open_document", "open_in_editor", "pick_folder", "claude_login_run", "ocr_begin", "update_cli", "release_build_start", "swap_start", "falcon_show"];

/**
 * Page-side: wraps window.fetch. Tauri's invoke is a non-writable property, but its IPC is a fetch to http://ipc.localhost/<cmd>
 * (ipc://localhost/<cmd> elsewhere). A blocked call gets a 400 text/plain Response without the Tauri-Response header, so Tauri
 * routes it to the error callback and invoke rejects with the text; a rejected fetch would instead fall back to postMessage and run it.
 * Idempotent; re-installs when window.fetch is no longer the stored wrapper.
 */
export const externalGuardJs = () => `(() => {
  if (typeof window.fetch !== "function") return false;
  const g = (globalThis.__vidarExternalGuard ??= { blocked: [], wrapped: null });
  if (g.wrapped && window.fetch === g.wrapped) return true;
  const external = new Set(${JSON.stringify(EXTERNAL_COMMANDS)});
  const orig = window.fetch;
  const cmdOf = (u) => {
    const m = /^(?:https?:\\/\\/ipc\\.localhost|ipc:\\/\\/localhost)\\/([^?#]+)/.exec(u);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  };
  const bodyText = (b) => {
    if (b == null) return "";
    if (typeof b === "string") return b;
    try {
      if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
      if (ArrayBuffer.isView(b)) return new TextDecoder().decode(b);
    } catch {}
    return "[" + (b?.constructor?.name ?? typeof b) + "]";
  };
  g.wrapped = window.fetch = function (input, init) {
    let u = ""; try { u = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? ""); } catch {}
    const cmd = cmdOf(u);
    if (cmd === null || !external.has(cmd)) return orig.apply(this, arguments);
    g.blocked.push({ cmd, args: bodyText(init?.body).slice(0, 200), t: Date.now() });
    return Promise.resolve(new Response("blocked by sandbox driver: " + cmd, { status: 400, headers: { "Content-Type": "text/plain" } }));
  };
  return true;
})()`;

export const installExternalGuard = (ctx) => ctx.evalJs(externalGuardJs());

/** Drains the page list of blocked calls. @returns {{cmd:string,args:string}[]} */
export async function drainExternal(ctx) {
  const r = await ctx.evalJs(`(() => { const g = globalThis.__vidarExternalGuard; if (!g) return []; return g.blocked.splice(0).map(({ cmd, args }) => ({ cmd, args })); })()`);
  return Array.isArray(r) ? r : [];
}

// Page-side element description; role/name are a light approximation of the accessible ones.
const DESCRIBE_JS = `const D = (el) => {
  const tag = el.tagName.toLowerCase(), type = (el.getAttribute("type") || "").toLowerCase();
  const map = { button: "button", a: "link", select: "combobox", textarea: "textbox", summary: "button", img: "img" };
  const role = el.getAttribute("role") || (tag === "input" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button" }[type] || "textbox") : map[tag] || tag);
  const name = (el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80)
    || el.getAttribute("alt") || el.getAttribute("placeholder") || "");
  return { role, name, cls: typeof el.className === "string" ? el.className : "",
    inCaption: !!el.closest("#caption"), inRelay: !!el.closest('[class*="relay"]'),
    inSwapUi: !!el.closest("#swap-btn, #swap-menu, #swap-confirm") };
};`;

const trim = (d) => (d ? { role: d.role, name: d.name } : null);

/** Resolves a ref (`__vidarExplorer.byRef`) or CSS selector, scrolls it into view, hit-tests its centre. */
export function resolveJs(target) {
  return `(() => { ${DESCRIBE_JS}
  const t = ${JSON.stringify(target)}; const isRef = /^e\\d+$/.test(t); let el = null;
  if (isRef) el = globalThis.__vidarExplorer?.byRef?.get(t)?.deref() ?? null;
  else el = document.querySelector(t);
  if (!el || !el.isConnected) return { found: false, stale: isRef };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect(); const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  return { found: true, at: { x, y }, ...D(el), hit: { ok: !!hit && r.width > 0 && r.height > 0 && (hit === el || el.contains(hit)), at: { x, y }, got: hit ? D(hit) : null } };
})()`;
}

export const focusedJs = () => `(() => { ${DESCRIBE_JS} const el = document.activeElement; return el && el !== document.body ? D(el) : null; })()`;

/** Real mouse press at the target's centre. @returns {{target?, hit:{ok,at,got}, pressed:boolean}} */
export async function pressTarget(ctx, target) {
  await gateRealInput(ctx);
  const r = await ctx.evalJs(resolveJs(target));
  if (r?.stale) throw new Refusal(`stale ref: ${target} (take a fresh snapshot)`);
  if (!r?.found) throw new Error(`press: no match for ${target}`);
  for (const d of [r, r.hit.got]) {
    const id = d && matchNoPress(d);
    if (id) throw new Refusal(`refused: ${id} is on the no-press list (${r.role} "${r.name}")`);
  }
  const hit = { ok: r.hit.ok, at: r.hit.at, got: trim(r.hit.got) };
  const out = { hit, pressed: false };
  out.target = /^e\d+$/.test(target)
    ? { ref: target, locator: { role: r.role, name: r.name, nth: 0 } }
    : { selector: target };
  if (!hit.ok) return out; // a miss would click whatever sits there; report it instead
  const { x, y } = r.at;
  await ctx.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await ctx.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await ctx.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  out.pressed = true;
  return out;
}

const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, win: 4, shift: 8 };
const NAMED = {
  enter: ["Enter", "Enter", 13, "\r"], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  tab: ["Tab", "Tab", 9], space: [" ", "Space", 32, " "], backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46],
  arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

/** "Ctrl+Shift+K" → {key, code, vk, modifiers, text?}; throws on an unknown key. */
export function parseCombo(combo) {
  const parts = String(combo).split("+").map((p) => p.trim());
  if (String(combo).endsWith("++")) parts.splice(-2, 2, "+"); // "Ctrl++"
  const keyPart = parts.pop();
  if (!keyPart) throw new Error(`key: cannot parse combo "${combo}"`);
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`key: unknown modifier "${m}" in "${combo}"`);
    modifiers |= bit;
  }
  const named = NAMED[keyPart.toLowerCase()];
  let key, code, vk, text;
  if (named) [key, code, vk, text] = named;
  else if (/^[a-z]$/i.test(keyPart)) {
    key = modifiers & 8 ? keyPart.toUpperCase() : keyPart.toLowerCase(); code = `Key${keyPart.toUpperCase()}`; vk = keyPart.toUpperCase().charCodeAt(0); text = key;
  } else if (/^\d$/.test(keyPart)) { key = keyPart; code = `Digit${keyPart}`; vk = keyPart.charCodeAt(0); text = key; }
  else if (keyPart.length === 1) { key = keyPart; code = ""; vk = keyPart.toUpperCase().charCodeAt(0); text = key; }
  else throw new Error(`key: unknown key "${keyPart}" in "${combo}"`);
  if (modifiers & (1 | 2 | 4)) text = undefined; // a shortcut types nothing
  return { key, code, vk, modifiers, ...(text ? { text } : {}) };
}

/** Dispatches the combo, then reports the focused element. @returns {{key, focus}} */
export async function pressKey(ctx, combo) {
  await gateRealInput(ctx);
  const c = parseCombo(combo);
  if (c.key === "Enter" || c.key === " ") {
    const f = await ctx.evalJs(focusedJs());
    const id = f && matchNoPress(f);
    if (id) throw new Refusal(`refused: ${id} is on the no-press list (focused ${f.role} "${f.name}")`);
  }
  const base = { key: c.key, code: c.code, windowsVirtualKeyCode: c.vk, nativeVirtualKeyCode: c.vk, modifiers: c.modifiers };
  await ctx.send("Input.dispatchKeyEvent", { ...base, type: c.text ? "keyDown" : "rawKeyDown", ...(c.text ? { text: c.text } : {}) });
  await ctx.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  const f = await ctx.evalJs(focusedJs());
  return { key: combo, focus: trim(f) };
}

/** Page-side quiet wait: installs a MutationObserver now; waitJs resolves after `quiet` ms without a mutation, capped. */
export const SETTLE_CAP_MS = 8000;
export const SETTLE_QUIET_MS = 300;
export const settleStartJs = () => `(() => { const s = (window.__vidarSettle = { last: performance.now() });
  s.obs?.disconnect?.(); s.obs = new MutationObserver(() => { s.last = performance.now(); });
  s.obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); return true; })()`;
export const settleWaitJs = (quiet) => `new Promise((res) => { const s = window.__vidarSettle, t0 = performance.now();
  const tick = () => { const now = performance.now(); if (now - s.last >= ${Number(quiet)} || now - t0 >= ${SETTLE_CAP_MS}) { s.obs.disconnect(); res(now - t0 >= ${SETTLE_CAP_MS}); } else setTimeout(tick, 50); };
  tick(); })`;
