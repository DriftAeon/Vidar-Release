// A node result over the 64 KiB event cap must reach the next node intact: the terminal event's
// text is capped (child.rs cap_text) but its outputFile holds the whole result. engine.ts is
// wiring, not under `node --test`, so the decision lives in run.ts's resolveHandoffText; the last
// test pins that engine.ts routes capped text through it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHandoffText, OUTPUT_CAP_MARKER } from "../src/flow/run.ts";

const CAP = 64 * 1024;

// Mirrors child.rs cap_text: keep the tail, prefix the marker.
function capText(s) {
  return s.length <= CAP ? s : `${OUTPUT_CAP_MARKER}…${s.slice(s.length - CAP)}`;
}

test("uncapped text is handed on as is, without a read", async () => {
  let reads = 0;
  const r = await resolveHandoffText({ text: "short result", outputFile: "x" }, async () => {
    reads++;
    return "other";
  });
  assert.deepEqual(r, { ok: true, text: "short result" });
  assert.equal(reads, 0);
});

test("a result over 64 KiB reaches the next node intact via the output file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-handoff-"));
  try {
    const full = "line of output\n".repeat(6000); // ~90 KB
    assert.ok(full.length > CAP);
    const file = join(dir, "out.txt");
    writeFileSync(file, full);
    const event = { text: capText(full), outputFile: file };
    assert.notEqual(event.text, full);
    const r = await resolveHandoffText(event, async () => readFileSync(file, "utf8"));
    assert.deepEqual(r, { ok: true, text: full });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capped text with a failed read is an error, never the capped tail", async () => {
  const text = capText("x".repeat(CAP + 10));
  const r = await resolveHandoffText({ text, outputFile: "f" }, async () => {
    throw new Error("disk gone");
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /disk gone/);
});

test("capped text with no file or an empty read is an error", async () => {
  const text = capText("x".repeat(CAP + 10));
  assert.equal((await resolveHandoffText({ text, outputFile: null }, async () => "full")).ok, false);
  assert.equal((await resolveHandoffText({ text, outputFile: "f" }, async () => "")).ok, false);
  assert.equal((await resolveHandoffText({ text, outputFile: "f" }, async () => null)).ok, false);
});

test("engine.ts hands capped terminal text to resolveHandoffText and guards a cancel", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/flow/engine.ts", import.meta.url)), "utf8");
  assert.match(src, /resolveHandoffText\(/);
  assert.match(src, /flow_output_read/);
  const after = src.slice(src.indexOf("await resolveHandoffText"));
  assert.match(after.slice(0, 200), /rs\.canceled/);
});
