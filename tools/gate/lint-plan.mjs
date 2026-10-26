// Fast-tier lint step for the gate: lints only the staged files each linter covers.
//   import { lintStep } from './lint-plan.mjs'; lintStep(stagedPaths) -> ['lints', command] | null
// null = no staged file is covered by either linter (the step is skipped).
// Each linter gets its covered paths plus --staged, so it judges the staged blob (`git show :path`),
// not the working copy: another session's unstaged edits never reach the gate.
// The whole-tree runs (`npm run build`, `lint:ui`, the full tier) pass no path list and are unchanged.
import { covers as coversUi } from '../ui/lint-ui.mjs';
import { covers as coversCopy } from '../ui/lint-copy.mjs';

const q = (p) => `"${p.replace(/"/g, '')}"`;

export function lintStep(files) {
  const cmds = [];
  const ui = files.filter(coversUi);
  const copy = files.filter(coversCopy);
  if (ui.length) cmds.push(`node tools/ui/lint-ui.mjs --staged ${ui.map(q).join(' ')}`);
  if (copy.length) cmds.push(`node tools/ui/lint-copy.mjs --staged ${copy.map(q).join(' ')}`);
  return cmds.length ? ['lints', cmds.join(' && ')] : null;
}
