import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupDom } from './helpers/dom-mount.mjs';

const events = [];
const loads = [];
const imports = [];
globalThis.__registryHidden = [];
globalThis.__registryImports = imports;
globalThis.__toolRegistryFactories = {
  marquee: () => { loads.push('marquee'); return tool('marquee', 'Marquee', 'M'); },
  eyedropper: () => { loads.push('eyedropper'); return tool('eyedropper', 'Eyedropper', 'E'); },
};

function tool(id, label, glyph) {
  return {
    id, label, glyph, canvas: 'none',
    mount(host) {
      events.push(`${id}:mount`);
      assert.equal(host.classList.contains('hidden'), true);
    },
    arm() { events.push(`${id}:arm`); },
    disarm() { events.push(`${id}:disarm`); },
    dispose() { events.push(`${id}:dispose`); },
  };
}

setupDom({
  stubs: {
    'tools/marquee': 'globalThis.__registryImports.push("marquee"); export const marqueeTool = () => globalThis.__toolRegistryFactories.marquee();',
    'tools/eyedropper': 'globalThis.__registryImports.push("eyedropper"); export const eyedropperTool = () => globalThis.__toolRegistryFactories.eyedropper();',
    'panels/inspect': 'export const exitInspect = () => {}; export const onInspectEnter = () => {};',
    prefs: 'export const getPref = key => key === "modules.hidden" ? globalThis.__registryHidden : []; export const setPref = () => true;',
  },
});

const { createToolRegistry, BUILTIN_TOOL_MODULES } = await import('../src/tools/registry.ts');
const { initToolbench, setToolVisibility } = await import('../src/panels/toolbench.ts');

test('toolbar descriptors are ordered optional rail surfaces from the contract', () => {
  const { core } = JSON.parse(readFileSync(new URL('../contracts/modules.json', import.meta.url), 'utf8'));
  const declared = core.filter(({ kind, surface }) => kind === 'surface' && surface?.placement === 'rail');
  assert.deepEqual(BUILTIN_TOOL_MODULES.map(({ id, label, level }) => ({ id, label, level })),
    declared.map(({ id, label, level }) => ({ id, label, level })));
  assert.deepEqual(createToolRegistry((id) => id === 'eyedropper').map(({ id }) => id), ['eyedropper']);
  assert.deepEqual(imports, [], 'registry lookup does not import either tool');
  assert.deepEqual(loads, [], 'registry lookup does not load either factory');
});

test('registry tools retain toolbar order and arm/disarm behavior', async () => {
  globalThis.__registryHidden = ['tool:marquee'];
  const hiddenGrid = document.createElement('div');
  await initToolbench(hiddenGrid, document.createElement('div'), createToolRegistry());
  assert.deepEqual(imports, ['eyedropper'], 'hidden tool module is not imported');
  assert.deepEqual(loads, ['eyedropper'], 'hidden tool factory is not loaded or created');
  globalThis.__registryHidden = [];
  loads.length = 0;
  events.length = 0;
  const grid = document.createElement('div');
  const options = document.createElement('div');
  const tools = createToolRegistry();

  assert.deepEqual(tools.map(({ id }) => id), ['marquee', 'eyedropper']);
  await initToolbench(grid, options, tools);
  assert.equal(events.shift(), 'eyedropper:dispose');
  assert.deepEqual(loads.toSorted(), ['eyedropper', 'marquee']);

  const buttons = [...grid.querySelectorAll('button')];
  const hosts = [...options.children];
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-label')), ['Marquee', 'Eyedropper']);
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-pressed')), ['false', 'false']);
  assert.deepEqual(events.toSorted(), ['eyedropper:mount', 'marquee:mount']);
  assert.equal(hosts.every((host) => host.classList.contains('hidden')), true);

  buttons[0].click();
  assert.deepEqual(events.at(-1), 'marquee:arm');
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-pressed')), ['true', 'false']);
  assert.equal(hosts[0].classList.contains('hidden'), false);

  buttons[1].click();
  assert.deepEqual(events.slice(-2), ['marquee:disarm', 'eyedropper:arm']);
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(hosts[0].classList.contains('hidden'), true);
  assert.equal(hosts[1].classList.contains('hidden'), false);

  buttons[1].click();
  assert.equal(events.at(-1), 'eyedropper:disarm');
  assert.deepEqual(buttons.map((button) => button.getAttribute('aria-pressed')), ['false', 'false']);
  assert.equal(hosts.every((host) => host.classList.contains('hidden')), true);
});

test('a tool hidden during its import is never created or armed', async () => {
  let finishLoad;
  let created = 0;
  globalThis.__registryHidden = [];
  const delayed = { id: 'delayed', label: 'Delayed', level: 'optional',
    load: () => new Promise((resolve) => { finishLoad = () => resolve(() => { created++; return tool('delayed', 'Delayed', 'D'); }); }) };
  const grid = document.createElement('div');
  const mounting = initToolbench(grid, document.createElement('div'), [delayed]);
  assert.equal(await setToolVisibility('delayed', false), true);
  finishLoad();
  await mounting;
  assert.equal(created, 0);
  assert.deepEqual([...grid.children], []);
});
