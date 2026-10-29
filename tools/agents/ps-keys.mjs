// PowerShell agent-key scanner. Lexes PowerShell (single and double
// strings with their `$var` / `$(...)` interpolations, here-strings, `$var` / `${var}`, barewords, parameters,
// operators; `#` and `<# #>` comments skipped), then reports every token whose words name an agent id.
// Context per key: condition (`if`/`elseif`/`while` heads, `-eq`-family and `-and`/`-or`/`-not`/`!` operands, ternary
// condition, switch case labels), negation (`-ne`, `-notin`, `-notcontains`, `-not`, `!`), fallback (`default {}`,
// `else {}`, right side of `??`). Nothing is forced. Item = enclosing `function` / `filter`, else the file stem.
//   scan(files, ctx) -> [{file, line, tok, cls, base, anchor, n, forced, tier, ids, ctx}]   (files are {path, src})
import { anchor, classOf, idsIn, tierOf, useIds } from "./key-words.mjs";

const OPRE = /^-[ic]?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|is|isnot|and|or|xor|not|replace|split|join)(?![\w-])/i;
const CMP = new Set(["eq", "ne", "gt", "ge", "lt", "le", "like", "notlike", "match", "notmatch", "contains", "notcontains", "in", "notin", "is", "isnot"]);
const NEGOP = new Set(["ne", "notlike", "notmatch", "notcontains", "notin", "isnot"]);
const LISTOP = new Set(["in", "notin", "contains", "notcontains"]);
const RX = new Set(["match", "notmatch", "replace", "split"]);
const STOP = /[\s;|&(){}[\],'"$@<>=!]/;
const OPEN = new Set(["(", "$(", "{", "["]);
const CLOSE = new Set([")", "}", "]"]);
const COND = 1, NEG = 2, FB = 4;

/** End index (past the `)`) of the sub-expression whose `(` is at `open`; quotes inside are skipped. */
function subEnd(s, open) {
  let d = 0;
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (c === "(") d++;
    else if (c === ")") { if (--d === 0) return k + 1; }
    else if (c === "'" || c === '"') {
      const q = c;
      k++;
      while (k < s.length && s[k] !== q) { if (q === '"' && s[k] === "`") k++; k++; }
    }
  }
  return s.length;
}

/** Tokens {t: str|var|word|param|op|punct, v, text, line, nl, att}; nl = first on its line, att = touches the previous token. */
export function lex(src, line0 = 1) {
  const toks = [], len = src.length;
  let line = line0, nl = false, last = -1, member = false, i = 0;
  const push = (t, v, text, ln, start, end, x = {}) => { toks.push({ t, v, text, line: ln, nl, att: start === last, ...x }); nl = false; last = end; };
  const cnt = (a, b) => { for (let k = a; k < b; k++) if (src.charCodeAt(k) === 10) line++; };
  const readWord = (from) => {
    let j = from;
    while (j < len) { const ch = src[j]; if (ch === "`") { j += 2; continue; } if (STOP.test(ch)) break; j++; }
    return Math.min(j, len);
  };
  // Double-quoted content [a, b): literal parts become str tokens, `$var` and `$(...)` become code tokens.
  const dq = (a, b, ln0, here) => {
    let lit = "", ln = ln0, litLn = ln0, j = a;
    const flush = () => { if (lit) toks.push({ t: "str", v: lit, text: `"${lit}"`, line: litLn, nl: false, att: false }); lit = ""; };
    const add = (ch) => { if (!lit) litLn = ln; lit += ch; };
    while (j < b) {
      const ch = src[j];
      if (ch === "`" && j + 1 < b) { if (src[j + 1] === "\n") ln++; add(src[j + 1]); j += 2; continue; }
      if (!here && ch === '"' && src[j + 1] === '"') { add('"'); j += 2; continue; }
      if (ch === "$") {
        if (src[j + 1] === "(") {
          const e = Math.min(subEnd(src, j + 1), b);
          flush();
          for (const t of lex(src.slice(j + 2, Math.max(j + 2, e - 1)), ln)) toks.push({ ...t, nl: false, att: false });
          for (let k = j; k < e; k++) if (src[k] === "\n") ln++;
          j = e; continue;
        }
        const re = /\$(?:\{([^}]*)\}|((?:\w+:)?\w+))/y;
        re.lastIndex = j;
        const m = re.exec(src);
        if (m && j + m[0].length <= b) {
          flush();
          toks.push({ t: "var", v: (m[1] ?? m[2]).replace(/^(?:env|script|global|local|private|using|variable):/i, ""), text: m[0], line: ln, nl: false, att: false });
          j += m[0].length; continue;
        }
      }
      if (ch === "\n") ln++;
      add(ch); j++;
    }
    flush();
  };
  while (i < len) {
    const c = src[i], n = src[i + 1], ln = line;
    const mem = member;
    member = false;
    if (c === "\n") { line++; nl = true; i++; continue; }
    if (c === "`" && (n === "\n" || (n === "\r" && src[i + 2] === "\n"))) { i += n === "\n" ? 2 : 3; line++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "#") { while (i < len && src[i] !== "\n") i++; continue; }
    if (c === "<" && n === "#") {
      const e = src.indexOf("#>", i + 2);
      const end = e < 0 ? len : e + 2;
      cnt(i, end); i = end; continue;
    }
    if (c === "@" && (n === "'" || n === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2, i + 40))) {
      const bs = src.indexOf("\n", i + 2) + 1;
      const term = "\n" + n + "@";
      const e = src.indexOf(term, bs - 1);
      let b = e < 0 ? len : e;
      if (src[b - 1] === "\r") b--;
      const end = e < 0 ? len : e + term.length;
      const bodyLine = ln + 1;
      if (n === "'") push("str", src.slice(bs, Math.max(bs, b)), src.slice(i, end), ln, i, end);
      else { dq(bs, Math.max(bs, b), bodyLine, true); if (toks.length && toks[toks.length - 1].line >= bodyLine) nl = false; last = end; }
      cnt(i, end); i = end; continue;
    }
    if (c === "'") {
      let j = i + 1, v = "";
      while (j < len) { if (src[j] === "'") { if (src[j + 1] === "'") { v += "'"; j += 2; continue; } break; } v += src[j]; j++; }
      const end = Math.min(j + 1, len);
      push("str", v, src.slice(i, end), ln, i, end); cnt(i, end); i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < len) {
        const ch = src[j];
        if (ch === "`") { j += 2; continue; }
        if (ch === '"') { if (src[j + 1] === '"') { j += 2; continue; } break; }
        if (ch === "$" && src[j + 1] === "(") { j = subEnd(src, j + 1); continue; }
        j++;
      }
      const end = Math.min(j + 1, len);
      const before = toks.length;
      const wasNl = nl;
      dq(i + 1, Math.min(j, len), ln, false);
      if (toks.length > before) { toks[before].nl = wasNl; nl = false; }
      last = end; cnt(i, end); i = end; continue;
    }
    if (c === "$") {
      if (n === "(") { push("punct", "$(", "$(", ln, i, i + 2); i += 2; continue; }
      const re = /\$(?:\{([^}]*)\}|((?:\w+:)?\w+)|([?^$]))/y;
      re.lastIndex = i;
      const m = re.exec(src);
      if (m) {
        push("var", (m[1] ?? m[2] ?? m[3]).replace(/^(?:env|script|global|local|private|using|variable):/i, ""), m[0], ln, i, i + m[0].length);
        i += m[0].length; continue;
      }
      push("punct", "$", "$", ln, i, i + 1); i++; continue;
    }
    const prev = toks[toks.length - 1];
    if (c === "." && last === i && prev && /[A-Za-z_'"$]/.test(n ?? "") &&
        (prev.t === "var" || prev.t === "str" || prev.member || (prev.t === "punct" && (prev.v === ")" || prev.v === "]")))) {
      push("punct", ".", ".", ln, i, i + 1); member = true; i++; continue;
    }
    if (c === ":" && n === ":") { push("punct", "::", "::", ln, i, i + 2); member = true; i += 2; continue; }
    if (mem && /[A-Za-z_]/.test(c)) {
      const mm = /\w+/y;
      mm.lastIndex = i;
      const w = mm.exec(src)[0];
      push("word", w, w, ln, i, i + w.length, { kind: "ident", member: true }); i += w.length; continue;
    }
    if (c === "-" && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      const om = OPRE.exec(src.slice(i, i + 16));
      if (om) { push("op", om[1].toLowerCase(), om[0], ln, i, i + om[0].length); i += om[0].length; continue; }
      if (/[A-Za-z-]/.test(n ?? "")) {
        const e = readWord(i);
        const w = src.slice(i, e).replace(/`/g, "");
        if (/^-[A-Za-z]\w*$/.test(w)) push("param", w.slice(1), w, ln, i, e, { kind: "ident" });
        else push("word", w, w, ln, i, e, { kind: "literal" });
        i = e; continue;
      }
    }
    if (STOP.test(c)) {
      const two = c + (n ?? "");
      const p = two === "&&" || two === "||" ? two : c;
      push("punct", p, p, ln, i, i + p.length); i += p.length; continue;
    }
    const e = readWord(i);
    const w = src.slice(i, e).replace(/`/g, "");
    push("word", w, w, ln, i, e, { kind: /^\w+$/.test(w) ? "ident" : "literal" });
    i = e > i ? e : i + 1;
  }
  return toks;
}

const isP = (t, v) => t?.t === "punct" && t.v === v;
const isOpen = (t) => t?.t === "punct" && OPEN.has(t.v);
const isClose = (t) => t?.t === "punct" && CLOSE.has(t.v);
const isOp = (t, v) => t?.t === "op" && t.v === v;
const isW = (t, v) => t?.t === "word" && t.v.toLowerCase() === v;

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
  const right = (k, list = false) => {
    let e = k + 1;
    for (;;) {
      while (toks[e] && (isOp(toks[e], "not") || isP(toks[e], "!"))) e++;
      if (!toks[e]) return k;
      if (isOpen(toks[e]) && m[e] >= 0) e = m[e];
      for (;;) {
        const a = toks[e + 1];
        if ((isP(a, ".") || isP(a, "::")) && toks[e + 2]) e += 2;
        else if (isOpen(a) && a.att && m[e + 1] >= 0) e = m[e + 1];
        else break;
      }
      if (list && isP(toks[e + 1], ",") && toks[e + 2]) { e += 2; continue; }
      return e;
    }
  };
  const left = (k, list = false) => {
    let s = k - 1;
    for (;;) {
      for (;;) {
        if (isClose(toks[s]) && m[s] >= 0) s = m[s];
        if ((isP(toks[s - 1], ".") || isP(toks[s - 1], "::")) && s >= 2) s -= 2;
        else break;
      }
      if (list && isP(toks[s - 1], ",") && s >= 2) { s -= 2; continue; }
      return Math.max(s, 0);
    }
  };
  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.t === "op") {
      if (CMP.has(t.v)) {
        const bit = COND | (NEGOP.has(t.v) ? NEG : 0);
        mark(left(k, LISTOP.has(t.v)), k - 1, bit);
        mark(k + 1, right(k, LISTOP.has(t.v)), bit);
        if (RX.has(t.v) && toks[k + 1]?.t === "str") toks[k + 1].rx = true;
      } else if (t.v === "and" || t.v === "or" || t.v === "xor") {
        mark(left(k), k - 1, COND);
        mark(k + 1, right(k), COND);
      } else if (t.v === "not") mark(k + 1, right(k), COND | NEG);
      else if (t.v === "replace" || t.v === "split") { if (toks[k + 1]?.t === "str") toks[k + 1].rx = true; }
    } else if (isP(t, "!")) mark(k + 1, right(k), COND | NEG);
    else if (t.t === "word") {
      const lw = t.v.toLowerCase();
      if ((lw === "if" || lw === "elseif" || lw === "while" || lw === "until") && isP(toks[k + 1], "(") && m[k + 1] > 0) mark(k + 2, m[k + 1] - 1, COND);
      else if (lw === "else" && isP(toks[k + 1], "{") && m[k + 1] > 0) mark(k + 2, m[k + 1] - 1, FB);
      else if (t.v === "??") mark(k + 1, right(k), FB);
      else if (t.v === "?") mark(left(k), k - 1, COND);
      else if (lw === "switch") {
        let j = k + 1;
        while (j < n && !isP(toks[j], "{")) j = isOpen(toks[j]) && m[j] >= 0 ? m[j] + 1 : j + 1;
        if (j >= n || m[j] < 0) continue;
        const end = m[j];
        let p = j + 1, afterScriptLabel = false;
        while (p < end) {
          let q = p;
          while (q < end && !isP(toks[q], "{")) q = isOpen(toks[q]) && m[q] >= 0 ? m[q] + 1 : q + 1;
          if (q >= end || m[q] < 0) break;
          const label = toks.slice(p, q);
          if (label.length === 1 && isW(label[0], "default")) mark(q + 1, m[q] - 1, FB);
          else if (label.length) mark(p, q - 1, COND);
          else if (!afterScriptLabel) { mark(q + 1, m[q] - 1, COND); afterScriptLabel = true; p = m[q] + 1; continue; }
          afterScriptLabel = false;
          p = m[q] + 1;
        }
      }
    }
  }
  return fl;
}

function nameMap(toks, m, stem) {
  const names = new Array(toks.length).fill(stem);
  for (let k = 0; k < toks.length; k++) {
    if (!(isW(toks[k], "function") || isW(toks[k], "filter")) || toks[k + 1]?.t !== "word") continue;
    let j = k + 2;
    while (j < toks.length && !isP(toks[j], "{")) j = isOpen(toks[j]) && m[j] >= 0 ? m[j] + 1 : j + 1;
    if (j >= toks.length || m[j] < 0) continue;
    for (let q = k + 1; q <= m[j]; q++) names[q] = toks[k + 1].v;
  }
  return names;
}

function scanFile(path, src) {
  const toks = lex(src), m = mates(toks);
  const fl = flags(toks, m);
  const stem = path.split("/").pop().replace(/\.[^.]+$/, "");
  const names = nameMap(toks, m, stem);
  const tier = tierOf(path);
  const out = [];
  const push = (k, tok, kind) => {
    const c = { kind, condition: !!(fl[k] & COND), negated: !!(fl[k] & NEG), fallbackArm: !!(fl[k] & FB), forcedArm: false, wild: false, mergesNone: false };
    const cls = classOf(tok, c);
    if (cls === "none") return;
    out.push({ file: path, line: toks[k].line, tok, cls, base: cls, anchor: anchor(toks, k, names[k]), forced: false, tier, ids: idsIn(tok), ctx: c });
  };
  toks.forEach((t, k) => {
    if (t.t === "str") push(k, t.v, t.rx ? "regex" : "literal");
    else if (t.t === "var" || t.t === "param") push(k, t.v, "ident");
    else if (t.t === "word") push(k, t.v, t.kind === "ident" ? "ident" : "literal");
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
