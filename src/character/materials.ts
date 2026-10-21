// The cel material path: models that carry the vendored cel shader's textures. Source,
// provenance, and documented local corrections live in vendor/dsts. The renderer reaches
// this only through the material style slot (material-style.ts → style-cel.ts).
import * as T from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { buildChrCelVertex, buildChrCelFragment } from "./vendor/dsts/effects/chrCel.glsl";
import { buildEyeShineVertex, buildEyeShineFragment, eyeShineMatDefines } from "./vendor/dsts/effects/eyeShine.glsl";
import { bakeEyeOverlay } from "./vendor/dsts/modelViewer/eyeOverlayBake";
import { celClutFromGltf } from "./vendor/dsts/modelViewer/celClut";
import { computeLightingRig } from "./vendor/dsts/modelViewer/lightingRig";
import { getDstsExtras, getDstsUniform } from "./vendor/dsts/modelViewer/shaderRegistry";
import { softenCelRamp } from "./cel-ramp";
import { padAtlasTexture } from "./atlas-padding";
import { entryFor } from "./model-cache";
import type { CharacterLighting } from "./catalog";

function softLightingTexture(original: T.Texture): T.DataTexture {
  const image = original.image as ImageBitmap;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the character lighting.");
  // The reference shader always samples V=0.5; the embedded ramps are V-flat.
  context.drawImage(image, 0, Math.floor(image.height / 2), image.width, 1, 0, 0, image.width, 1);
  const data = softenCelRamp(context.getImageData(0, 0, image.width, 1).data);
  const texture = new T.DataTexture(data, image.width, 1, T.RGBAFormat);
  texture.name = `${original.name}:soft-cel`;
  texture.colorSpace = T.NoColorSpace;
  texture.wrapS = texture.wrapT = T.ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = T.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

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

/** Tamers-style build-up: quantized world-space cells reveal in
 *  noise order behind a glowing green wavefront with scanlines; the green then melts
 *  into the cel output rather than snapping. uMaterialize 0 = void,
 *  1 = the untouched cel output. Patched onto the assembled shader string here rather
 *  than in vendor/dsts, which stays a clean transcription of the game's program. */
function patchMaterialize(fragment: string): string {
  const probe = "gl_FragColor = vec4(max(color, vec3(0.0)), outAlpha);";
  if (!fragment.includes(probe)) throw new Error("The cel fragment shader changed upstream; the materialize patch no longer applies.");
  return `uniform float uMaterialize;\n${fragment}`.replace(probe, `
  if (uMaterialize < 0.999) {
    vec3 cell = floor(vWorldPos * 9.0);
    float n = fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
    float t = uMaterialize * 1.3 - 0.3;
    if (n > t) discard;
    // Tiles come in as solid green (scanlines only); once the reveal finishes
    // (t hits 1.0 at uMaterialize ~0.77) the digi layer melts off globally -
    // cel color is underneath the whole time.
    float settle = 1.0 - smoothstep(0.78, 0.99, uMaterialize);
    float scan = 0.6 + 0.4 * sin(gl_FragCoord.y * 1.6 - uMaterialize * 28.0);
    vec3 digi = vec3(0.20, 1.0, 0.55) * (0.35 + 0.65 * scan);
    gl_FragColor = vec4(mix(max(color, vec3(0.0)), digi, settle), outAlpha);
    return;
  }
${probe}`);
}

/** Whether `applyCharacterMaterials` can run on this model without throwing: the two cel
 *  ramps are embedded, every mesh is a single-material skinned mesh, and each material has
 *  its authored slot (spec mask for the body, overlay mask for the eyes) plus a map. The
 *  material style slot (material-style.ts) asks this for `auto`, and for `cel` to fall back.
 *  Every texture the probe loads is registered for disposal. */
export async function hasCelTextures(gltf: GLTF, resources: ModelResources): Promise<boolean> {
  const textures = await gltf.parser.getDependencies("texture") as T.Texture[];
  textures.forEach((texture) => resources.textures.add(texture));
  if (!(await celClutFromGltf(gltf))) return false;
  let ok = true;
  let meshes = 0;
  gltf.scene.traverse((object) => {
    if (!ok || !(object instanceof T.Mesh)) return;
    meshes += 1;
    if (Array.isArray(object.material) || !(object instanceof T.SkinnedMesh)) { ok = false; return; }
    const material = object.material as T.MeshStandardMaterial;
    if (material.name === "outline") return;
    const slot = material.name === "eye_L" || material.name === "eye_R" ? "OverlayMaskSampler" : "BackBufferSampler";
    const index = getDstsExtras(material)?.texture_indices?.[slot];
    if (!material.map || index === undefined || !textures[index]) ok = false;
  });
  return ok && meshes > 0;
}

export async function applyCharacterMaterials(
  gltf: GLTF, resources: ModelResources, lighting: CharacterLighting, materialize: { value: number } = { value: 1 },
): Promise<void> {
  collectResources(gltf.scene, resources);
  // Includes orphaned DSTS textures which standard glTF materials never bind.
  const textures = await gltf.parser.getDependencies("texture") as T.Texture[];
  textures.forEach((texture) => resources.textures.add(texture));
  // Bind each material's authored slots: texture ordering differs across models,
  // and separate meshes in one model can use different specular masks.
  const textureFor = (material: T.Material, slot: string): T.Texture => {
    const index = getDstsExtras(material)?.texture_indices?.[slot];
    const texture = index === undefined ? undefined : textures[index];
    if (!texture) throw new Error(`The character material is missing its ${slot} texture.`);
    return texture;
  };
  try {
    await bakeEyeOverlay(gltf);
  } finally {
    // The baker replaces maps, including when it fails partway through.
    collectResources(gltf.scene, resources);
  }
  const clut = await celClutFromGltf(gltf);
  if (!clut) throw new Error("The model is missing its cel-shading textures.");
  // Keep the authored neutral/cool ramp colors, with gentler shadow boundaries.
  clut.key = softLightingTexture(clut.key);
  resources.textures.add(clut.key);
  clut.fill = softLightingTexture(clut.fill);
  resources.textures.add(clut.fill);

  // Each character can lift shadows without altering the other characters.
  const hemisphere = new T.HemisphereLight(0xffffff, 0xd7d7dc, lighting.ambient);
  const key = new T.DirectionalLight(0xffffff, lighting.key);
  key.position.set(3, 5, 5);
  const fill = new T.DirectionalLight(0xffffff, lighting.fill);
  fill.position.set(-3, 1, -2);
  const rig = computeLightingRig([hemisphere, key, fill]);
  const vectors = (values: Float32Array) => Array.from({ length: values.length / 3 }, (_, i) => new T.Vector3().fromArray(values, i * 3));

  // Extend the GLB atlases past their island edges so mips never sample padding.
  // Baked canvases are composed per mesh and skipped.
  const atlasMeshes = new Map<T.Texture, T.Mesh[]>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof T.Mesh) || Array.isArray(object.material)) return;
    const map = (object.material as T.MeshStandardMaterial).map;
    if (!map || map.image instanceof HTMLCanvasElement || object.material.name === "outline"
        || object.material.name === "eye_L" || object.material.name === "eye_R") return;
    atlasMeshes.set(map, [...(atlasMeshes.get(map) ?? []), object]);
  });
  const paddedMaps = new Map<T.Texture, T.Texture>();
  for (const [map, meshes] of atlasMeshes) {
    const index = gltf.parser.associations.get(map)?.textures;
    const store = entryFor(gltf.parser)?.padded;
    const padded = padAtlasTexture(map, meshes, store && index !== undefined ? { store, key: index } : undefined);
    resources.textures.add(padded);
    paddedMaps.set(map, padded);
  }

  gltf.scene.traverse((object) => {
    if (!(object instanceof T.Mesh)) return;
    if (Array.isArray(object.material)) throw new Error("Unexpected character material layout.");
    const original = object.material as T.MeshStandardMaterial;
    let next: T.Material;
    if (original.name === "outline") {
      const outline = new T.MeshBasicMaterial({ color: 0x18131c, side: T.FrontSide });
      outline.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", `
          #include <project_vertex>
          vec2 screenN = transformedNormal.xy;
          if (length(screenN) > 0.00001) {
            screenN = normalize(screenN);
            screenN.x /= projectionMatrix[1][1] / projectionMatrix[0][0];
            gl_Position.xy -= screenN * 0.0022 * gl_Position.w;
          }`);
      };
      outline.customProgramCacheKey = () => "vidar-cel-outline-v1";
      next = outline;
    } else if (original.name === "eye_L" || original.name === "eye_R") {
      const matcap = original.map!;
      matcap.colorSpace = T.NoColorSpace;
      matcap.needsUpdate = true;
      const mask = textureFor(original, "OverlayMaskSampler");
      mask.colorSpace = T.NoColorSpace;
      mask.needsUpdate = true;
      const tilt = getDstsUniform(original, "MetalicValue") ?? [0, 0];
      next = new T.ShaderMaterial({
        vertexShader: buildEyeShineVertex(), fragmentShader: buildEyeShineFragment(),
        defines: eyeShineMatDefines({ skinning: true, hasMatcap: true, hasEyeMask: true, hasEyeColor: true }),
        uniforms: {
          uMatcap: { value: matcap }, uEyeMask: { value: mask },
          uMatcapTilt: { value: new T.Vector2(tilt[0], tilt[1]) },
          uEyeMaskOffset: { value: new T.Vector2(0, 0) },
        },
        transparent: true, blending: T.AdditiveBlending, depthWrite: false,
      });
    } else {
      const map = paddedMaps.get(original.map!) ?? original.map!;
      const normal = original.normalMap;
      const defines: Record<string, string> = { USE_SKINNING: "", CHR_HAS_MAP: "", CHR_MAP_UV: String(map.channel), CHR_HAS_SPEC_MASK: "" };
      if (map.channel === 1) defines.USE_UV1 = "";
      if (map.channel === 2) defines.USE_UV2 = "";
      if (normal) { defines.CHR_HAS_NORMAL_MAP = ""; defines.USE_TANGENT = ""; }
      map.colorSpace = T.SRGBColorSpace;
      map.needsUpdate = true;
      next = new T.ShaderMaterial({
        vertexShader: buildChrCelVertex(), fragmentShader: patchMaterialize(buildChrCelFragment()), defines,
        lights: true,
        uniforms: Object.assign(T.UniformsUtils.merge([T.UniformsLib.lights]), {
          uMap: { value: map }, uMapOffset: { value: map.offset }, uMapRepeat: { value: map.repeat },
          uNormalMap: { value: normal }, uNormalScale: { value: original.normalScale },
          uSpecMap: { value: textureFor(original, "BackBufferSampler") }, uCLUT: { value: clut.key }, uCLUTFill: { value: clut.fill },
          uAlphaBlend: { value: 0 }, uHasCover: { value: 0 }, uProgramDithers: { value: 0 },
          uDiffuseAlpha: { value: new T.Vector4(1, 1, 1, 1) },
          uInnerGrowAColor: { value: new T.Vector3(0, 0, 0) },
          uInnerGrowBColor: { value: new T.Vector3(0, 0, 0) },
          uInnerGrowABase: { value: new T.Vector3(25, 5, 0.8) },
          uGlowBlend: { value: 1 }, uGlowRimScale: { value: 0 },
          uSH: { value: vectors(rig.shCoeffs) }, uShScale: { value: rig.shScale },
          uFill: { value: new T.Vector3().fromArray(rig.fillColor) },
          uLightDirs: { value: vectors(rig.lightDirs) }, uLightColors: { value: vectors(rig.lightColors) },
          uNumLights: { value: rig.numLights }, uFogColor: { value: new T.Vector3() }, uFogAmount: { value: 0 },
          uMaterialize: materialize,
        }),
      });
      // Marks this mesh for the renderer's wireframe-overlay pass (shared uniform identity).
      next.userData.vidarMaterialize = materialize;
    }
    next.name = original.name;
    object.material = next;
    resources.materials.add(next);
    // Skinned animation must not disappear behind bind-pose culling bounds.
    object.frustumCulled = false;
  });
}
