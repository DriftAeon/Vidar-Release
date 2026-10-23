// The character renderer slot. A renderer turns a loaded glTF into what the arena draws and
// drives its reveal; the renderer.ts loop only talks to the handle it gets back, so it never
// branches on which renderer is in use.
//
// Built in: `standard` (the GLB's own materials under a light rig, opacity fade) and `toon`
// (style-toon.ts: banded shading and an outline hull; never picked by `auto`). Everything else
// is a local addon under addons/<id>/index.ts (gitignored), reached only through the
// `@character-addons` specifier, which is an empty map in a release build (vite.config.ts).
// An addon whose `contract` is not RENDERER_CONTRACT is skipped with a console warning, so a
// core change to this interface bumps the number instead of breaking a private build unseen.
//
// `auto` picks the first installed addon whose `accepts` passes, else `standard`. A pack that
// names a renderer that is not installed renders Standard with a note for its Settings row.
import type * as T from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { addons } from "@character-addons";
import type { CharacterLighting, MaterialPreference } from "./catalog";
import type { ModelResources } from "./materials";

/** The interface version an addon declares as `contract`. */
export const RENDERER_CONTRACT = 1;
export const STANDARD_RENDERER = "standard";
export const AUTO_RENDERER = "auto";
const NOT_INSTALLED = "Renderer Not Installed, Showing Standard";

export interface RenderContext {
  gltf: GLTF;
  /** Everything the renderer creates or loads is registered here; renderer.ts disposes it. */
  resources: ModelResources;
  lighting: CharacterLighting;
  /** The arena scene, for a renderer that needs scene lights; its handle removes them. */
  scene: T.Scene;
}

/** What `apply` hands back; the renderer's own `materialize` receives it every reveal frame. */
export interface RendererHandle {
  /** The reveal finished; drop anything that only served it. */
  settle(): void;
  /** Remove anything added outside the model root (lights). Materials are renderer.ts's. */
  dispose(): void;
}

/** Behaviour roles core asks for; a clip map names the clip that plays each one. */
export type ClipRole = "idle" | "tired" | "run" | "rest" | "yes";

export interface ClipMap {
  /** Role → clip code, matched against the part of a clip name after its last "_". */
  roles: Readonly<Partial<Record<ClipRole, string>>>;
  /** Menu label for a clip name this map knows; null leaves the name as it is. */
  label(clipName: string): string | null;
}

export interface CharacterRendererModule {
  id: string;
  /** Title Case; the Settings Material Style option. */
  label: string;
  /** Whether `apply` can run on this model. Register any texture it loads in `resources`. */
  accepts(gltf: GLTF, resources: ModelResources): Promise<boolean>;
  apply(context: RenderContext): Promise<RendererHandle>;
  /** Reveal progress for the handle `apply` returned: 0 = nothing shown, 1 = fully shown. */
  materialize(handle: RendererHandle, value: number): void;
  /** Clip roles for the models this renderer is built for; absent = core's neutral names. */
  clips?: ClipMap;
  /** Settings note when a pack names this renderer but `accepts` fails (Standard shows instead). */
  rejectNote?: string;
}

/** An addon's default export. `marker` is "<addon marker prefix>:<id>" (see
 *  tools/release/zip-audit.mjs); the release zip audit refuses it, and core never spells the prefix out. */
export interface CharacterRendererAddon extends CharacterRendererModule {
  contract: number;
  marker: string;
}

/** The `@character-addons` map: module path → module, as `import.meta.glob` eager returns it. */
export type AddonModules = Readonly<Record<string, { default?: unknown }>>;

const ID = /^[a-z0-9-]{1,32}$/;

const standard: CharacterRendererModule = {
  id: STANDARD_RENDERER,
  label: "Standard",
  async accepts() { return true; },
  async apply(context) { return (await import("./style-standard")).applyStandard(context); },
  materialize(handle, value) { (handle as RendererHandle & { fade(value: number): void }).fade(value); },
};

const toonRenderer: CharacterRendererModule = {
  id: "toon",
  label: "Toon",
  async accepts() { return true; },
  async apply(context) { return (await import("./style-toon")).applyToon(context); },
  materialize(handle, value) { (handle as RendererHandle & { fade(value: number): void }).fade(value); },
};

/** Built-ins `auto` never picks: it takes an addon, else Standard. */
const BUILT_IN: ReadonlySet<CharacterRendererModule> = new Set([standard, toonRenderer]);

function validAddon(path: string, value: unknown): CharacterRendererAddon | null {
  const addon = value as Partial<CharacterRendererAddon> | undefined;
  if (!addon || typeof addon !== "object") {
    console.warn(`Character addon ${path} has no default export; skipped.`);
    return null;
  }
  if (addon.contract !== RENDERER_CONTRACT) {
    console.warn(`Character addon ${path} declares contract ${String(addon.contract)}, core is ${RENDERER_CONTRACT}; skipped.`);
    return null;
  }
  if (typeof addon.id !== "string" || !ID.test(addon.id) || addon.id === STANDARD_RENDERER || addon.id === AUTO_RENDERER
      || typeof addon.marker !== "string" || !addon.marker.endsWith(`:${addon.id}`)
      || typeof addon.label !== "string" || typeof addon.accepts !== "function"
      || typeof addon.apply !== "function" || typeof addon.materialize !== "function"
      || (addon.clips !== undefined && (!addon.clips || typeof addon.clips.roles !== "object" || !addon.clips.roles
        || typeof addon.clips.label !== "function"))) {
    console.warn(`Character addon ${path} does not match the renderer interface; skipped.`);
    return null;
  }
  return addon as CharacterRendererAddon;
}

/** Registry over a module map; exported for tests, the app uses `renderers()`. */
export function buildRegistry(modules: AddonModules): CharacterRendererModule[] {
  const list: CharacterRendererModule[] = [standard, toonRenderer];
  for (const path of Object.keys(modules).sort()) {
    const addon = validAddon(path, modules[path]?.default);
    if (!addon) continue;
    if (list.some((r) => r.id === addon.id)) {
      console.warn(`Character addon ${path} repeats renderer id ${addon.id}; skipped.`);
      continue;
    }
    list.push(addon);
  }
  return list;
}

let registry: CharacterRendererModule[] | null = null;

/** Every installed renderer, `standard` first, keyed by id. */
export function renderers(): readonly CharacterRendererModule[] {
  return registry ??= buildRegistry(addons);
}

export function findRenderer(id: string, list: readonly CharacterRendererModule[] = renderers()): CharacterRendererModule | null {
  return list.find((r) => r.id === id) ?? null;
}

/** `auto` = first addon whose `accepts` passes, else Standard; a named id that is not installed
 *  or does not accept the model = Standard plus a note. Never throws for a missing texture set. */
export async function chooseMaterialStyle(
  preference: MaterialPreference, gltf: GLTF, resources: ModelResources,
  list: readonly CharacterRendererModule[] = renderers(),
): Promise<{ style: CharacterRendererModule; note: string | null }> {
  const fallback = { style: list[0] ?? standard, note: null };
  // A throwing `accepts` (or a failed lazy import inside it) counts as false; `apply` failures stay errors.
  const accepts = async (r: CharacterRendererModule): Promise<boolean> => {
    try { return await r.accepts(gltf, resources); } catch (error) {
      console.warn(`Character renderer ${r.id} failed while checking the model; treated as not accepting.`, error);
      return false;
    }
  };
  if (preference === STANDARD_RENDERER) return fallback;
  if (preference === AUTO_RENDERER) {
    for (const r of list) {
      if (!BUILT_IN.has(r) && await accepts(r)) return { style: r, note: null };
    }
    return fallback;
  }
  const named = findRenderer(preference, list);
  if (!named) return { ...fallback, note: NOT_INSTALLED };
  if (await accepts(named)) return { style: named, note: null };
  return { ...fallback, note: named.rejectNote ?? null };
}

function codeOf(clipName: string): string {
  const at = clipName.lastIndexOf("_");
  return at < 0 ? clipName : clipName.slice(at + 1);
}

/** Core's names when no installed renderer knows the model's clips: a clip named after the role
 *  (any case, optionally after a "_" prefix) plays it; idle falls back to the first clip. */
export const NEUTRAL_CLIPS: ClipMap = { roles: {}, label: () => null };

/** The clip map for a model: the chosen renderer's if it names one of the model's clips, else the
 *  first installed renderer's that does, else NEUTRAL_CLIPS. Keeps a pack's clip behaviour when
 *  its model falls back to Standard. */
export function clipMapFor(
  chosen: CharacterRendererModule, clipNames: readonly string[],
  list: readonly CharacterRendererModule[] = renderers(),
): ClipMap {
  const codes = new Set(clipNames.map(codeOf));
  const fits = (r: CharacterRendererModule) => !!r.clips && Object.values(r.clips.roles).some((code) => codes.has(code!));
  return [chosen, ...list].find(fits)?.clips ?? NEUTRAL_CLIPS;
}

/** The clip that plays `role` under `map`, or null. Neutral idle falls back to the first clip. */
export function clipForRole<C extends { name: string }>(map: ClipMap, role: ClipRole, clips: readonly C[]): C | null {
  const code = map.roles[role];
  const hit = code !== undefined
    ? clips.find((clip) => codeOf(clip.name) === code)
    : clips.find((clip) => clip.name.toLowerCase() === role || codeOf(clip.name).toLowerCase() === role);
  if (hit) return hit;
  return role === "idle" ? clips[0] ?? null : null;
}

/** Menu label for a clip: the map's label, else the clip name. */
export function clipLabelFor(map: ClipMap, clipName: string): string {
  return map.label(clipName) ?? clipName;
}
