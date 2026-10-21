import test from 'node:test';
import assert from 'node:assert/strict';
import { codexBareRefusesCwd } from '../src/launcher/codex-vidar-cwd.ts';

// Same cases as bare/tests.rs (refuse_vidar_cwd), text rule only.
const base = 'D:\\Dev';
const root = `${base}\\Apps\\Vidar`;
const rt = `${root}\\runtime`;
const check = (cwd) => codexBareRefusesCwd(cwd, root, 'runtime');

test('root, ancestors and runtime folders are refused', () => {
  const bad = [
    root,
    root.toUpperCase(),
    `${root}\\`.replaceAll('\\', '/'),
    `${base}\\Apps`,
    base,
    'D:\\',
    rt,
    `${rt}\\bridge`,
    `${rt}\\worktrees`,
    `${rt}\\worktrees\\..\\bridge`,
    `${root}\\src\\..`,
    `${base}\\Apps\\Other\\..\\Vidar`,
    `${rt}\\worktrees\\x\\..\\..\\bridge`,
  ];
  for (const b of bad) assert.equal(check(b), true, b);
});

test('worktrees, sibling repos and the source tree are allowed', () => {
  const ok = [
    `${rt}\\worktrees\\x`,
    `${rt}\\worktrees\\x\\src`,
    `${rt}\\worktrees\\new-lane`,
    `${base}\\Apps\\Other`,
    `${root}\\src`,
    `${rt}\\worktrees\\x\\..\\y`,
    'E:\\Work',
    '',
  ];
  for (const o of ok) assert.equal(check(o), false, o);
});
