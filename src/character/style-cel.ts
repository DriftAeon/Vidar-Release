// Cel adapter for the material style slot: the vendored cel shader (materials.ts) plus the
// cel-only pieces of the reveal that used to sit inline in renderer.ts — the leading
// wireframe pass, the materialize uniform, outline fade-in, and the eye-shine hold.
import * as T from "three";
import { applyCharacterMaterials } from "./materials";
import type { MaterialStyle, StyleHandle } from "./material-style";

export const celStyle: MaterialStyle = {
  async apply({ gltf, resources, lighting }): Promise<StyleHandle> {
    const materialize = { value: 0 };
    await applyCharacterMaterials(gltf, resources, lighting, materialize);
    const root = gltf.scene;

    // Leading wireframe pass over every cel mesh: green lines sparkle ahead of the
    // solid reveal and fade as it lands. Skeleton-shared clones,
    // so the skinned animation drives them for free.
    const wireMaterial = new T.ShaderMaterial({
      uniforms: { uMaterialize: materialize },
      vertexShader: `
        #include <common>
        #include <skinning_pars_vertex>
        varying vec3 vWireWorld;
        void main() {
          #include <begin_vertex>
          #include <skinbase_vertex>
          #include <skinning_vertex>
          vec4 wp = modelMatrix * vec4(transformed, 1.0);
          vWireWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform float uMaterialize;
        varying vec3 vWireWorld;
        void main() {
          float fade = 1.0 - smoothstep(0.72, 0.98, uMaterialize);
          if (fade <= 0.001) discard;
          vec3 cell = floor(vWireWorld * 9.0);
          float n = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
          float t = min(uMaterialize * 1.3 - 0.12, 1.0);
          if (n > t) discard;
          float scan = 0.55 + 0.45 * sin(gl_FragCoord.y * 1.6 - uMaterialize * 28.0);
          gl_FragColor = vec4(vec3(0.25, 1.0, 0.6) * scan, fade);
        }`,
      wireframe: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false,
    });
    resources.materials.add(wireMaterial);
    const wireMeshes: T.Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof T.Mesh)) return;
      const material = object.material as T.Material;
      if (!(material instanceof T.ShaderMaterial) || material.userData.vidarMaterialize !== materialize) return;
      const wire: T.Mesh | T.SkinnedMesh = object instanceof T.SkinnedMesh
        ? new T.SkinnedMesh(object.geometry, wireMaterial)
        : new T.Mesh(object.geometry, wireMaterial);
      if (wire instanceof T.SkinnedMesh && object instanceof T.SkinnedMesh) {
        wire.bind(object.skeleton, object.bindMatrix);
      }
      wire.frustumCulled = false;
      object.add(wire);
      wireMeshes.push(wire);
    });
    // Eye shine is additive and unmarked by the materialize patch, so without this it
    // glows alone on the blank stage; hidden until the reveal flips it mid-melt.
    const eyeMeshes: T.Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof T.Mesh)) return;
      const name = (object.material as T.Material).name;
      if (name === "eye_L" || name === "eye_R") {
        object.visible = false; // the renderer's first resize renders before the first tick
        eyeMeshes.push(object);
      }
    });
    const outlines = [...resources.materials].filter((material) => material.name === "outline");
    // The outline hull fades in from opacity 0; writing depth while it is still invisible
    // punches its silhouette through the floor and dome drawn after it (Terriermon, 10-06).
    outlines.forEach((material) => {
      material.transparent = true;
      material.opacity = 0;
      material.depthWrite = false;
    });

    return {
      materialize(value) {
        materialize.value = value;
        outlines.forEach((material) => { material.opacity = value; });
        // 0.85 lands inside the green-to-cel melt, so the pop is masked by the scanlines.
        if (value >= 0.85) eyeMeshes.forEach((mesh) => { mesh.visible = true; });
      },
      settle() {
        // The solid cel pass carries the character from here; the wire clones only
        // cost vertex skinning while they draw, so switch them off for good.
        wireMeshes.forEach((wire) => { wire.visible = false; });
        outlines.forEach((material) => { material.depthWrite = true; });
      },
      dispose() {},
    };
  },
};
