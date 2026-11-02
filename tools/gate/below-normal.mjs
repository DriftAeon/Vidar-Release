// Runs gate work at BelowNormal priority so foreground apps (games) win while a gate runs.
// Two uses:
//   node --import ./tools/gate/below-normal.mjs ...   lowers this process; children inherit it.
//   node tools/gate/below-normal.mjs <cmd> [args...]   lowers itself, runs <cmd>, exits with its code.
// Refuses: a priority failure never fails a run (one stderr line, then carry on); with no <cmd>
// as main it prints the usage line and exits 2.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch (e) {
  console.error(`below-normal: could not lower priority (${e.message}); continuing`);
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error('usage: node tools/gate/below-normal.mjs <cmd> [args...]');
    process.exit(2);
  }
  // shell only on Windows, where npm/cargo shims need it; args are repo-authored, not user input.
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd !== process.execPath && cmd !== 'node' });
  if (r.error) console.error(`below-normal: ${r.error.message}`);
  process.exit(r.status ?? 1);
}
