import { test } from "node:test";
import assert from "node:assert/strict";

const { parseSteps, splitUnverified, isMonoField } = await import("../src/relay/card-fields.ts");

test("a piped value splits into steps and paths become chips", () => {
  const brief = "C:\\Work\\Proj\\runtime\\bridge\\display\\reviews\\brief.md";
  const steps = parseSteps(`Read and follow the brief at ${brief} | Write Report: ${brief}. | End Reply: DONE`);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0][0], { kind: "text", text: "Read and follow the brief at " });
  assert.deepEqual(steps[0][1], { kind: "path", path: brief, dir: "…\\display\\reviews\\", file: "brief.md" });
  assert.equal(steps[1][1].path, brief, "a trailing period is not part of the path");
  assert.deepEqual(steps[1][2], { kind: "text", text: "." });
  assert.deepEqual(steps[2], [{ kind: "text", text: "End Reply: DONE" }]);
});

test("plain text stays one step; short paths keep their root", () => {
  assert.deepEqual(parseSteps("hello"), [[{ kind: "text", text: "hello" }]]);
  assert.deepEqual(parseSteps(""), [[{ kind: "text", text: "" }]]);
  const [[seg]] = parseSteps("C:\\Work\\a.txt");
  assert.deepEqual(seg, { kind: "path", path: "C:\\Work\\a.txt", dir: "C:\\Work\\", file: "a.txt" });
  assert.deepEqual(parseSteps("a | b | c").length, 3);
  assert.deepEqual(parseSteps("a|b"), [[{ kind: "text", text: "a|b" }]]);
});

test("the unverified suffix becomes a flag and ids are mono", () => {
  assert.deepEqual(splitUnverified("0808dc09 (Unverified)"), { value: "0808dc09", unverified: true });
  assert.deepEqual(splitUnverified("Astra"), { value: "Astra", unverified: false });
  assert.ok(isMonoField("Asked By", "0808dc09"));
  assert.ok(!isMonoField("Asked By", "Asker Tab"));
  assert.ok(isMonoField("Request", "x"));
  assert.ok(!isMonoField("Text", "x"));
});
