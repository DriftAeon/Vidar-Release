// Model resource bookkeeping shared by every renderer: what a loaded model owns, so
// renderer.ts can dispose it. Renderer-specific material code lives with its renderer
// (style-standard.ts, or an addon under addons/<id>/).
import * as T from "three";

export interface ModelResources {
  materials: Set<T.Material>;
  textures: Set<T.Texture>;
  geometries: Set<T.BufferGeometry>;
  skeletons: Set<T.Skeleton>;
}

export function collectResources(root: T.Object3D, resources: ModelResources): void {
  root.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    resources.geometries.add(object.geometry);
    if (object instanceof T.SkinnedMesh) resources.skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      resources.materials.add(material);
      for (const value of Object.values(material)) if (value instanceof T.Texture) resources.textures.add(value);
      if (material instanceof T.ShaderMaterial) {
        for (const { value } of Object.values(material.uniforms)) if (value instanceof T.Texture) resources.textures.add(value);
      }
    }
  });
}
