// Temp-tree builder for tests: a { "rel/path": text } map becomes files under a fresh temp dir.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Writes each file under dir, creating parent folders. Returns dir.
export function writeTree(dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
  }
  return dir;
}

// Fresh mkdtemp dir named `<prefix>…` under the OS temp, filled from files. Caller removes it.
export function makeTree(prefix, files = {}) {
  return writeTree(mkdtempSync(join(tmpdir(), prefix)), files);
}
