// Changes tab model (src/changes/model.ts): grouping by porcelain x/y, the filename-keeping path
// truncation, and the Revert All filter that mirrors changes.rs check_paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusAfter, groupFiles, headFocusClass, p4ActionLetter, p4ChangeLabel, revertablePaths, truncatePath } from '../src/changes/model.ts';

const file = (path, x, y, extra = {}) => ({
  path, x, y, untracked: false, stagedAdds: 0, stagedDels: 0, workAdds: 0, workDels: 0, ...extra,
});

test('a file staged and then modified again sits in both groups with each side\'s counts', () => {
  const f = file('src/a.ts', 'M', 'M', { stagedAdds: 3, stagedDels: 1, workAdds: 2, workDels: 0 });
  const g = groupFiles([f]);
  assert.deepEqual(g.staged.map((r) => [r.letter, r.kind, r.adds, r.dels]), [['M', 'modified', 3, 1]]);
  assert.deepEqual(g.changes.map((r) => [r.letter, r.kind, r.adds, r.dels]), [['M', 'modified', 2, 0]]);
});

test('a staged rename is a Staged row only; untracked is a Changes row lettered U', () => {
  const g = groupFiles([
    file('docs/new.md', 'R', '.', { origPath: 'docs/old.md' }),
    file('notes/n.txt', '?', '?', { untracked: true, workAdds: null, workDels: null }),
  ]);
  assert.deepEqual(g.staged.map((r) => [r.file.path, r.letter, r.kind]), [['docs/new.md', 'R', 'renamed']]);
  assert.deepEqual(g.changes.map((r) => [r.file.path, r.letter, r.kind, r.adds]), [['notes/n.txt', 'U', 'untracked', null]]);
});

test('truncation keeps the whole filename and drops leading folders first', () => {
  const long = 'content/packs/codex-profiles/agents/reviewer.toml';
  assert.deepEqual(truncatePath(long, 80), { name: 'reviewer.toml', dir: 'content/packs/codex-profiles/agents' });
  assert.deepEqual(truncatePath(long, 30), { name: 'reviewer.toml', dir: '…/agents' });
  assert.deepEqual(truncatePath('a/very-long-folder-name/x.ts', 14), { name: 'x.ts', dir: '…der-name' });
  const tight = truncatePath('src/panels/a-very-long-file-name.ts', 8);
  assert.equal(tight.name, 'a-very-long-file-name.ts');
  assert.equal(tight.dir, '');
});

test('Revert All sends only paths restore can put back from HEAD', () => {
  const files = [
    file('keep/mod.ts', '.', 'M'),
    file('keep/gone.ts', '.', 'D'),
    file('keep/both.ts', 'M', 'M'),
    file('drop/new.ts', 'A', 'M'),            // staged new: not in HEAD
    file('drop/ita.ts', '.', 'A'),            // intent-to-add
    file('drop/dest.ts', 'R', 'M', { origPath: 'drop/src.ts' }), // rename destination
    file('drop/conflict.ts', 'U', 'U'),       // unmerged
    file('drop/both-added.ts', 'A', 'A'),     // unmerged, both added
    file('drop/u.ts', '?', '?', { untracked: true }),
    file('drop/split.ts', 'D', '.'),          // unstaged new file: a tracked and an untracked record
    file('drop/split.ts', '?', '?', { untracked: true }),
    file('drop/staged-only.ts', 'M', '.'),    // no Changes row
  ];
  const g = groupFiles(files);
  assert.deepEqual(revertablePaths(files, g.changes), ['keep/mod.ts', 'keep/gone.ts', 'keep/both.ts']);
});

test('focus after a stage or unstage lands on the same path, the next row, or the other group', () => {
  const groups = (files) => groupFiles(files);
  const g = groups([file('a.ts', '.', 'M'), file('b.ts', '.', 'M'), file('c.ts', '.', 'M'), file('s.ts', 'M', '.')]);
  // the row is still there: same path, whatever its index
  assert.deepEqual(focusAfter({ group: 'changes', path: 'b.ts', index: 0 }, g), { group: 'changes', index: 1 });
  // staging b (middle row): the list lost it, the next row takes the index
  const afterB = groups([file('a.ts', '.', 'M'), file('b.ts', 'M', '.'), file('c.ts', '.', 'M'), file('s.ts', 'M', '.')]);
  assert.deepEqual(focusAfter({ group: 'changes', path: 'b.ts', index: 1 }, afterB), { group: 'changes', index: 1 });
  // staging the last row: the index clamps to the new last row
  const afterC = groups([file('a.ts', '.', 'M'), file('b.ts', '.', 'M'), file('c.ts', 'M', '.'), file('s.ts', 'M', '.')]);
  assert.deepEqual(focusAfter({ group: 'changes', path: 'c.ts', index: 2 }, afterC), { group: 'changes', index: 1 });
  // staging the last unstaged row: Changes is empty, focus moves to the first Staged row
  const allStaged = groups([file('a.ts', 'M', '.'), file('s.ts', 'M', '.')]);
  assert.deepEqual(focusAfter({ group: 'changes', path: 'a.ts', index: 0 }, allStaged), { group: 'staged', index: 0 });
  // a group's head button: the same group's head, else the other's, else nothing
  assert.deepEqual(focusAfter({ group: 'changes', path: null, index: 0 }, g), { group: 'changes', head: true });
  assert.deepEqual(focusAfter({ group: 'changes', path: null, index: 0 }, allStaged), { group: 'staged', head: true });
  assert.equal(focusAfter({ group: 'staged', path: 's.ts', index: 0 }, groups([])), null);
});

test('after a busy redraw the header focus returns to the Sync or Rename control that was pressed', () => {
  assert.equal(headFocusClass('sync', false), 'cx-split-main');
  assert.equal(headFocusClass('more', false), 'cx-split-more');
  assert.equal(headFocusClass('rename', false), 'cx-rename');
  // detached HEAD: no pen, sync pair disabled, nothing to focus
  assert.equal(headFocusClass('sync', true), null);
  assert.equal(headFocusClass('rename', true), null);
});

test('p4 actions map to A, M and D; others keep their first letter; the title is Title Case', () => {
  const l = (a) => { const r = p4ActionLetter(a); return [r.letter, r.title]; };
  assert.deepEqual(l('add'), ['A', 'Add']);
  assert.deepEqual(l('branch'), ['A', 'Branch']);
  assert.deepEqual(l('move/add'), ['A', 'Move/Add']);
  assert.deepEqual(l('edit'), ['M', 'Edit']);
  assert.deepEqual(l('integrate'), ['M', 'Integrate']);
  assert.deepEqual(l('delete'), ['D', 'Delete']);
  assert.deepEqual(l('move/delete'), ['D', 'Move/Delete']);
  assert.deepEqual(l('purge'), ['P', 'Purge']);
});

test('p4 changelist heads: Default, else #change plus the first description line', () => {
  assert.deepEqual(p4ChangeLabel('default', ''), { label: 'Default', title: 'Default' });
  assert.deepEqual(p4ChangeLabel('1234', 'Fix it\nMore detail\n'), { label: '#1234 Fix it', title: 'Fix it\nMore detail' });
  assert.deepEqual(p4ChangeLabel('77', ''), { label: '#77', title: '#77' });
});
