// Systems sweep lanes: one fixture per detector yields exactly its finding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DETECTORS, LANES } from "./lanes-systems.mjs";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sys-lanes-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, "utf8");
  }
  return { root };
}

const keys = (r) => {
  assert.equal(r.ok, true, r.error);
  return r.findings.map((f) => f.key);
};

test("lane list carries every detector", () => {
  assert.deepEqual(LANES.map((l) => l.id).sort(), Object.keys(DETECTORS).sort());
  assert.ok(!LANES.some((l) => l.id === "sys-ask-kinds"));
});

test("sys-relay flags a card RelayItem builder outside the owner", () => {
  const ctx = fixture({
    "src/relay/source-approvals.ts": 'import type { RelayItem } from "./store";\nconst a = { kind: "card" } as RelayItem;\n',
    "src/other/thing.ts": 'import type { RelayItem } from "../relay/store";\nconst b: RelayItem = { kind: "card" };\n',
    "src/other/plain.ts": 'const c = { kind: "card" };\n',
  });
  assert.deepEqual(keys(DETECTORS["sys-relay"](ctx)), ["sys-relay:src/other/thing.ts:builds a card RelayItem"]);
});

test("sys-approval-origins flags an origin without a producer", () => {
  const ctx = fixture({
    "src/asks/approval.ts": 'export type ApprovalOrigin = "alpha" | "beta";\n',
    "src/a.ts": 'openApproval({ origin: "alpha" }, r);\n',
    "src/b.ts": 'const x = { origin: "beta" };\n',
  });
  assert.deepEqual(keys(DETECTORS["sys-approval-origins"](ctx)), ["sys-approval-origins:beta"]);
});

test("sys-unions flags an identical union in two files", () => {
  const ctx = fixture({
    "src/a.ts": 'export type A = "x" | "y" | "z";\ntype Solo = "p" | "q" | "r";\n',
    "src/b.ts": 'type B =\n  | "z"\n  | "y"\n  | "x";\n',
  });
  assert.deepEqual(keys(DETECTORS["sys-unions"](ctx)), ["sys-unions:x|y|z"]);
});

test("sys-interfaces flags interfaces sharing 4+ field names", () => {
  const ctx = fixture({
    "src/a.ts": "interface Aa {\n  id: string;\n  title: string;\n  rows: number;\n  askedAt: number;\n  extra?: boolean;\n}\n",
    "src/b.ts": "export interface Bb {\n  id: string;\n  title: string;\n  rows: number;\n  askedAt: number;\n}\n",
    "src/c.ts": "interface Cc {\n  id: string;\n  title: string;\n  other: number;\n  more: number;\n}\n",
  });
  assert.deepEqual(keys(DETECTORS["sys-interfaces"](ctx)), ["sys-interfaces:src/a.ts:Aa~src/b.ts:Bb"]);
});

test("sys-writers flags two Rust files writing one paths.json id", () => {
  const ctx = fixture({
    "contracts/paths.json": JSON.stringify({ version: 1, ids: { ledger: { under: "root", rel: "l.jsonl" }, other: { under: "root", rel: "o" } } }),
    "src-tauri/src/paths.rs": 'pub fn ledger_path() -> PathBuf {\n    p("ledger")\n}\npub fn other_path() -> PathBuf {\n    p("other")\n}\n',
    "src-tauri/src/one.rs": "fn f() { std::fs::write(paths::ledger_path(), b\"\"); }\n",
    "src-tauri/src/two.rs": "fn g() { let f = File::create(paths::ledger_path()); }\n",
    "src-tauri/src/three.rs": "fn h() { std::fs::write(paths::other_path(), b\"\"); }\n",
  });
  const r = DETECTORS["sys-writers"](ctx);
  assert.deepEqual(keys(r), ["sys-writers:ledger"]);
  assert.match(r.findings[0].msg, /heuristic/);
});

test("sys-popover flags a hand-rolled popover", () => {
  const hand =
    'document.body.appendChild(el);\ndocument.addEventListener("pointerdown", close);\nif (e.key === "Escape") close();\n';
  const ctx = fixture({
    "src/hand.ts": hand,
    "src/ok.ts": `import { openPopover } from "../modules/popover";\n${hand}`,
    "src/modules/popover.ts": hand,
  });
  assert.deepEqual(keys(DETECTORS["sys-popover"](ctx)), ["sys-popover:src/hand.ts"]);
});

test("sys-agent-branch flags agent id checks outside the allowed homes", () => {
  const ctx = fixture({
    "src/agents/codex.ts": 'if (agent === "codex") {}\n',
    "src/panels/rendered/agent-profile.ts": 'if (agent === "claude") {}\n',
    "src/launcher/x.ts": 'const a = agent === "codex" ? 1 : 2;\nconst b = agent === "codex";\n',
  });
  const r = DETECTORS["sys-agent-branch"](ctx);
  assert.deepEqual(keys(r), ['sys-agent-branch:src/launcher/x.ts:agent === "codex"']);
  assert.equal(r.findings[0].detail.count, 2);
});

test("sys-dots flags raw hex on a dot state rule only", () => {
  const ctx = fixture({
    "src/styles/state-dot.css":
      ":root {\n  --dot-ok: var(--ok-green);\n  --dot-ok-module: #22c55e;\n}\n.good-dot[data-state=\"ok\"] { background: var(--dot-ok); }\n.bad-dot[data-state=\"ok\"] { background: #22c55e; }\n.plain { color: #fff; }\n",
  });
  assert.deepEqual(keys(DETECTORS["sys-dots"](ctx)), ['sys-dots:src/styles/state-dot.css:.bad-dot[data-state="ok"]:background']);
});
