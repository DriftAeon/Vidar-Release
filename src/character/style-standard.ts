// The built-in `standard` renderer (renderer-registry.ts): the GLB's own materials as authored.
// The arena has no lights of its own, so this adds a hemisphere + key + fill rig driven by the
// pack's lighting (or DEFAULT_LIGHTING) and removes it on dispose. The reveal is an opacity fade.
import * as T from "three";
import type { RenderContext, RendererHandle } from "./renderer-registry";

interface Faded { material: T.Material; opacity: number; transparent: boolean }

export async function applyStandard({ gltf, lighting, scene }: RenderContext): Promise<RendererHandle & { fade(value: number): void }> {
  const rig = new T.Group();
  rig.name = "vidar-standard-lights";
  const hemisphere = new T.HemisphereLight(0xffffff, 0xd7d7dc, lighting.ambient);
  const key = new T.DirectionalLight(0xffffff, lighting.key);
  key.position.set(3, 5, 5);
  const fill = new T.DirectionalLight(0xffffff, lighting.fill);
  fill.position.set(-3, 1, -2);
  rig.add(hemisphere, key, fill);
  scene.add(rig);

  const faded: Faded[] = [];
  const seen = new Set<T.Material>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    // Skinned animation must not disappear behind bind-pose culling bounds.
    object.frustumCulled = false;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (seen.has(material)) continue;
      seen.add(material);
      faded.push({ material, opacity: material.opacity, transparent: material.transparent });
      material.transparent = true;
      material.opacity = 0;
      material.needsUpdate = true;
    }
  });

  return {
    fade(value) {
      faded.forEach((f) => { f.material.opacity = f.opacity * value; });
    },
    settle() {
      faded.forEach((f) => {
        f.material.opacity = f.opacity;
        if (f.material.transparent !== f.transparent) {
          f.material.transparent = f.transparent;
          f.material.needsUpdate = true;
        }
      });
    },
    dispose() {
      rig.removeFromParent();
      hemisphere.dispose();
      key.dispose();
      fill.dispose();
    },
  };
}
