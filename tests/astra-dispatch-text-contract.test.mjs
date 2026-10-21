// Source contract for the composed Astra text when pwsh cannot run in the sandbox.
// The integration test in astra-dispatch.test.mjs remains the executable check.
import baseTest from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { missingInputs, guard } from "./helpers/optional-input.mjs";

// astra-dispatch.ps1 is not in the claude-codex source set: skip with the path named.
const skip = missingInputs(import.meta.url, "../tools/desks/astra-dispatch.ps1");
const test = guard(baseTest, skip);
const script = skip ? "" : readFileSync(new URL("../tools/desks/astra-dispatch.ps1", import.meta.url), "utf8");

test("common caller wording loses its duplicate marker and report sentence", () => {
  const suffixParts = script.match(/\$markerSuffix = '([^']*)' \+ \[regex\]::Escape\(\$marker\) \+ '([^']*)'/);
  assert.ok(suffixParts, "marker suffix expression changed");
  const marker = "ASTRA-DONE eadcd251";
  const suffix = new RegExp(suffixParts[1].replace(/^\(\?i\)/, "") + marker + suffixParts[2], "i");
  const text = "Read and follow the brief at bench-codex-arm\\brief.md. Work only in reports\\bench-codex-arm. Report to runtime\\bridge\\astra-reports\\eadcd251-report.md, then end with ASTRA-DONE eadcd251.";
  const trimmed = text.replace(suffix, "").trimEnd();
  assert.equal(trimmed, "Read and follow the brief at bench-codex-arm\\brief.md. Work only in reports\\bench-codex-arm. Report to runtime\\bridge\\astra-reports\\eadcd251-report.md");

  const shape = script.match(/if \(\$Text -match '([^']*Read and follow the brief at[^']*)'\)/);
  assert.ok(shape, "common caller parser changed");
  const parsed = new RegExp(shape[1].replace(/^\(\?i\)/, ""), "i").exec(trimmed);
  assert.equal(parsed?.[1], "bench-codex-arm\\brief.md");
  assert.equal(parsed?.[2], "reports\\bench-codex-arm");
  assert.match(script, /\$Text = "Follow Brief: \$\(\$Matches\[1\]\) \| Work in: \$\(\$Matches\[2\]\)"/);
  assert.match(script, /\$Text \+= " \| Write Report: \$Report"/);
  assert.match(script, /\$Text \+= " \| End Reply: \$marker"/);
  assert.ok(script.indexOf('$Text += " | End Reply: $marker"') > script.indexOf('$Text += " | Write Report: $Report"'));
});
