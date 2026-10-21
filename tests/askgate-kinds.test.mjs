// Every askGate() call names a registered kind (src/panels/askgate-kinds.ts) so its title comes from
// the one table, and no permission ask hand-rolls a `title:` of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const { ASK_KINDS } = await import("../src/panels/askgate-kinds.ts");

const root = join(fileURLToPath(import.meta.url), "..", "..");
const src = join(root, "src");

// Calls allowed to pass an unregistered kind and an inline title: the "Question" ask (a tab's own question, not a permission).
const ALLOW = new Set(["src/control/listen.ts|ctl-ask"]);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.ts$/.test(e.name)) yield p;
  }
}

/** `askGate(` call sites: args text up to the matching paren (strings and comments skipped). */
function calls() {
  const out = [];
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(root, file).replaceAll("\\", "/");
    for (const m of text.matchAll(/(?<![\w.])askGate\(/g)) {
      const before = text.slice(0, m.index);
      if (/function\s+$/.test(before) || /(^|\n)\s*(\/\/|\*|\/\*)[^\n]*$/.test(before)) continue; // the definition, or a comment line
      let depth = 1, i = m.index + m[0].length, args = "";
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (c === '"' || c === "'" || c === "`") {
          const q = c;
          let s = c;
          for (i++; i < text.length && text[i] !== q; i++) { s += text[i]; if (text[i] === "\\") s += text[++i]; }
          args += s + q; i++; continue;
        }
        if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (depth > 0) args += c;
        i++;
      }
      const kind = /,\s*"([^"]+)"\s*$/.exec(args)?.[1] ?? null;
      out.push({ rel, args, kind });
    }
  }
  return out;
}

test("the scan finds the known askGate callers", () => {
  assert.ok(calls().length >= 5, "five call sites today");
});

test("every askGate call passes a kind registered in ASK_KINDS, bar the allowlist", () => {
  for (const c of calls()) {
    if (ALLOW.has(`${c.rel}|${c.kind}`)) continue;
    assert.ok(c.kind, `${c.rel}: askGate call without a literal kind`);
    assert.ok(ASK_KINDS[c.kind], `${c.rel}: kind "${c.kind}" is not in ASK_KINDS`);
  }
});

test("no permission ask passes an inline title", () => {
  for (const c of calls()) {
    if (!/\bpermission\s*:\s*true\b/.test(c.args)) continue;
    assert.ok(!/\btitle\s*:/.test(c.args), `${c.rel}: permission ask (${c.kind}) passes an inline title; add it to ASK_KINDS`);
  }
});
