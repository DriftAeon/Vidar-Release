// Changes git-setup prompt (src/changes/git-prompt.ts): one line, names the folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gitInitPrompt } from '../src/changes/git-prompt.ts';

test('the prompt names the folder and is a single line', () => {
  const p = gitInitPrompt('C:\\Work\\demo');
  assert.ok(p.startsWith('Set up git in C:\\Work\\demo: run git init'));
  assert.doesNotMatch(p, /[\r\n]/);
  assert.match(p, /ask before adding a remote or pushing\.$/);
});

test('control characters in the folder are stripped', () => {
  const p = gitInitPrompt('C:\\a\nb\r\u001b[31m');
  assert.doesNotMatch(p, /[\r\n\u001b]/);
});

test('an empty folder drops the in-clause', () => {
  assert.ok(gitInitPrompt('').startsWith('Set up git: run git init'));
});
