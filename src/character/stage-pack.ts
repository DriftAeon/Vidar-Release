// Stage packs in the scene: builds a StageFactory (stage.ts) from a validated stage.json
// (stage-pick.ts `StageDef`), and resolves the vidar.json `characterStage` pick to a stage,
// falling back to the built-in default with STAGE_FALLBACK_NOTE.
//
// Data only. The bytes come from Rust (`read_stage_asset`: bounded, no leaf link, magic
// checked); a glb background then passes the same structure check as a character model and
// loads with blob-only URLs, so the file cannot nominate one. It draws unlit (MeshBasic): the
// arena has no lights of its own, and the character renderer's lights are its own.
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { invoke } from "../ipc";
import { loadConfig } from "../config";
import { validateCharacterModel } from "./model";
import { defaultStage } from "./home-sphere";
import { chooseStage, clampMinDistance, imageMime, STAGE_FALLBACK_NOTE, type StageDef } from "./stage-pick";
import type { StageFactory, StageOrbit } from "./stage";

/** Same polar clamp as the default stage: no view from under the floor. */
const POLAR = { minPolarAngle: 0.01, maxPolarAngle: 1.5 };
const DEFAULT_FAR = 2000;
const DEFAULT_MAX_DISTANCE = 12;

type Disposable = { dispose(): void };

async function loadImage(bytes: ArrayBuffer): Promise<T.Texture> {
  const mime = imageMime(bytes);
  if (!mime) throw new Error("The stage image is not a png, jpg or webp file.");
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const texture = await new T.TextureLoader().loadAsync(url);
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function unlit(source: T.Material): T.MeshBasicMaterial {
  const lit = source as T.Material & { map?: T.Texture | null; color?: T.Color; vertexColors?: boolean };
  return new T.MeshBasicMaterial({
    map: lit.map ?? null,
    color: lit.color ?? 0xffffff,
    vertexColors: lit.vertexColors ?? false,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: source.alphaTest,
    side: source.side,
  });
}

async function loadSet(bytes: ArrayBuffer, label: string, owned: Disposable[]): Promise<T.Group> {
  validateCharacterModel(bytes, `${label} stage`);
  const manager = new T.LoadingManager();
  manager.setURLModifier((url) => {
    // BufferView images become blob URLs inside GLTFLoader; the structure check above has
    // already refused any URI, so nothing else may load.
    if (!url.startsWith("blob:")) throw new Error("External stage assets are blocked.");
    return url;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(bytes, "");
  const swapped = new Map<T.Material, T.MeshBasicMaterial>();
  const textures = new Set<T.Texture>();
  gltf.scene.traverse((object) => {
    const part = object as T.Object3D & { geometry?: T.BufferGeometry; material?: T.Material | T.Material[] };
    if (part.geometry) owned.push(part.geometry);
    if (!part.material) return;
    const convert = (m: T.Material) => {
      let basic = swapped.get(m);
      if (!basic) {
        for (const value of Object.values(m)) if (value instanceof T.Texture) textures.add(value);
        basic = unlit(m);
        swapped.set(m, basic);
      }
      return basic;
    };
    part.material = Array.isArray(part.material) ? part.material.map(convert) : convert(part.material);
  });
  swapped.forEach((basic, source) => { source.dispose(); owned.push(basic); });
  textures.forEach((texture) => owned.push(texture));
  return gltf.scene;
}

/** Reads and builds every part the stage names; a failed part fails the whole stage. */
export async function loadPackStage(def: StageDef): Promise<StageFactory> {
  const owned: Disposable[] = [];
  const free = () => { owned.forEach((resource) => resource.dispose()); owned.length = 0; };
  try {
    // Settled, not all: a part that fails must not leave the other still loading into `owned`.
    const parts = await Promise.allSettled([
      def.background.image
        ? invoke("read_stage_asset", { id: def.id, part: "image" }).then(loadImage).then((texture) => { owned.push(texture); return texture; })
        : Promise.resolve(null),
      def.background.glb
        ? invoke("read_stage_asset", { id: def.id, part: "glb" }).then((bytes) => loadSet(bytes, def.label, owned))
        : Promise.resolve(null),
    ]);
    const failed = parts.find((part) => part.status === "rejected");
    if (failed) throw failed.reason;
    const [image, set] = parts.map((part) => (part.status === "fulfilled" ? part.value : null)) as [T.Texture | null, T.Group | null];
    const colour = def.colour ? new T.Color(def.colour) : null;
    const orbit: StageOrbit = { ...POLAR, maxDistance: def.camera?.maxDistance ?? DEFAULT_MAX_DISTANCE };
    // After the default max is applied, so a lone minDistance can never sit above it.
    if (def.camera?.minDistance !== undefined) orbit.minDistance = clampMinDistance(def.camera.minDistance, orbit.maxDistance);
    return {
      create(scene) {
        scene.background = image ?? colour;
        scene.fog = def.fog ? new T.Fog(colour ?? 0x000000, def.fog.near, def.fog.far) : null;
        if (set) scene.add(set);
        return {
          far: def.camera?.far ?? DEFAULT_FAR,
          orbit,
          dispose() {
            if (set) scene.remove(set);
            scene.background = null;
            scene.fog = null;
            free();
          },
        };
      },
      discard: free,
    };
  } catch (error) {
    free();
    throw error;
  }
}

/** The stage the pick names, or the built-in default (with the note when the pick could not
 *  be used: not listed, broken, the listing failed, or a part failed to load). */
export async function resolveStage(): Promise<{ factory: StageFactory; note: string | null }> {
  const pick = (await loadConfig()).config.characterStage;
  if (typeof pick !== "string" || !pick.trim()) return { factory: defaultStage, note: null };
  const list = await invoke("list_stages").catch((error) => {
    console.warn("stages: list failed", error);
    return null;
  });
  const choice = chooseStage(pick, list);
  if (choice.kind === "default") return { factory: defaultStage, note: choice.note };
  try {
    return { factory: await loadPackStage(choice.stage), note: null };
  } catch (error) {
    console.warn(`stage ${choice.stage.id}: load failed`, error);
    return { factory: defaultStage, note: STAGE_FALLBACK_NOTE };
  }
}
