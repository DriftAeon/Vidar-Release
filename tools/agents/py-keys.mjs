// Python agent-key scanner. Lexes Python (strings incl. triple-quoted, raw,
// bytes and f-strings whose literal parts are keys and whose `{...}` parts are code; comments and docstring
// statements skipped), then reports every token whose words name an agent id. Context per key: condition
// (`if`/`elif`/`while` heads, ternary and comprehension `if`, `==` `!=` `in` `is` `and` `or` `not` operands),
// negation (`!=`, `not in`, `is not`, `not`), fallback (`else:` body, ternary `else`, `case _:` body).
// Nothing is forced. Item = enclosing `def` / `class` by indent, else the file stem.
//   scan(files, ctx) -> [{file, line, tok, cls, base, anchor, n, forced, tier, ids, ctx}]   (files are {path, src})
import { anchor, classOf, idsIn, tierOf, useIds } from "./key-words.mjs";

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const P3 = new Set(["**=", "//=", ">>=", "<<=", "..."]);
const P2 = new Set(["==", "!=", "<=", ">=", "->", ":=", "**", "//", "<<", ">>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@="]);
const KW = new Set(["if", "elif", "else", "while", "and", "or", "not", "in", "is", "return", "yield", "assert", "lambda", "for", "await", "del", "raise", "print"]);
const COND = 1, NEG = 2, FB = 4;

/** Tokens {t: str|name|num|punct, v, text, line, ls (first of its logical line), li (that line's indent), sid}. */
export function lex(src, line0 = 1, parent = null) {
  const toks = [], len = src.length;
  let line = line0, depth = 0, lineStart = 0, atStart = !parent, li = parent?.li ?? 0, sid = 0, i = 0;
  const add = (t, v, text, ln, x = {}) => {
    toks.push({ t, v, text, line: ln, ls: atStart && !parent, li, ...x });
    atStart = false;
  };
  const strEnd = (q, triple, from) => {
    let j = from;
    while (j < len) {
      if (src[j] === "\\") { j += 2; continue; }
      if (triple ? src.startsWith(q.repeat(3), j) : src[j] === q) break;
      if (!triple && src[j] === "\n") break;
      j++;
    }
    return j;
  };
  while (i < len) {
    const c = src[i];
    if (c === "\n") {
      line++; i++; lineStart = i;
      if (depth === 0 && !parent) atStart = true;
      continue;
    }
    if (c === "\\" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) { i += src[i + 1] === "\n" ? 2 : 3; line++; lineStart = i; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") { i++; continue; }
    if (c === "#") { while (i < len && src[i] !== "\n") i++; continue; }
    if (atStart && !parent && depth === 0) li = i - lineStart;
    const ln = line;
    const sm = /^([rRbBuUfF]{0,2})(["'])/.exec(src.slice(i, i + 4));
    if (sm && (sm[1] === "" || /[A-Za-z]/.test(c))) {
      const prefix = sm[1].toLowerCase(), q = sm[2];
      const triple = src.startsWith(q.repeat(3), i + prefix.length);
      const bs = i + prefix.length + (triple ? 3 : 1);
      const be = strEnd(q, triple, bs);
      const end = Math.min(be + (triple ? 3 : 1), len);
      const body = src.slice(bs, be);
      const id = ++sid;
      if (prefix.includes("f")) {
        let lit = "", litLn = ln, cur = ln, k = 0;
        const flush = () => { if (lit) add("str", lit, `${q}${lit}${q}`, litLn, { sid: id }); lit = ""; };
        while (k < body.length) {
          const ch = body[k];
          if (ch === "{" && body[k + 1] === "{") { if (!lit) litLn = cur; lit += "{"; k += 2; continue; }
          if (ch === "}" && body[k + 1] === "}") { if (!lit) litLn = cur; lit += "}"; k += 2; continue; }
          if (ch === "{") {
            let d = 0, e = k;
            for (; e < body.length; e++) { if (body[e] === "{") d++; else if (body[e] === "}" && --d === 0) break; }
            flush();
            const inner = lex(body.slice(k + 1, e), cur, { li });
            for (const t of inner) toks.push({ ...t, ls: false, li, sid: id });
            for (let z = k; z <= e; z++) if (body[z] === "\n") cur++;
            k = e + 1; continue;
          }
          if (ch === "\n") cur++;
          if (!lit) litLn = cur;
          lit += ch; k++;
        }
        flush();
        atStart = false;
      } else add("str", body, src.slice(i, end), ln, { sid: id });
      for (let z = i; z < end; z++) if (src[z] === "\n") { line++; lineStart = z + 1; }
      i = end; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_]/.test(src[j])) j++;
      add("name", src.slice(i, j), src.slice(i, j), ln); i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < len && /[0-9A-Za-z_.]/.test(src[j])) j++;
      add("num", src.slice(i, j), src.slice(i, j), ln); i = j; continue;
    }
    const p3 = src.slice(i, i + 3), p2 = src.slice(i, i + 2);
    const p = P3.has(p3) ? p3 : P2.has(p2) ? p2 : c;
    if (OPEN.has(p)) depth++;
    else if (CLOSE.has(p)) depth = Math.max(0, depth - 1);
    add("punct", p, p, ln); i += p.length;
  }
  // Docstring statements (a lone string on its logical line) are doc comments: dropped.
  const out = [];
  for (let k = 0; k < toks.length; ) {
    const t = toks[k];
    if (t.t === "str" && t.ls && !parent) {
      let e = k;
      while (toks[e + 1]?.sid === t.sid) e++;
      if (!toks[e + 1] || toks[e + 1].ls) { k = e + 1; continue; }
    }
    out.push(t); k++;
  }
  return out;
}

const isP = (t, v) => t?.t === "punct" && t.v === v;
const isN = (t, v) => t?.t === "name" && t.v === v;
const isOpen = (t) => t?.t === "punct" && OPEN.has(t.v);
const isClose = (t) => t?.t === "punct" && CLOSE.has(t.v);

function mates(toks) {
  const m = new Int32Array(toks.length).fill(-1);
  const st = [];
  toks.forEach((t, i) => {
    if (t.t !== "punct") return;
    if (OPEN.has(t.v)) st.push(i);
    else if (CLOSE.has(t.v)) { const o = st.pop(); if (o !== undefined) { m[o] = i; m[i] = o; } }
  });
  return m;
}

function flags(toks, m) {
  const n = toks.length, fl = new Uint8Array(n);
  const mark = (a, b, bit) => { for (let q = Math.max(a, 0); q <= Math.min(b, n - 1); q++) fl[q] |= bit; };
  const right = (k) => {
    let e = k + 1;
    while (toks[e] && (isN(toks[e], "not") || isP(toks[e], "-") || isP(toks[e], "~"))) e++;
    if (!toks[e]) return k;
    if (isOpen(toks[e]) && m[e] >= 0) e = m[e];
    for (;;) {
      const a = toks[e + 1];
      if (isP(a, ".") && toks[e + 2]) e += 2;
      else if (isOpen(a) && m[e + 1] >= 0 && !a.ls) e = m[e + 1];
      else break;
    }
    return e;
  };
  const left = (k) => {
    let s = k - 1;
    for (;;) {
      if (isClose(toks[s]) && m[s] >= 0) s = m[s];
      if (isOpen(toks[s]) && s > 0 && !toks[s].ls && ((toks[s - 1].t === "name" && !KW.has(toks[s - 1].v)) || isClose(toks[s - 1]))) { s--; continue; }
      if (isP(toks[s - 1], ".") && s >= 2) { s -= 2; continue; }
      return Math.max(s, 0);
    }
  };
  // Tokens after k up to a depth-0 stop (closing bracket, comma, new logical line, or a name in `stops`).
  const span = (k, stops) => {
    let e = k + 1;
    while (e < n && !toks[e].ls && !isClose(toks[e]) && !isP(toks[e], ",") && !(toks[e].t === "name" && stops.includes(toks[e].v))) e = isOpen(toks[e]) && m[e] >= 0 ? m[e] + 1 : e + 1;
    return e - 1;
  };
  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.t === "punct") {
      if (t.v === "==" || t.v === "!=") {
        const bit = COND | (t.v === "!=" ? NEG : 0);
        mark(left(k), k - 1, bit); mark(k + 1, right(k), bit);
      }
      continue;
    }
    if (t.t !== "name") continue;
    const v = t.v;
    if ((v === "if" || v === "elif" || v === "while") && t.ls) {
      let e = k + 1;
      while (e < n && !isP(toks[e], ":") && !(toks[e].ls)) e = isOpen(toks[e]) && m[e] >= 0 ? m[e] + 1 : e + 1;
      mark(k + 1, e - 1, COND);
    } else if (v === "if" && !t.ls) {
      const e = span(k, ["else"]);
      mark(k + 1, e, COND);
      if (isN(toks[e + 1], "else")) mark(e + 2, span(e + 1, []), FB);
    } else if (v === "else" && t.ls && isP(toks[k + 1], ":")) {
      for (let q = k + 2; q < n && toks[q].li > t.li || (q < n && toks[q].line === t.line); q++) fl[q] |= FB;
    } else if (v === "case" && t.ls && isN(toks[k + 1], "_") && isP(toks[k + 2], ":")) {
      for (let q = k + 3; q < n && (toks[q].li > t.li || toks[q].line === t.line); q++) fl[q] |= FB;
    } else if (v === "in" || v === "is") {
      const neg = (v === "in" && isN(toks[k - 1], "not")) || (v === "is" && isN(toks[k + 1], "not"));
      const bit = COND | (neg ? NEG : 0);
      const op = v === "in" && isN(toks[k - 1], "not") ? k - 1 : k;
      const rs = v === "is" && isN(toks[k + 1], "not") ? k + 1 : k;
      mark(left(op), op - 1, bit); mark(rs + 1, right(rs), bit);
    } else if (v === "and" || v === "or") {
      mark(left(k), k - 1, COND); mark(k + 1, right(k), COND);
    } else if (v === "not" && !isN(toks[k - 1], "is") && !(isN(toks[k + 1], "in"))) {
      mark(k + 1, right(k), COND | NEG);
    }
  }
  return fl;
}

function nameMap(toks, stem) {
  const names = new Array(toks.length).fill(stem);
  const stack = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.ls) {
      while (stack.length && stack[stack.length - 1].li >= t.li) stack.pop();
      const d = isN(t, "async") ? toks[k + 1] : t;
      const nameTok = d === t ? toks[k + 1] : toks[k + 2];
      if ((isN(d, "def") || isN(d, "class")) && nameTok?.t === "name") stack.push({ li: t.li, name: nameTok.v });
    }
    if (stack.length) names[k] = stack[stack.length - 1].name;
  }
  return names;
}

function scanFile(path, src) {
  const toks = lex(src), m = mates(toks);
  const fl = flags(toks, m);
  const stem = path.split("/").pop().replace(/\.[^.]+$/, "");
  const names = nameMap(toks, stem);
  const tier = tierOf(path);
  const out = [];
  const push = (k, tok, kind) => {
    const c = { kind, condition: !!(fl[k] & COND), negated: !!(fl[k] & NEG), fallbackArm: !!(fl[k] & FB), forcedArm: false, wild: false, mergesNone: false };
    const cls = classOf(tok, c);
    if (cls === "none") return;
    out.push({ file: path, line: toks[k].line, tok, cls, base: cls, anchor: anchor(toks, k, names[k]), forced: false, tier, ids: idsIn(tok), ctx: c });
  };
  toks.forEach((t, k) => {
    if (t.t === "str") push(k, t.v, "literal");
    else if (t.t === "name") push(k, t.v, "ident");
  });
  const count = new Map();
  for (const e of out) count.set(e.anchor, (count.get(e.anchor) ?? 0) + 1);
  for (const e of out) e.n = count.get(e.anchor);
  return out;
}

export function scan(files, ctx = {}) {
  if (ctx.ids) useIds(ctx.ids);
  return files.flatMap((f) => scanFile(f.path, f.src ?? ""));
}
