// TypeScript / .mjs agent-key scanner. Parses with the TypeScript 7 API
// (`typescript/unstable/sync`: a native tsgo server behind a sync client; the classic `ts.createSourceFile` API is gone
// in 7.x) and types with its checker. Every identifier, string and template part, regex literal, property name,
// computed-key value and call argument whose words name an agent id is a key. Significant tokens for anchors come from
// the 7.x scanner (`reScanSlashToken` for regex literals, `reScanTemplateToken` for template parts).
//   scan(files, ctx) -> [{file, line, tok, cls, base, anchor, n, forced, tier, ids, ctx}]
// files are {path, src}; ctx is {root, ids, types}. `ctx.types === false` skips the checker (no forced keys).
// ctx on each entry: { kind, condition, negated, fallbackArm, forcedArm, mergesNone, wild, cmp } where cmp is
// { op, subject } for an operand of an equality test (the sys-agent-branch sweep lane reads it).
// Forced (F): a key of an object literal typed with every AgentId as a required property (Record<AgentId, X>), reported
// at the object literal's first line; a `case` literal of a switch over the AgentId union whose `default` is closed by
// `unknownAgent(x)` or any call/declaration typed `never`. A switch without the close is not forced (its case literals
// are `wild`, strict in every tier when a non-closing default exists).
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { API, SymbolFlags, TypeFlags } from "typescript/unstable/sync";
import { LanguageVariant, SyntaxKind as K, createScanner } from "typescript/unstable/ast";
import { DEFAULT_IDS, anchor, classOf, idsIn, isIdWord, tierOf, useIds, words } from "./key-words.mjs";

const norm = (p) => p.replace(/\\/g, "/");
const key = (p) => norm(p).toLowerCase();
const EQ = new Map([[K.EqualsEqualsEqualsToken, "==="], [K.ExclamationEqualsEqualsToken, "!=="], [K.EqualsEqualsToken, "=="], [K.ExclamationEqualsToken, "!="]]);
const NE = new Set([K.ExclamationEqualsEqualsToken, K.ExclamationEqualsToken]);
const TRANSPARENT = new Set([K.ParenthesizedExpression, K.NonNullExpression, K.AsExpression, K.SatisfiesExpression, K.TypeAssertionExpression]);
const FUNCS = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.Constructor, K.GetAccessor, K.SetAccessor]);
const WORDS_END = new Set([K.ThisKeyword, K.SuperKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword]);
const OPERAND_END = new Set([K.Identifier, K.NumericLiteral, K.StringLiteral, K.RegularExpressionLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateTail, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.PlusPlusToken, K.MinusMinusToken, K.PrivateIdentifier, K.BigIntLiteral]);

/** Significant tokens {text, start} with regex and template parts rescanned (comments and whitespace skipped). */
export function lexTokens(text) {
  const sc = createScanner(true, LanguageVariant.Standard, text);
  const out = [], tpl = [];
  let prev = null;
  for (;;) {
    let k = sc.scan();
    if (k === K.EndOfFile) break;
    if (k === K.CloseBraceToken && tpl.length && tpl[tpl.length - 1] === 0) { k = sc.reScanTemplateToken(false); if (k === K.TemplateTail) tpl.pop(); }
    else if (k === K.OpenBraceToken && tpl.length) tpl[tpl.length - 1]++;
    else if (k === K.CloseBraceToken && tpl.length) tpl[tpl.length - 1]--;
    else if (k === K.TemplateHead) tpl.push(0);
    else if ((k === K.SlashToken || k === K.SlashEqualsToken) && !(prev && (OPERAND_END.has(prev.kind) || WORDS_END.has(prev.kind)))) k = sc.reScanSlashToken();
    const t = { text: sc.getTokenText(), start: sc.getTokenStart(), kind: k };
    out.push(t);
    prev = t;
  }
  return out;
}

function nameOf(n) {
  const nm = n.name;
  return nm && (nm.kind === K.Identifier || nm.kind === K.StringLiteral || nm.kind === K.PrivateIdentifier) ? nm.text : null;
}

/** Enclosing function, method, class or variable name; "<file>" at top level. */
function itemName(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (FUNCS.has(p.kind)) {
      const nm = nameOf(p);
      if (nm) { const c = p.parent; const cn = c && (c.kind === K.ClassDeclaration || c.kind === K.ClassExpression) ? nameOf(c) : null; return cn ? `${cn}.${nm}` : nm; }
    } else if (p.kind === K.VariableDeclaration || p.kind === K.ClassDeclaration || p.kind === K.InterfaceDeclaration || p.kind === K.TypeAliasDeclaration || p.kind === K.EnumDeclaration || p.kind === K.PropertyDeclaration) {
      const nm = nameOf(p);
      if (nm) return nm;
    }
  }
  return "<file>";
}

/** Climb member / call / paren chains to the expression that stands as one operand. `q` = reached through `?.`. */
function chainTop(node) {
  let n = node, q = false;
  for (;;) {
    const p = n.parent;
    if (!p) break;
    if (p.kind === K.PropertyAccessExpression && (p.expression === n || p.name === n)) { if (p.questionDotToken && p.name === n) q = true; n = p; }
    else if (p.kind === K.ElementAccessExpression && (p.expression === n || p.argumentExpression === n)) { if (p.questionDotToken && p.argumentExpression === n) q = true; n = p; }
    else if (p.kind === K.CallExpression && p.expression === n) n = p;
    else if (TRANSPARENT.has(p.kind) && p.expression === n) n = p;
    else break;
  }
  return { top: n, q };
}

/** Is the operand a decision? (`if`/`while`/ternary condition, `&&`/`||`/`??` operand, `in`); `neg` for `!`, `!==`, `!=`. */
function slot(top) {
  let n = top, neg = false;
  for (;;) {
    const p = n.parent;
    if (!p) return { cond: false, neg };
    if (TRANSPARENT.has(p.kind)) { n = p; continue; }
    if (p.kind === K.PrefixUnaryExpression && p.operator === K.ExclamationToken) { neg = true; n = p; continue; }
    if (p.kind === K.BinaryExpression) {
      const op = p.operatorToken.kind;
      if (op === K.AmpersandAmpersandToken || op === K.BarBarToken || op === K.QuestionQuestionToken || op === K.InKeyword) return { cond: true, neg };
      if (EQ.has(op) || op === K.InstanceOfKeyword || op === K.LessThanToken || op === K.GreaterThanToken || op === K.LessThanEqualsToken || op === K.GreaterThanEqualsToken) { if (NE.has(op)) neg = true; n = p; continue; }
      return { cond: false, neg };
    }
    if ((p.kind === K.IfStatement || p.kind === K.WhileStatement || p.kind === K.DoStatement) && p.expression === n) return { cond: true, neg };
    if (p.kind === K.ForStatement && p.condition === n) return { cond: true, neg };
    if (p.kind === K.ConditionalExpression && p.condition === n) return { cond: true, neg };
    return { cond: false, neg };
  }
}

/** Fallback: inside a `default:` clause, a plain `else`, the right side of `||` / `??`, a ternary's else branch. */
function inFallback(node) {
  for (let a = node; a.parent; a = a.parent) {
    const p = a.parent;
    if (p.kind === K.DefaultClause) return true;
    if (p.kind === K.IfStatement && p.elseStatement === a && a.kind !== K.IfStatement) return true;
    if (p.kind === K.BinaryExpression && (p.operatorToken.kind === K.BarBarToken || p.operatorToken.kind === K.QuestionQuestionToken) && p.right === a) return true;
    if (p.kind === K.ConditionalExpression && p.whenFalse === a) return true;
  }
  return false;
}

const isStr = (n) => n && (n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral);
const isModuleSpec = (n) => {
  const p = n.parent;
  if (!p) return false;
  if ((p.kind === K.ImportDeclaration || p.kind === K.ExportDeclaration) && p.moduleSpecifier === n) return true;
  if (p.kind === K.ExternalModuleReference || p.kind === K.ImportEqualsDeclaration) return true;
  if (p.kind === K.CallExpression && p.expression.kind === K.ImportKeyword) return true;
  return p.kind === K.LiteralType && p.parent?.kind === K.ImportType;
};
const isRegExpArg = (n) => {
  const p = n.parent;
  return !!p && (p.kind === K.NewExpression || p.kind === K.CallExpression) && p.expression.kind === K.Identifier && p.expression.text === "RegExp" && p.arguments?.[0] === n;
};
const isHasOwnArg = (n) => {
  const p = n.parent;
  if (!p || p.kind !== K.CallExpression || !p.arguments?.includes(n)) return false;
  const e = p.expression;
  const nm = e.kind === K.PropertyAccessExpression ? e.name.text : e.kind === K.Identifier ? e.text : "";
  return nm === "hasOwnProperty" || nm === "hasOwn";
};

function openProject(files, ctx) {
  const root = resolve(ctx.root ?? join(tmpdir(), "__agent_keys__"));
  const abs = (p) => norm(resolve(root, p));
  const overlay = new Map();
  const roots = [];
  for (const f of files) { const a = abs(f.path); overlay.set(key(a), f.src); roots.push(a); }
  const id = existsSync(join(root, "src/agents/id.ts")) ? abs("src/agents/id.ts") : null;
  if (id && !overlay.has(key(id))) roots.push(id);
  let base = { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, lib: ["ES2022"] };
  const tc = ctx.root ? join(root, "tsconfig.json") : null;
  if (tc && existsSync(tc)) { try { base = JSON.parse(readFileSync(tc, "utf8")).compilerOptions ?? base; } catch { /* keep defaults */ } }
  const cfg = abs("__agent-keys.tsconfig.json");
  overlay.set(key(cfg), JSON.stringify({ compilerOptions: { ...base, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, composite: false, incremental: false }, files: roots, include: [] }));
  const api = new API({
    fs: {
      readFile: (f) => overlay.get(key(f)),
      fileExists: (f) => (overlay.has(key(f)) ? true : undefined),
    },
  });
  const snap = api.updateSnapshot({ openProject: cfg });
  const proj = snap.getProjects()[0];
  return { api, proj, abs };
}

function scanFile(f, sf, checker, ctx, idList) {
  const { path, src } = f;
  const text = sf.text;
  const toks = lexTokens(text);
  const byStart = new Map(toks.map((t, i) => [t.start, i]));
  const tier = tierOf(path);
  const base = tier;
  const forced = new Set(), wild = new Set(), lineAt = new Map();
  const startOf = (n) => n.getStart(sf);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const idSet = new Set(idList);
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const keyed = (n) => (n.kind === K.StringLiteral || n.kind === K.Identifier) && words(n.text).some(isIdWord);
  const out = [];

  const idUnion = (type) => {
    if (!type) return false;
    const ts = type.flags & TypeFlags.Union ? type.getTypes() : [type];
    return ts.length > 0 && ts.every((t) => t.flags & TypeFlags.StringLiteral && idSet.has(t.value));
  };
  const neverish = (n) => {
    if (n.kind === K.CallExpression) {
      if (n.expression.kind === K.Identifier && n.expression.text === "unknownAgent") return true;
      for (const a of n.arguments ?? []) { const t = checker.getTypeAtLocation(a); if (t && t.flags & TypeFlags.Never) return true; }
    }
    if (n.kind === K.VariableDeclaration && n.type?.kind === K.NeverKeyword) return true;
    return n.forEachChild((c) => (neverish(c) ? true : undefined)) === true;
  };

  const onObject = (o) => {
    if (!checker || !o.properties.some((p) => p.name && keyed(p.name))) return;
    let t = checker.getContextualType(o);
    t = t && checker.getNonNullableType(t);
    if (!t) return;
    const req = new Set(checker.getPropertiesOfType(t).filter((s) => !(s.flags & SymbolFlags.Optional)).map((s) => s.name));
    if (!sameSet(req, idSet)) return;
    for (const p of o.properties) if (p.name && keyed(p.name)) { forced.add(startOf(p.name)); lineAt.set(startOf(p.name), lineOf(startOf(o))); }
  };
  const onSwitch = (s) => {
    if (!checker) return;
    const clauses = s.caseBlock.clauses;
    const lits = clauses.filter((c) => c.kind === K.CaseClause && isStr(c.expression) && words(c.expression.text).some(isIdWord)).map((c) => startOf(c.expression));
    if (!lits.length || !idUnion(checker.getTypeAtLocation(s.expression))) return;
    const def = clauses.find((c) => c.kind === K.DefaultClause);
    if (def && def.statements.some(neverish)) lits.forEach((p) => forced.add(p));
    else if (def) lits.forEach((p) => wild.add(p));
  };

  const push = (node, tok, kind, at = node) => {
    const { top, q } = chainTop(node);
    const sl = slot(top);
    const cmpP = top.parent;
    const cmp = cmpP?.kind === K.BinaryExpression && EQ.has(cmpP.operatorToken.kind) ? { op: EQ.get(cmpP.operatorToken.kind), subject: (cmpP.left === top ? cmpP.right : cmpP.left).getText(sf) } : null;
    const s = startOf(at);
    const c = {
      kind,
      condition: q || sl.cond || isHasOwnArg(node),
      negated: sl.neg,
      fallbackArm: inFallback(node),
      forcedArm: forced.has(s),
      mergesNone: false,
      wild: wild.has(s),
      cmp,
    };
    const cls = classOf(tok, c);
    if (cls === "none") return;
    const i = byStart.get(s);
    const item = itemName(node);
    out.push({
      file: path, line: lineAt.get(s) ?? lineOf(s), tok, cls, base: cls === "F" ? classOf(tok, { ...c, forcedArm: false }) : cls,
      anchor: i === undefined ? `${item}: ${tok}` : anchor(toks, i, item), forced: cls === "F", tier: base, ids: idsIn(tok), ctx: c,
    });
  };

  const visit = (n) => {
    switch (n.kind) {
      case K.ObjectLiteralExpression: onObject(n); break;
      case K.SwitchStatement: onSwitch(n); break;
      case K.Identifier:
      case K.PrivateIdentifier: push(n, n.text, "ident"); break;
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
        if (!isModuleSpec(n)) push(n, n.text, isRegExpArg(n) ? "regex" : "literal");
        break;
      case K.TemplateHead:
      case K.TemplateMiddle:
      case K.TemplateTail: push(n, n.text, "literal"); break;
      case K.RegularExpressionLiteral: push(n, n.text, "regex"); break;
      case K.ElementAccessExpression:
        if (n.expression.kind === K.Identifier && n.expression.text === "AGENT_IDS" && n.argumentExpression.kind === K.NumericLiteral) push(n, `AGENT_IDS[${n.argumentExpression.text}]`, "positional");
        break;
      default: break;
    }
    n.forEachChild((c) => { visit(c); });
  };
  visit(sf);
  const count = new Map();
  for (const e of out) count.set(`${e.anchor}`, (count.get(e.anchor) ?? 0) + 1);
  for (const e of out) e.n = count.get(e.anchor);
  return out;
}

export function scan(files, ctx = {}) {
  if (ctx.ids) useIds(ctx.ids);
  const list = files.map((f) => (typeof f === "string" ? { path: f, src: readFileSync(resolve(ctx.root ?? ".", f), "utf8") } : f));
  if (!list.length) return [];
  const idList = (ctx.ids ?? DEFAULT_IDS).ids;
  const { api, proj, abs } = openProject(list, ctx);
  try {
    const checker = ctx.types === false ? null : proj.checker;
    return list.flatMap((f) => {
      const sf = proj.program.getSourceFile(abs(f.path));
      if (!sf) throw new Error(`ts-keys: ${f.path} is not in the TypeScript project (parse failed or excluded)`);
      return scanFile(f, sf, checker, ctx, idList);
    });
  } finally {
    api.close();
  }
}
