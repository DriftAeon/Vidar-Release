import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Resolve embedded glTF textures by their `images[].name`. The exporter names
// the bytes it bakes in (eye atlases, the chr_env cube faces, the toon CLUTs);
// GLTFLoader leaves `texture.name` empty, so the canonical stem lives only on
// the image. Name-keyed lookup survives gltfpack's texture renumber/dedup on the
// delivery tree (index-keyed pointers would not) - the same idiom as
// `stampTextureNames`.

interface GltfImageJson {
  images?: { name?: string }[];
  textures?: { source?: number }[];
}

/** The glTF texture index whose image is named `name`, or null if no embedded
 *  image carries that name (e.g. a model exported before the bytes were baked
 *  in). Feed the result to `gltf.parser.getDependency('texture', idx)`. */
export function textureIndexForImageName(gltf: GLTF, name: string): number | null {
  const json = gltf.parser.json as GltfImageJson;
  const imgIdx = (json.images ?? []).findIndex((im) => im.name === name);
  if (imgIdx < 0) return null;
  const texIdx = (json.textures ?? []).findIndex((t) => t.source === imgIdx);
  return texIdx >= 0 ? texIdx : null;
}
