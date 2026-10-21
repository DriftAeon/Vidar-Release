import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const { core } = JSON.parse(read('../contracts/modules.json'));
const optional = core
  .filter(({ kind, level, surface }) => kind === 'surface' && level === 'optional' && surface?.placement === 'workbench')
  .sort((a, b) => a.surface.order - b.surface.order);

test('workbench optional specs match the optional workbench surfaces in the contract', () => {
  const src = read('../src/panels/workbench.ts');
  const body = src.slice(src.indexOf('const OPTIONAL_TABS'), src.indexOf('const optionalGenerations'));
  const specs = [...body.matchAll(/^ {2}(\w+): spec\(\{/gm)].map((m) => m[1]);
  assert.deepEqual([...specs].sort(), optional.map(({ id }) => id).sort());
  const union = src.match(/type OptionalTab = ([^;]+);/)[1].match(/"(\w+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...union].sort(), optional.map(({ id }) => id).sort());
});

test('Jira, Notion and Slack declare an icon in the contract and the maps read it', () => {
  for (const id of ['jira', 'notion', 'slack']) {
    const entry = optional.find((e) => e.id === id);
    assert.ok(entry?.surface.icon, `${id} has surface.icon`);
  }
  for (const file of ['../src/settings/modules.ts', '../src/settings/build/view.ts']) {
    assert.match(read(file), /\.\.\.SURFACE_ICONS/, file);
  }
  const icons = JSON.parse(read('../contracts/icons.json')).icons;
  for (const { id, surface } of core.filter((e) => e.surface?.icon)) {
    assert.ok(surface.icon in icons, `${id} icon ${surface.icon} is in contracts/icons.json`);
  }
});

test('every optional workbench tab resolves to an icon in both maps', () => {
  const icons = JSON.parse(read('../contracts/icons.json')).icons;
  const maps = ['../src/settings/modules.ts', '../src/settings/build/view.ts'].map((f) => [f, read(f)]);
  for (const { id, surface } of optional) {
    const icon = surface.icon ?? id;
    assert.ok(icon in icons, `${id} icon ${icon} is in contracts/icons.json`);
    if (surface.icon) continue;
    for (const [file, src] of maps) assert.match(src, new RegExp(`\\b${id}: "${id}"`), `${file} maps ${id}`);
  }
});
