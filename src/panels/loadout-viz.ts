// Instructions bar: a stacked-width visualization of the Loadout module's
// instruction-file chain, split out per the module-boundary rule (one file,
// one concern). Same rack conventions
// as loadout.ts's header: textContent only, no innerHTML with data, no
// polling — this is a pure render of the KbFile list it's handed.

import type { KbFile } from "./loadout";

function shortName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// alternating accent/accent2 tints for at-start files (so neighbours differ);
// on-touch files get a hatched, dimmed treatment instead, regardless of parity
export function buildInstructionsViz(files: KbFile[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "loadout-viz";

  const totalKb = files.reduce((a, f) => a + f.kb, 0) || 1;
  const bar = document.createElement("div");
  bar.className = "loadout-bar";
  const legend = document.createElement("div");
  legend.className = "loadout-legend";

  files.forEach((f, i) => {
    const shade = i % 2 === 0 ? "loadout-shade-a" : "loadout-shade-b";
    const tone = f.onTouch ? "loadout-touch" : shade;
    const title = `${f.path} — ${f.kb.toFixed(1)} KB`;

    const seg = document.createElement("span");
    seg.className = `loadout-bar-seg ${tone}`;
    seg.style.width = `${(f.kb / totalKb) * 100}%`;
    seg.title = title;
    bar.append(seg);

    const row = document.createElement("div");
    row.className = "loadout-legend-row";
    const swatch = document.createElement("span");
    swatch.className = `loadout-legend-swatch ${tone}`;
    const name = document.createElement("span");
    name.className = "loadout-legend-name";
    name.textContent = shortName(f.path);
    name.title = f.path;
    const kbEl = document.createElement("span");
    kbEl.className = "loadout-legend-kb";
    kbEl.textContent = `${f.kb.toFixed(1)} KB`;
    row.append(swatch, name, kbEl);
    legend.append(row);
  });

  wrap.append(bar, legend);
  return wrap;
}
