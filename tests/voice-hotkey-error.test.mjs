// voice_register rejects with {reason, chord} (src-tauri voice.rs HotkeyError); the webview words it.
import test from "node:test";
import assert from "node:assert/strict";
import { asHotkeyError, hotkeyHead, hotkeyLine, hotkeyNote } from "../src/voice-hotkey-error.ts";

test("only the typed shape is a hotkey error", () => {
  assert.deepEqual(asHotkeyError({ reason: "taken", chord: "Ctrl+Shift+G" }), { reason: "taken", chord: "Ctrl+Shift+G" });
  assert.equal(asHotkeyError("hotkey \"Ctrl+G\": HotKey already registered"), null);
  assert.equal(asHotkeyError({ reason: "other", chord: "Ctrl+G" }), null);
  assert.equal(asHotkeyError({ reason: "taken" }), null);
  assert.equal(asHotkeyError(null), null);
});

test("the head names the chord in Title Case; the note is one sentence", () => {
  const taken = { reason: "taken", chord: "Ctrl+Shift+G" };
  const invalid = { reason: "invalid", chord: "Ctrl+" };
  assert.equal(hotkeyHead(taken), "Hotkey Ctrl+Shift+G Is Taken");
  assert.equal(hotkeyHead(invalid), "Hotkey Ctrl+ Is Invalid");
  assert.equal(hotkeyNote(taken), "Another app is already using this hotkey.");
  assert.equal(hotkeyNote(invalid), "Windows cannot bind this hotkey.");
  assert.equal(hotkeyLine(taken), "Another app is already using Ctrl+Shift+G.");
  assert.equal(hotkeyLine(invalid), "Ctrl+ is not a valid hotkey.");
});
