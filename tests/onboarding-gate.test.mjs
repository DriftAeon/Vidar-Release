// Onboarding gate (plan section 4): the four launcher entry points test onboardingOpen(); createSession
// never does (hosted readopt, Codex restore and Setup Via Agent spawn through it while the overlay is up).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function body(file, name) {
  const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const start = src.search(new RegExp(`export (async )?function ${name}\\b`));
  assert.ok(start >= 0, `${name} not found in ${file}`);
  const rest = src.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  assert.ok(end > 0, `${name} body end not found`);
  return rest.slice(0, end);
}

test("launcher entry points test onboardingOpen()", () => {
  assert.match(body("launcher/menu.ts", "openLauncher"), /onboardingOpen\(\)/);
  assert.match(body("launcher/keyboard.ts", "openLauncherByKeyboard"), /onboardingOpen\(\)/);
  const recent = body("launcher/recent.ts", "initRecent");
  const calls = recent.split("openLauncher();").length - 1;
  const gates = recent.split("onboardingOpen()").length - 1;
  assert.equal(calls, 2, "the two recent reopen paths");
  assert.equal(gates, 2, "each recent reopen path is gated");
});

test("createSession is never gated (trust boundary)", () => {
  assert.doesNotMatch(body("panels/sessions.ts", "createSession"), /onboardingOpen/);
});
