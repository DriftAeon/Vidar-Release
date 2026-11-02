// Rust structural class St (free): code shapes the compiler or the module tree already pins to one agent. Resolved
// against `$adapters` (tierOf adapter:X) and `$closed` (derived enums), never name patterns.
//   St-mod      `mod X;` whose resolved file has tier adapter:X
//   St-use      id segment of a `use` tree whose module prefix resolves to adapter X (glob ok; `as` on the segment stays strict)
//   St-handler  id segment of a `generate_handler![..]` path resolving to adapter X
//   St-sig      `X::` in a fn signature, struct or type alias, resolving to adapter X
//   St-arm      S/C token naming only X inside the body of the innermost forced arm naming exactly one id X
//               (not in a fallback arm, a wild or none-merging match; a guard never forces)
//   St-decl     variant declarations of a `$closed` enum: in `$enums`, not Agent, every id-named variant reference
//               in product code is F or St-arm. Open enums are reported and their declarations stay strict.
// Also here: the comparison flag for Q2 (a) and the test tier by declaration (`#[cfg(test)] mod x;`).
// rust-keys.mjs and this file import each other; both only call across at run time.
import { idsIn, isIdWord, tierOf, words } from "./key-words.mjs";
import { analyse, isI, isOpen, isP, lex, mates, testAttr } from "./rust-keys.mjs";

export const CMP = 64; // fl bit: direct comparison operand (Q2 a)
const CRATES = ["src-tauri/src/", "src-falcon/src/"];
const crateOf = (p) => CRATES.find((c) => p.startsWith(c)) ?? null;
const idNamed = (v) => { const w = words(v); return w.length === 1 && isIdWord(w[0]); };
const CMP_METHODS = /^(starts_with|ends_with|contains|strip_prefix|find|eq\w*)$/;

/** Variant declarations [{name, idx}] of an enum span (`open` = its `{`). */
export function variantsOf(toks, m, sp) {
  const vs = [];
  for (let j = sp.open + 1; j < sp.end; j++) {
    if (isP(toks[j], "#") && isP(toks[j + 1], "[") && m[j + 1] > 0) { j = m[j + 1]; continue; }
    if (toks[j].t !== "ident") continue;
    vs.push({ name: toks[j].v, idx: j });
    while (j < sp.end && !isP(toks[j], ",")) { if (isOpen(toks[j]) && m[j] >= 0) j = m[j]; j++; }
  }
  return vs;
}

/** Q2 (a): flag string literals that are direct comparison operands (==, !=, and the compare methods). */
export function flagCompare(toks, fl) {
  const eq = (t) => isP(t, "==") || isP(t, "!=");
  const meth = (k) => toks[k]?.t === "ident" && CMP_METHODS.test(toks[k].v);
  toks.forEach((t, k) => {
    if (t.t !== "str") return;
    let p = k - 1;
    if (isP(toks[p], "&")) p--;
    const asArg = isP(toks[p], "(") && meth(p - 1) && isP(toks[p - 2], ".");
    const asRecv = isP(toks[k + 1], ".") && meth(k + 2) && isP(toks[k + 3], "(");
    if (eq(toks[k - 1]) || eq(toks[k + 1]) || asArg || asRecv) fl[k] |= CMP;
  });
}

// ---- module tree ----

function modPathOf(path, crate) {
  const segs = path.slice(crate.length).replace(/\.rs$/, "").split("/");
  if (segs.length === 1 && (segs[0] === "main" || segs[0] === "lib")) return [];
  if (segs[segs.length - 1] === "mod") segs.pop();
  return segs;
}

const modFile = (crate, segs, all) => {
  if (!all || !segs.length) return null;
  const b = crate + segs.join("/");
  return [`${b}.rs`, `${b}/mod.rs`].find((c) => all.has(c)) ?? null;
};

/** Per-file name resolution: module path segments -> the file each prefix names (null past the last module). */
function scopeOf(path, ctx) {
  const crate = crateOf(path);
  const all = ctx.all instanceof Set ? ctx.all : null;
  const cur = crate ? modPathOf(path, crate) : [];
  const alias = new Map();
  const resolve = (segs) => {
    const files = new Array(segs.length).fill(null);
    let base = null;
    if (!crate || !all || !segs.length) return { files, base };
    let i = 0;
    const f0 = segs[0].name;
    if (f0 === "crate") { base = []; i = 1; }
    else if (f0 === "self") { base = cur; i = 1; }
    else if (f0 === "super") { base = cur; while (segs[i]?.name === "super") { base = base.slice(0, -1); i++; } }
    else {
      const p0 = alias.get(f0) ?? [[...cur, f0], [f0]].find((p) => modFile(crate, p, all));
      if (!p0 || !modFile(crate, p0, all)) return { files, base };
      files[0] = modFile(crate, p0, all); base = p0; i = 1;
    }
    for (; i < segs.length; i++) {
      const cand = [...base, segs[i].name];
      const f = modFile(crate, cand, all);
      if (!f) break;
      files[i] = f; base = cand;
    }
    return { files, base, full: files[segs.length - 1] !== null };
  };
  return { crate, cur, alias, resolve };
}

/** Leaves {segs: [{name, idx}], alias?, glob?} of a use tree held in toks[i, end). */
function leaves(toks, m, i, end, prefix, out) {
  const segs = [...prefix];
  while (i < end) {
    const t = toks[i];
    if (isP(t, "{") && m[i] > 0) {
      for (let s = i + 1; s < m[i]; ) {
        let e = s;
        while (e < m[i] && !isP(toks[e], ",")) e = isOpen(toks[e]) && m[e] >= 0 ? m[e] + 1 : e + 1;
        leaves(toks, m, s, e, segs, out);
        s = e + 1;
      }
      return;
    }
    if (isP(t, "*")) { out.push({ segs, glob: true }); return; }
    if (t.t === "ident") {
      segs.push({ name: t.v, idx: i });
      i++;
      if (isI(toks[i], "as")) { out.push({ segs, alias: toks[i + 1]?.v }); return; }
      if (isP(toks[i], "::")) i++;
      continue;
    }
    i++;
  }
  out.push({ segs });
}

const pathAt = (toks, k) => {
  const segs = [];
  let s = k;
  while (isP(toks[s - 1], "::") && toks[s - 2]?.t === "ident") s -= 2;
  for (let j = s; j <= k; j += 2) segs.push({ name: toks[j].v, idx: j });
  return segs;
};

/** Files only reached through `#[cfg(test)] mod x;` (and never through a plain `mod x;`): test tier by declaration. */
export function testDeclared(files, ctx) {
  const all = ctx.all instanceof Set ? ctx.all : null;
  const seen = new Map();
  for (const f of files) {
    const crate = crateOf(f.path);
    if (!crate || !all) continue;
    const toks = lex(f.src), m = mates(toks), cur = modPathOf(f.path, crate);
    for (let j = 0; j < toks.length; j++) {
      if (!isI(toks[j], "mod") || toks[j + 1]?.t !== "ident" || !isP(toks[j + 2], ";")) continue;
      const file = modFile(crate, [...cur, toks[j + 1].v], all);
      if (!file) continue;
      let b = j - 1, test = false;
      if (isP(toks[b], ")") && m[b] > 0 && isI(toks[m[b] - 1], "pub")) b = m[b] - 2;
      else if (isI(toks[b], "pub")) b--;
      while (isP(toks[b], "]") && m[b] > 0 && isP(toks[m[b] - 1], "#")) { test = test || testAttr(toks, m, m[b] - 1) > 0; b = m[b] - 2; }
      const rec = seen.get(file) ?? { test: 0, plain: 0 };
      rec[test ? "test" : "plain"]++;
      seen.set(file, rec);
    }
  }
  return new Set([...seen].filter(([, r]) => r.test > 0 && r.plain === 0).map(([f]) => f));
}

/** Token index -> St kind ("mod" | "use" | "handler" | "sig" | "arm" | "decl") for one analysed file. */
export function stMarks(path, an, ctx, bits) {
  const { toks, m, spans, fl, armAt, armRecs } = an;
  const out = new Map();
  const sc = scopeOf(path, ctx);
  const adapterFor = (file, text) => { const ids = idsIn(text); return !!file && ids.length > 0 && ids.every((i) => tierOf(file) === `adapter:${i}`); };
  const modName = (k) => (isI(toks[k], "mod") && toks[k + 1]?.t === "ident" && isP(toks[k + 2], ";") ? toks[k + 1] : null);
  const pass = [];
  for (let k = 0; k < toks.length; k++) {
    const nm = modName(k);
    if (nm && sc.crate) {
      const f = modFile(sc.crate, [...sc.cur, nm.v], ctx.all);
      if (f) sc.alias.set(nm.v, [...sc.cur, nm.v]);
      if (adapterFor(f, nm.v)) out.set(k + 1, "mod");
    } else if (isI(toks[k], "use") && !isP(toks[k - 1], "::") && !isP(toks[k - 1], ".")) {
      let e = k + 1;
      while (e < toks.length && !isP(toks[e], ";")) e = isOpen(toks[e]) && m[e] >= 0 ? m[e] + 1 : e + 1;
      leaves(toks, m, k + 1, e, [], pass);
    }
  }
  for (const lf of pass) {
    const r = sc.resolve(lf.segs);
    if (r.full && !lf.glob) sc.alias.set(lf.alias ?? lf.segs[lf.segs.length - 1].name, r.base);
  }
  for (const lf of pass) {
    const r = sc.resolve(lf.segs);
    r.files.forEach((f, i) => { if (adapterFor(f, lf.segs[i].name) && !(lf.alias && i === lf.segs.length - 1)) out.set(lf.segs[i].idx, "use"); });
  }
  const mark = (k, kind) => {
    const segs = pathAt(toks, k);
    const f = sc.resolve(segs).files[segs.length - 1];
    if (adapterFor(f, toks[k].v)) out.set(k, kind);
  };
  for (let k = 0; k < toks.length; k++) {
    if (isI(toks[k], "generate_handler") && isP(toks[k + 1], "!") && isOpen(toks[k + 2]) && m[k + 2] > 0) {
      for (let q = k + 3; q < m[k + 2]; q++) if (toks[q].t === "ident" && isP(toks[q + 1], "::")) mark(q, "handler");
    }
  }
  for (const sp of spans) {
    const sig = sp.kind === "fn" ? [sp.start, sp.open >= 0 ? sp.open : sp.end] : sp.kind === "struct" || sp.kind === "type" ? [sp.start, sp.end] : null;
    if (!sig) continue;
    for (let q = sig[0]; q < sig[1]; q++) if (toks[q].t === "ident" && isP(toks[q + 1], "::")) mark(q, "sig");
  }
  for (let k = 0; k < toks.length; k++) {
    if (armAt[k] < 0 || (fl[k] & (bits.FB | bits.WILD | bits.MERGE)) || (toks[k].t !== "ident" && toks[k].t !== "str")) continue;
    const ids = idsIn(toks[k].v);
    if (ids.length && ids.every((i) => i === armRecs[armAt[k]].id)) out.set(k, "arm");
  }
  const closed = ctx.enums?.closed;
  if (closed?.size) for (const sp of spans) if (sp.kind === "enum" && sp.open >= 0 && closed.has(sp.name)) for (const v of variantsOf(toks, m, sp)) if (idNamed(v.name)) out.set(v.idx, "decl");
  return out;
}

/** `$closed`: enums (not Agent) whose id-named variants are only referenced from F or St-arm positions. */
export function closeEnums(files, enums, decls, bits) {
  const owners = new Map();
  for (const [name, vs] of enums) if (name !== "Agent") for (const v of vs) if (idNamed(v)) owners.set(v, [...(owners.get(v) ?? []), name]);
  const bad = new Set();
  for (const f of files) {
    const an = analyse(f.src, enums);
    const inDecl = new Uint8Array(an.n);
    for (const sp of an.spans) if (sp.kind === "enum" && enums.has(sp.name)) inDecl.fill(1, sp.start, sp.end + 1);
    an.toks.forEach((t, k) => {
      if (t.t !== "ident" || !owners.has(t.v) || inDecl[k]) return;
      let cands = owners.get(t.v);
      if (isP(an.toks[k - 1], "::")) {
        const q = an.toks[k - 2];
        const name = q?.t !== "ident" ? null : q.v === "Self" ? an.impls[k] : q.v;
        cands = cands.filter((c) => c === name);
      }
      if (!cands.length) return;
      const fb = an.fl[k] & (bits.FB | bits.MERGE);
      const forced = (an.fl[k] & bits.FORCED) && !fb;
      const arm = an.armAt[k] >= 0 && !(an.fl[k] & (bits.FB | bits.WILD | bits.MERGE)) && idsIn(t.v).every((i) => i === an.armRecs[an.armAt[k]].id);
      if (!forced && !arm) for (const c of cands) bad.add(c);
    });
  }
  const closed = new Set(), open = [];
  for (const [name] of enums) {
    if (name === "Agent") continue;
    if (bad.has(name)) for (const d of decls.get(name) ?? []) open.push({ name, ...d });
    else closed.add(name);
  }
  return { closed, open };
}
