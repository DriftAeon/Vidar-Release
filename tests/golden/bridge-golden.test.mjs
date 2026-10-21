// Golden tests at the bridge seams, Node/TS half. One fixture per cross-language shape under
// tests/golden/; the Rust half reads the same files (src-tauri/src/bridge_golden.rs,
// src-falcon/src/bridge_golden.rs) and round-trips them through its serde types, so a shape change
// on either side fails a test. shapes.golden.ts pins the frontend types to the same fixtures.
//
//   node --test tests/golden/bridge-golden.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingInputs } from "../helpers/optional-input.mjs";
import { shouldReadopt } from "../../src/launcher/readopt.ts";
import { DECISION_KEYS, DECISION_VIEW_KEYS, DISPATCH_KEYS, SESSION_SUMMARY_KEYS, VERDICTS } from "./shapes.golden.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const golden = (name) => JSON.parse(read(`tests/golden/${name}`));
const sorted = (xs) => [...new Set(xs)].sort();

test("tsc accepts the golden fixtures against the frontend wire types", () => {
  const pkg = createRequire(import.meta.url).resolve("typescript/package.json");
  const tsc = join(dirname(pkg), JSON.parse(readFileSync(pkg, "utf8")).bin.tsc);
  const r = spawnSync(process.execPath, [tsc, "-p", "tests/golden/tsconfig.json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("falcon list: golden sessions carry exactly the typed keys; re-adopt takes only the Vidar-held one", () => {
  const { sessions } = golden("falcon-list.json");
  assert.deepEqual(sorted(sessions.flatMap(Object.keys)), sorted(SESSION_SUMMARY_KEYS));
  // sessions[0].last_holder is falcon.rs CLIENT_NAME in the Vidar build, [1] in the shell build (Rust half)
  assert.equal(shouldReadopt(sessions[0]), true);
  assert.equal(shouldReadopt(sessions[1]), false);
  // a gateway id is a module id (e.g. "acme"): checked against the contract pattern, not a closed list
  const idPattern = new RegExp(JSON.parse(readFileSync(join(ROOT, "contracts/modules.json"), "utf8")).idPattern);
  for (const s of sessions) if ("gateway" in s) assert.ok(typeof s.gateway === "string" && idPattern.test(s.gateway), s.gateway);
});

test("display decision: golden file keys and the verdict set agree with display.rs", () => {
  const d = golden("display-decision.json");
  assert.deepEqual(sorted(Object.keys(d)), sorted(DECISION_KEYS));
  const rust = read("src-tauri/src/bridge/display.rs").match(/fn valid_verdict[\s\S]*?matches!\(v,([^)]*)\)/);
  assert.ok(rust, "display.rs valid_verdict matches! list not found");
  assert.deepEqual(sorted(rust[1].match(/"[^"]+"/g).map((s) => JSON.parse(s))), sorted(VERDICTS));
  assert.ok(VERDICTS.includes(d.verdict));
});

test("display decision view: golden view carries exactly the typed keys around the golden decision", () => {
  const v = golden("display-decision-view.json");
  assert.deepEqual(sorted(Object.keys(v)), sorted(DECISION_VIEW_KEYS));
  assert.deepEqual(sorted(Object.keys(v.decision)), sorted(DECISION_KEYS));
  assert.equal(typeof v.current, "boolean");
});

test("review dispatch: golden request, TS type and astra-dispatch.ps1 name the same keys", { skip: missingInputs(import.meta.url, "../../tools/desks/astra-dispatch.ps1") ?? false }, () => {
  // Dispatch is deny_unknown_fields on the Rust side: a key the publisher adds parks every request.
  const d = golden("review-dispatch.json");
  assert.deepEqual(sorted(Object.keys(d)), sorted(DISPATCH_KEYS));
  const ps1 = read("tools/desks/astra-dispatch.ps1").match(/\$json = @\{([^}]*)\} \| ConvertTo-Json/);
  assert.ok(ps1, "astra-dispatch.ps1 dispatch hashtable not found");
  assert.deepEqual(sorted([...ps1[1].matchAll(/(\w+)\s*=/g)].map((m) => m[1])), sorted(DISPATCH_KEYS));
});

test("sidecar --falcon records: every state and label field the sidecar emits is in the golden replay", () => {
  const src = read("tools/claude-sidecar.mjs");
  const lines = golden("sidecar-falcon-records.json").steps.map((s) => s.line);
  const of = (subtype) => lines.filter((l) => l.subtype === subtype);

  const permissionStates = [...src.matchAll(/subtype: "permission", id(?:: [\w.]+)?, state: "(\w+)"/g)].map((m) => m[1]);
  assert.ok(permissionStates.length > 0, "no permission records found in the sidecar");
  assert.deepEqual(sorted(of("permission").map((l) => l.state)), sorted(permissionStates));
  assert.match(src, /state: "settled", signal \}/, "settled record no longer carries `signal`");

  const outcomeStates = [...src.matchAll(/falconOutcome\([^,]+, "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(sorted(of("outcome").map((l) => l.state)), sorted(outcomeStates));
  assert.match(src, /subtype: "outcome", cid, state, \.\.\.\(message \? \{ message \}/, "outcome envelope changed");
  const labels = [...src.matchAll(/falconOutcome\([^,]+, "applied", undefined, \{ (\w+):/g)].map((m) => m[1]);
  const envelope = new Set(["type", "subtype", "cid", "state", "message"]);
  const goldenLabels = of("outcome").filter((l) => l.state === "applied").flatMap(Object.keys).filter((k) => !envelope.has(k));
  assert.deepEqual(sorted(goldenLabels), sorted(labels));
});
