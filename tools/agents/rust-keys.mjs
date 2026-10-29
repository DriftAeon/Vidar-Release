// Rust agent-key scanner. Lexes Rust (strings, raw and byte strings, chars vs
// lifetimes, comments and doc comments skipped, attribute strings kept), drops test items (`cfg(test)`,
// `cfg(all(test, ..))`, `#[test]`; `cfg(not(test))` is product), then reports every token whose words name an
// agent id. Context per key: match arm (forced when the pattern is listed-enum variants, no guard, and the match has
// no `_`/binding catch-all and no arm merging `None`), condition position, negation, fallback arm.
//   scan(files, ctx) -> [{file, line, tok, cls, base, anchor, n, forced, tier, ids, ctx}]
//   enumsOf(files, ctx) -> Map<enumName, variants[]> for enums with an id-named variant (the fixture's $enums)
// files are {path, src}; ctx is {ids, enums}.
import { anchor, classOf, idsIn, isIdWord, tierOf, useIds, words } from "./key-words.mjs";

const P2 = new Set(["::", "==", "!=", "=>", "->", "<=", ">=", "..", "&&", "||"]);
const isP = (t, v) => t?.t === "punct" && t.v === v;
const isI = (t, v) => t?.t === "ident" && t.v === v;
const isOpen = (t) => t?.t === "punct" && (t.v === "(" || t.v === "[" || t.v === "{");

/** Tokens {t: str|char|life|ident|punct|num, v, text, line}. */
export function lex(src) {
  const toks = [];
  const len = src.length;
  let line = 1;
  const nl = (a, b) => { for (let k = a; k < b; k++) if (src.charCodeAt(k) === 10) line++; };
  const add = (t, v, from, to, ln) => toks.push({ t, v, text: src.slice(from, to), line: ln });
  const str = (q) => {
    let j = q + 1;
    while (j < len && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    return { v: src.slice(q + 1, j), end: Math.min(j + 1, len) };
  };
  const char = (q, from, ln) => {
    if (src[q + 1] === "\\") {
      const e = src.indexOf("'", q + 3);
      const end = e < 0 ? len : e + 1;
      add("char", "", from, end, ln);
      return end;
    }
    const L = String.fromCodePoint(src.codePointAt(q + 1) ?? 32).length;
    if (src[q + 1 + L] === "'") { add("char", "", from, q + L + 2, ln); return q + L + 2; }
    let j = q + 1;
    while (j < len && /[A-Za-z0-9_]/.test(src[j])) j++;
    add("life", src.slice(q + 1, j), from, Math.max(j, q + 1), ln);
    return Math.max(j, q + 1);
  };
  for (let i = 0; i < len; ) {
    const c = src[i], n = src[i + 1], ln = line;
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && n === "/") { while (i < len && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") {
      let d = 1, j = i + 2;
      while (j < len && d > 0) {
        if (src[j] === "/" && src[j + 1] === "*") { d++; j += 2; }
        else if (src[j] === "*" && src[j + 1] === "/") { d--; j += 2; }
        else j++;
      }
      nl(i, j); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_]/.test(src[j])) j++;
      const id = src.slice(i, j);
      if (id === "r" || id === "br" || id === "cr") {
        let h = 0;
        while (src[j + h] === "#") h++;
        if (src[j + h] === '"') {
          const close = '"' + "#".repeat(h);
          const e = src.indexOf(close, j + h + 1);
          const end = e < 0 ? len : e + close.length;
          add("str", src.slice(j + h + 1, e < 0 ? len : e), i, end, ln);
          nl(i, end); i = end; continue;
        }
      } else if ((id === "b" || id === "c") && src[j] === '"') {
        const s = str(j);
        add("str", s.v, i, s.end, ln); nl(i, s.end); i = s.end; continue;
      } else if (id === "b" && src[j] === "'") { i = char(j, i, ln); continue; }
      add("ident", id, i, j, ln); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < len && /[0-9A-Za-z_]/.test(src[j])) j++;
      add("num", src.slice(i, j), i, j, ln); i = j; continue;
    }
    if (c === '"') { const s = str(i); add("str", s.v, i, s.end, ln); nl(i, s.end); i = s.end; continue; }
    if (c === "'") { i = char(i, i, ln); continue; }
    if (P2.has(c + (n ?? ""))) { add("punct", c + n, i, i + 2, ln); i += 2; continue; }
    add("punct", c, i, i + 1, ln); i++;
  }
  return toks;
}

function mates(toks) {
  const m = new Int32Array(toks.length).fill(-1);
  const st = [];
  toks.forEach((t, i) => {
    if (t.t !== "punct") return;
    if (t.v === "(" || t.v === "[" || t.v === "{") st.push(i);
    else if (t.v === ")" || t.v === "]" || t.v === "}") { const o = st.pop(); if (o !== undefined) { m[o] = i; m[i] = o; } }
  });
  return m;
}

function skipItem(toks, m, k) {
  while (k < toks.length) {
    const t = toks[k];
    if (isOpen(t) && m[k] >= 0) { if (t.v === "{") return isP(toks[m[k] + 1], ";") ? m[k] + 2 : m[k] + 1; k = m[k] + 1; continue; }
    if (isP(t, ";")) return k + 1;
    k++;
  }
  return k;
}

function cfgPos(toks, k) {
  const t = toks[k];
  if (t?.t !== "ident") return [false, k + 1];
  let j = k + 1;
  if (isP(toks[j], "(")) {
    const args = [];
    j++;
    while (j < toks.length && !isP(toks[j], ")")) {
      if (isP(toks[j], ",")) { j++; continue; }
      const [v, nj] = cfgPos(toks, j);
      args.push(v); j = nj;
    }
    return [t.v === "all" ? args.some(Boolean) : t.v === "any" ? args.length > 0 && args.every(Boolean) : false, j + 1];
  }
  if (isP(toks[j], "=")) return [false, j + 2];
  return [t.v === "test", j];
}

/** Does the attribute starting at `#` (index k) make its item test-only? Returns the index past `]`, or 0. */
function testAttr(toks, m, k) {
  if (!isP(toks[k], "#") || !isP(toks[k + 1], "[") || m[k + 1] < 0) return -1;
  const end = m[k + 1];
  let pos = false;
  if (isI(toks[k + 2], "cfg") && isP(toks[k + 3], "(")) pos = cfgPos(toks, k + 4)[0];
  else if (isI(toks[end - 1], "test") && !isP(toks[end - 2], "=")) pos = toks.slice(k + 2, end).every((t) => t.t === "ident" || isP(t, "::"));
  return pos ? end + 1 : -end - 1;
}

/** Drop test items: the attribute and the item after it. */
export function stripTests(toks) {
  const m = mates(toks);
  const out = [];
  for (let k = 0; k < toks.length; ) {
    const e = testAttr(toks, m, k);
    if (e > 0) {
      let j = e;
      while (isP(toks[j], "#") && isP(toks[j + 1], "[") && m[j + 1] > 0) j = m[j + 1] + 1;
      k = skipItem(toks, m, j);
      continue;
    }
    out.push(toks[k++]);
  }
  return out;
}

const ITEM_KW = new Set(["fn", "impl", "struct", "enum", "trait", "mod", "const", "static", "type"]);

function implName(toks, k) {
  let cur = "", ang = 0;
  for (let j = k + 1; j < toks.length; j++) {
    const t = toks[j];
    if (isP(t, "{") || isP(t, ";") || isI(t, "where")) break;
    if (isP(t, "<")) ang++;
    else if (isP(t, ">")) ang = Math.max(0, ang - 1);
    else if (ang === 0 && t.t === "ident") cur = t.v === "for" ? "" : t.v;
  }
  return cur || "impl";
}

function items(toks, m) {
  const n = toks.length, spans = [];
  const prevOk = (k) => {
    const p = toks[k - 1];
    if (!p || p.t === "str") return true;
    if (p.t === "punct") return [";", "{", "}", "]", ")"].includes(p.v);
    return p.t === "ident" && ["pub", "unsafe", "async", "extern", "default", "const"].includes(p.v);
  };
  for (let k = 0; k < n; k++) {
    const t = toks[k], nx = toks[k + 1];
    if (t.t !== "ident" || !ITEM_KW.has(t.v) || !prevOk(k)) continue;
    if ((t.v === "const" || t.v === "static") && nx?.t === "ident" && ["fn", "unsafe", "async", "extern"].includes(nx.v)) continue;
    if (t.v !== "impl" && nx?.t !== "ident") continue;
    let j = k + 1, end = n - 1, open = -1;
    while (j < n) {
      const x = toks[j];
      if (isP(x, "{")) { open = j; end = m[j] >= 0 ? m[j] : n - 1; break; }
      if (isP(x, ";")) { end = j; break; }
      j = isOpen(x) && x.v !== "{" && m[j] >= 0 ? m[j] + 1 : j + 1;
    }
    spans.push({ kind: t.v, name: t.v === "impl" ? implName(toks, k) : nx.v, start: k, end, open });
  }
  return spans;
}

function nameMaps(spans, n) {
  const names = new Array(n).fill(""), impls = new Array(n).fill("");
  const st = [];
  let si = 0;
  for (let i = 0; i < n; i++) {
    while (st.length && st[st.length - 1].end < i) st.pop();
    while (si < spans.length && spans[si].start === i) st.push(spans[si++]);
    const top = st[st.length - 1];
    if (!top) continue;
    const up = st[st.length - 2];
    names[i] = top.kind === "fn" && up && (up.kind === "impl" || up.kind === "trait") ? `${up.name}::${top.name}` : top.name;
    for (let s = st.length - 1; s >= 0; s--) if (st[s].kind === "impl") { impls[i] = st[s].name; break; }
  }
  return { names, impls };
}

const idNamed = (v) => { const w = words(v); return w.length === 1 && isIdWord(w[0]); };

/** Enums with an id-named variant, across the given files (test code excluded). */
export function enumsOf(files) {
  const out = new Map();
  for (const f of files) {
    const toks = stripTests(lex(f.src));
    const m = mates(toks);
    for (const sp of items(toks, m)) {
      if (sp.kind !== "enum" || sp.open < 0) continue;
      const vs = [];
      for (let j = sp.open + 1; j < sp.end; j++) {
        if (isP(toks[j], "#") && isP(toks[j + 1], "[") && m[j + 1] > 0) { j = m[j + 1]; continue; }
        if (toks[j].t !== "ident") continue;
        vs.push(toks[j].v);
        while (j < sp.end && !isP(toks[j], ",")) { if (isOpen(toks[j]) && m[j] >= 0) j = m[j]; j++; }
      }
      if (vs.some(idNamed)) out.set(sp.name, [...new Set([...(out.get(sp.name) ?? []), ...vs])]);
    }
  }
  return out;
}

const COND = 1, NEG = 2, FB = 4, FORCED = 8, WILD = 16, MERGE = 32;

function skipAngle(toks, k) {
  let d = 0;
  for (; k < toks.length; k++) {
    if (isP(toks[k], "<")) d++;
    else if (isP(toks[k], ">") && --d === 0) return k + 1;
  }
  return k;
}

const hasKey = (toks, idxs) => idxs.some((i) => (toks[i].t === "ident" || toks[i].t === "str") && words(toks[i].v).some(isIdWord));

/** Arms of one `match` (open = index of its `{`): [{ps, pe, g, bs, be}]. */
function armsOf(toks, m, open) {
  const close = m[open], arms = [];
  let s = open + 1;
  while (s < close) {
    while (isP(toks[s], "#") && isP(toks[s + 1], "[") && m[s + 1] > 0) s = m[s + 1] + 1;
    let p = s, g = -1;
    while (p < close && !isP(toks[p], "=>")) {
      if (isI(toks[p], "if") && g < 0) g = p;
      p = isOpen(toks[p]) && m[p] >= 0 ? m[p] + 1 : p + 1;
    }
    if (p >= close) break;
    const b = p + 1;
    if (isP(toks[b], "{") && m[b] >= 0) {
      arms.push({ ps: s, pe: p, g, bs: b, be: m[b] });
      s = m[b] + 1 + (isP(toks[m[b] + 1], ",") ? 1 : 0);
      continue;
    }
    let e = b;
    while (e < close && !isP(toks[e], ",")) {
      if (isOpen(toks[e]) && m[e] >= 0) e = m[e] + 1;
      else if (isP(toks[e], "::") && isP(toks[e + 1], "<")) e = skipAngle(toks, e + 1);
      else e++;
    }
    arms.push({ ps: s, pe: p, g, bs: b, be: e - 1 });
    s = e + 1;
  }
  return arms;
}

function altsOf(toks, m, a) {
  const end = a.g < 0 ? a.pe : a.g;
  const alts = [];
  let cur = [];
  for (let q = a.ps; q < end; q++) {
    if (isP(toks[q], "|")) { alts.push(cur); cur = []; continue; }
    if (isOpen(toks[q]) && m[q] >= 0) { for (let r = q; r <= m[q]; r++) cur.push(r); q = m[q]; continue; }
    cur.push(q);
  }
  alts.push(cur);
  return alts.filter((x) => x.length);
}

const LOWER = (t) => t.t === "ident" && /^[a-z_]/.test(t.v) && !["true", "false", "ref", "mut"].includes(t.v);

function altKind(toks, m, idxs, enums, selfName) {
  const ts = idxs.map((i) => toks[i]);
  const bare = ts.filter((t) => !isI(t, "ref") && !isI(t, "mut"));
  if (bare.length === 1 && LOWER(bare[0])) return "catch";
  if (ts.length >= 2 && LOWER(ts[0]) && isP(ts[1], "@")) return "catch";
  if (ts.length === 1 && isI(ts[0], "None")) return "none";
  const path = [];
  let j = 0;
  while (ts[j]?.t === "ident") { path.push(ts[j].v); if (isP(ts[j + 1], "::")) j += 2; else { j++; break; } }
  const group = j >= idxs.length || (isOpen(toks[idxs[j]]) && m[idxs[j]] === idxs[idxs.length - 1]);
  if (!path.length || !group) return "other";
  const V = path[path.length - 1];
  let Q = path[path.length - 2];
  if (Q === "Self") Q = selfName;
  const listed = Q ? (enums.get(Q) ?? []).includes(V) : /^[A-Z]/.test(V) && !["Some", "Ok", "Err", "None"].includes(V) && [...enums.values()].some((vs) => vs.includes(V));
  return listed ? "var" : "other";
}

function flagMatches(toks, m, fl, enums, impls) {
  for (let k = 0; k < toks.length; k++) {
    if (!isI(toks[k], "match") || isP(toks[k - 1], ".") || isP(toks[k - 1], "::") || isP(toks[k + 1], "!")) continue;
    let j = k + 1;
    while (j < toks.length && !isP(toks[j], "{")) j = isOpen(toks[j]) && m[j] >= 0 ? m[j] + 1 : j + 1;
    if (j >= toks.length || m[j] < 0) continue;
    const arms = armsOf(toks, m, j).map((a) => {
      const alts = altsOf(toks, m, a).map((x) => ({ x, k: altKind(toks, m, x, enums, impls[k]) }));
      alts.forEach((al) => { al.key = hasKey(toks, al.x); });
      const merges = alts.some((al) => al.k === "none") && alts.some((al) => al.key);
      return { ...a, alts, catchAll: alts.some((al) => al.k === "catch"), merges };
    });
    const hasCatch = arms.some((a) => a.catchAll), anyMerge = arms.some((a) => a.merges);
    const enumMatch = arms.some((a) => a.alts.some((al) => al.k === "var"));
    for (const a of arms) {
      const forced = a.g < 0 && a.alts.length > 0 && a.alts.every((al) => al.k === "var") && !hasCatch && !anyMerge;
      for (let q = a.ps; q < (a.g < 0 ? a.pe : a.g); q++) fl[q] |= (forced ? FORCED : 0) | (enumMatch && hasCatch ? WILD : 0) | (a.merges ? MERGE : 0);
      if (a.g >= 0) for (let q = a.g; q < a.pe; q++) fl[q] |= COND;
      if (a.catchAll) for (let q = a.bs; q <= a.be; q++) fl[q] |= FB;
    }
  }
}

function flagContext(toks, m, fl) {
  const n = toks.length;
  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.t !== "ident") continue;
    if (isP(toks[k - 1], ".")) {
      if (/^(unwrap_or|unwrap_or_else|map_or|map_or_else)$/.test(t.v) && isP(toks[k + 1], "(") && m[k + 1] > 0) for (let q = k + 2; q < m[k + 1]; q++) fl[q] |= FB;
      continue;
    }
    if (isP(toks[k - 1], "::")) continue;
    if (t.v === "if" || t.v === "while") {
      let j = k + 1;
      while (j < n && !isP(toks[j], "{")) { fl[j] |= COND; j = isOpen(toks[j]) && m[j] >= 0 ? m[j] + 1 : j + 1; }
    } else if (t.v === "else" && isP(toks[k + 1], "{") && m[k + 1] > 0) {
      for (let q = k + 2; q < m[k + 1]; q++) fl[q] |= FB;
    } else if (t.v === "matches" && isP(toks[k + 1], "!") && isP(toks[k + 2], "(") && m[k + 2] > 0) {
      const neg = isP(toks[k - 1], "!");
      for (let q = k + 3; q < m[k + 2]; q++) fl[q] |= COND | (neg ? NEG : 0);
    }
  }
  for (let p = 0; p < n; p++) {
    if (isP(toks[p], "(") && isP(toks[p - 1], "!") && toks[p - 2]?.t !== "ident" && m[p] > 0) for (let q = p + 1; q < m[p]; q++) fl[q] |= NEG;
  }
}

const endsOperand = (t) => !!t && (t.t === "str" || t.t === "num" || t.t === "char" || (t.t === "ident" && !["return", "in", "if", "while", "else", "match", "let", "mut"].includes(t.v)) || (t.t === "punct" && [")", "]", "?"].includes(t.v)));
const BOOL = ["is_some", "is_none", "is_ok", "is_err"];

/** Condition / negation around the dotted chain holding token k (R2). */
function chainCtx(toks, m, k) {
  let s = k;
  while (s >= 2 && (isP(toks[s - 1], ".") || isP(toks[s - 1], "::")) && toks[s - 2].t === "ident") s -= 2;
  let e = k;
  for (;;) {
    const a = toks[e + 1];
    if ((isP(a, "(") || isP(a, "[")) && m[e + 1] >= 0) e = m[e + 1];
    else if ((isP(a, ".") || isP(a, "::")) && toks[e + 2]?.t === "ident") e += 2;
    else if (isP(a, "?")) e++;
    else break;
  }
  const prev = toks[s - 1], next = toks[e + 1];
  const binop = (t, before) => (isP(t, "&&") || isP(t, "||")) && endsOperand(before);
  let condition = binop(prev, toks[s - 2]) || (isP(next, "&&") || isP(next, "||"));
  for (let q = k; q <= e; q++) if (toks[q].t === "ident" && BOOL.includes(toks[q].v) && isP(toks[q - 1], ".")) condition = true;
  return { condition, negated: isP(prev, "!=") || isP(prev, "!") || isP(next, "!=") };
}

function scanFile(path, src, ctx) {
  const toks = stripTests(lex(src));
  const n = toks.length, m = mates(toks);
  const spans = items(toks, m);
  const { names, impls } = nameMaps(spans, n);
  const enums = ctx.enums instanceof Map ? ctx.enums : new Map();
  const fl = new Uint8Array(n);
  flagContext(toks, m, fl);
  flagMatches(toks, m, fl, enums, impls);
  const base = tierOf(path);
  const table = path === "src-falcon/src/protocol.rs" ? spans.filter((s) => (s.kind === "enum" || s.kind === "impl") && s.name === "Agent") : [];
  const out = [];
  const push = (k, tok, kind, extra = {}) => {
    const c = { kind, ...chainCtx(toks, m, k), ...extra };
    c.condition = c.condition || !!(fl[k] & COND);
    c.negated = c.negated || !!(fl[k] & NEG);
    c.fallbackArm = !!(fl[k] & FB);
    c.forcedArm = !!(fl[k] & FORCED);
    c.wild = !!(fl[k] & WILD);
    c.mergesNone = !!(fl[k] & MERGE);
    const cls = classOf(tok, c);
    if (cls === "none") return;
    const tier = table.some((s) => k >= s.start && k <= s.end) ? "table" : base;
    out.push({ file: path, line: toks[k].line, tok, cls, base: cls === "F" ? classOf(tok, { ...c, forcedArm: false }) : cls, anchor: anchor(toks, k, names[k] || "<file>"), forced: cls === "F", tier, ids: idsIn(tok), ctx: c });
  };
  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.t === "ident" && t.v === "AGENT_IDS" && isP(toks[k + 1], "[") && toks[k + 2]?.t === "num") push(k, `AGENT_IDS[${toks[k + 2].v}]`, "positional");
    else if (isI(t, "ALL") && isP(toks[k - 1], "::") && isI(toks[k - 2], "Agent") && isP(toks[k + 1], "[") && toks[k + 2]?.t === "num") push(k, `Agent::ALL[${toks[k + 2].v}]`, "positional");
    else if (t.t === "ident") push(k, t.v, "ident");
    else if (t.t === "str") {
      const re = isP(toks[k - 1], "(") && isI(toks[k - 2], "new") && isP(toks[k - 3], "::") && /^Regex/.test(toks[k - 4]?.v ?? "");
      push(k, t.v, re ? "regex" : "literal");
    }
  }
  const count = new Map();
  for (const e of out) count.set(e.anchor, (count.get(e.anchor) ?? 0) + 1);
  for (const e of out) e.n = count.get(e.anchor);
  return out;
}

export function scan(files, ctx = {}) {
  if (ctx.ids) useIds(ctx.ids);
  const list = files.map((f) => (typeof f === "string" ? { path: f, src: "" } : f));
  const c = ctx.enums instanceof Map ? ctx : { ...ctx, enums: enumsOf(list) };
  return list.flatMap((f) => scanFile(f.path, f.src, c));
}
