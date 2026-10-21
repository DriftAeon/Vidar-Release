// Project settings (hooks) load only in a folder Claude trusted: exact folder match on
// hasTrustDialogAccepted in .claude.json, any spelling, never a parent (security fix D1).
//
//   node --test tests\sidecar-trust.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectTrusted, loadClaudeJson } from "../tools/claude-sidecar-trust.mjs";

const trust = (key, v = true) => ({ projects: { [key]: { hasTrustDialogAccepted: v } } });

test("every spelling of the folder matches the trusted key", () => {
  const spellings = ["D:/Work/Apps/Repo", "D:\\Work\\Apps\\Repo", "d:/work/apps/repo", "D:\\WORK\\apps\\repo\\", "D:/Work/Apps/Repo/"];
  for (const key of spellings) {
    for (const cwd of spellings) assert.equal(projectTrusted(trust(key), cwd), true, `${key} vs ${cwd}`);
  }
});

test("a trusted parent does not trust a child, nor a child its parent", () => {
  assert.equal(projectTrusted(trust("D:/Work"), "D:\\Work\\Apps\\Repo"), false);
  assert.equal(projectTrusted(trust("D:/Work/Apps/Repo"), "D:/Work"), false);
  assert.equal(projectTrusted(trust("D:/Work/Apps/Repo"), "D:/Work/Apps/Repo2"), false);
});

test("the trusted spelling wins when another spelling of the folder lacks the key", () => {
  const cj = { projects: { "D:\\Work\\Apps\\Repo": { allowedTools: [] }, "D:/Work/Apps/Repo": { hasTrustDialogAccepted: true } } };
  assert.equal(projectTrusted(cj, "D:\\Work\\Apps\\Repo"), true);
});

test("trust false, missing, truthy-but-not-true, or no projects is untrusted", () => {
  assert.equal(projectTrusted(trust("C:/x", false), "C:/x"), false);
  assert.equal(projectTrusted({ projects: { "C:/x": {} } }, "C:/x"), false);
  assert.equal(projectTrusted(trust("C:/x", "true"), "C:/x"), false);
  assert.equal(projectTrusted(trust("C:/x", 1), "C:/x"), false);
  assert.equal(projectTrusted({}, "C:/x"), false);
  assert.equal(projectTrusted(null, "C:/x"), false);
  assert.equal(projectTrusted(trust("C:/x"), ""), false);
  assert.equal(projectTrusted(trust("C:/x"), undefined), false);
});

test("the loader reads CLAUDE_CONFIG_DIR first, else home; missing and bad JSON are untrusted", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vidar-trust-"));
  try {
    const cfg = join(tmp, "cfg"), home = join(tmp, "home"), bad = join(tmp, "bad");
    for (const d of [cfg, home, bad]) mkdirSync(d);
    writeFileSync(join(cfg, ".claude.json"), JSON.stringify(trust("C:/x")));
    writeFileSync(join(home, ".claude.json"), JSON.stringify(trust("C:/y")));
    writeFileSync(join(bad, ".claude.json"), "{ not json");
    assert.equal(projectTrusted(loadClaudeJson({ CLAUDE_CONFIG_DIR: cfg }, home), "C:/x"), true);
    assert.equal(projectTrusted(loadClaudeJson({ CLAUDE_CONFIG_DIR: cfg }, home), "C:/y"), false);
    assert.equal(projectTrusted(loadClaudeJson({}, home), "C:/y"), true);
    assert.equal(projectTrusted(loadClaudeJson({ CLAUDE_CONFIG_DIR: bad }, home), "C:/x"), false);
    assert.equal(projectTrusted(loadClaudeJson({ CLAUDE_CONFIG_DIR: join(tmp, "none") }, home), "C:/x"), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
