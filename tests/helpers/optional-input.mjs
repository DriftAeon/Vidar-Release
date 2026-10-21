// Helpers for tests whose inputs are export-ignored (release tooling, runes cooking, run folders):
// the public source tree lacks them, so the test skips with a reason naming the missing path.
// Usage in a test file:
//   const skip = missingInputs(import.meta.url, "../tools/release/x.mjs");
//   const { f } = skip ? {} : await import("../tools/release/x.mjs");
//   const test = guard(baseTest, skip);
import { existsSync } from "node:fs";

// Returns a skip reason naming the first missing path (relative to the test file), or null.
export function missingInputs(from, ...rels) {
  for (const rel of rels) if (!existsSync(new URL(rel, from))) return `${rel.replace(/^(\.\.\/)+/, "")} is not in this tree (not shipped)`;
  return null;
}

// Wraps node:test's `test` so every test is registered as skipped when `skip` is set.
export function guard(baseTest, skip) {
  if (!skip) return baseTest;
  const wrapped = (name) => baseTest(name, { skip }, () => {});
  wrapped.skip = wrapped;
  wrapped.todo = wrapped;
  return wrapped;
}
