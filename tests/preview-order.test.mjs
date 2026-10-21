import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// reconstruct() reads DOMParser, Node and document from the page; jsdom stands in for WebView2.
const { window } = new JSDOM('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { DOMParser: window.DOMParser, Node: window.Node, document: window.document });
const { reconstruct } = await import('../src/panels/preview.ts');

// Regression: the walk visited children last-first and appended as it went, so every
// Display page rendered mirrored (last section on top, labels after their fields).
test('reconstruct keeps sibling order at every depth', () => {
  const r = reconstruct('<html><body><h1>a</h1><div><p>b</p><p>c</p></div><p>d</p></body></html>');
  assert.equal(r.fellBack, false);
  assert.match(r.body, /<h1>a<\/h1><div><p>b<\/p><p>c<\/p><\/div><p>d<\/p>/);
});
