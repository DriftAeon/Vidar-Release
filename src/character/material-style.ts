// The material style slot: one interface, two adapters. Cel is
// the vendored cel shader (style-cel.ts); Standard renders the GLB's own materials under a
// light rig (style-standard.ts). The renderer asks `chooseMaterialStyle` once per load and
// then only talks to the returned handle, so it never branches on the style.
//
// `auto` picks Cel when the model carries the cel textures, else Standard. A pack that says
// `cel` on a model without them renders Standard with a note for its Settings row. Never throws
// for a missing texture set.
import type * as T from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { CharacterLighting, MaterialPreference } from "./catalog";
import { hasCelTextures, type ModelResources } from "./materials";
import { celStyle } from "./style-cel";
import { standardStyle } from "./style-standard";

interface StyleContext {
  gltf: GLTF;
  resources: ModelResources;
  lighting: CharacterLighting;
  /** The arena scene, for a style that needs scene lights; the handle removes them. */
  scene: T.Scene;
}

/** What the renderer drives after `apply`. */
export interface StyleHandle {
  /** Reveal progress, 0 = nothing shown, 1 = fully shown. Called every materialize frame. */
  materialize(value: number): void;
  /** The reveal finished; drop anything that only served it. */
  settle(): void;
  /** Remove anything added outside the model root (lights). Materials are the renderer's. */
  dispose(): void;
}

export interface MaterialStyle {
  apply(context: StyleContext): Promise<StyleHandle>;
}

const NO_CEL_TEXTURES = "No Cel Textures, Showing Standard";

export async function chooseMaterialStyle(
  preference: MaterialPreference, gltf: GLTF, resources: ModelResources,
): Promise<{ style: MaterialStyle; note: string | null }> {
  if (preference === "standard") return { style: standardStyle, note: null };
  if (await hasCelTextures(gltf, resources)) return { style: celStyle, note: null };
  return { style: standardStyle, note: preference === "cel" ? NO_CEL_TEXTURES : null };
}
