import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { CharacterArena } from "./arena";
import { collectResources, type ModelResources } from "./materials";
import { chooseMaterialStyle, clipForRole, clipLabelFor, clipMapFor, type RendererHandle } from "./renderer-registry";
import { modelDigest, tagModel } from "./model-cache";
import { characterRevision } from "./packs";
import { validateCharacterModel } from "./model";
import { lightingFor, type CharacterPack } from "./catalog";
import { clipPlayrate, type CharacterLoop, type CharacterOnce } from "./behavior";
import { validateView, type View } from "./view";

export interface CharacterRenderer {
  /** Empty for a still model: it sits in its rest pose. */
  clips: { name: string; label: string }[];
  /** "" for a still model. */
  initialClip: string;
  /** Set when the pack's material preference could not be honoured (Settings row note). */
  styleNote: string | null;
  selectClip(name: string): void;
  setLoop(role: CharacterLoop): void;
  playOnce(role: CharacterOnce, priority: number): void;
  setPlaying(playing: boolean): void;
  resetView(): void;
  captureView(): View;
  applyView(view: View, asDefault: boolean): void;
  dispose(): void;
}

export async function createCharacterRenderer(
  arena: CharacterArena, bytes: ArrayBuffer, signal: AbortSignal, onError: (message: string) => void,
  pack: CharacterPack, storedView?: unknown,
): Promise<CharacterRenderer> {
  validateCharacterModel(bytes, pack.name);
  signal.throwIfAborted();
  const resources: ModelResources = { materials: new Set(), textures: new Set(), geometries: new Set(), skeletons: new Set() };
  const { host, renderer, controls, scene, camera, clock } = arena;
  let mixer: T.AnimationMixer | undefined;
  let root: T.Group | undefined;
  let style: RendererHandle | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let intersectionObserver: IntersectionObserver | undefined;
  let frame = 0;
  let disposed = false;
  let playing = false;
  let intersecting = true;
  let contextLost = false;
  // Materialize-in driver state; declared here because dispose() can run from the
  // catch block before the driver below is defined.
  let materializeFrame = 0;
  let materializeStart = 0;
  let lastTime = 0;
  let down: { x: number; y: number; time: number; id: number } | null = null;
  const listeners = new AbortController();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    cancelAnimationFrame(materializeFrame);
    listeners.abort();
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    mixer?.stopAllAction();
    style?.dispose();
    const attached = root?.parent === scene;
    if (root) { root.removeFromParent(); collectResources(root, resources); mixer?.uncacheRoot(root); }
    resources.skeletons.forEach((skeleton) => skeleton.dispose());
    resources.geometries.forEach((geometry) => geometry.dispose());
    resources.materials.forEach((material) => material.dispose());
    const bitmaps = new Set<ImageBitmap>();
    resources.textures.forEach((texture) => {
      if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) bitmaps.add(texture.image);
      texture.dispose();
    });
    bitmaps.forEach((bitmap) => bitmap.close());
    if (attached) {
      renderer.domElement.setAttribute("aria-label", "Character arena");
      renderer.renderLists.dispose();
      arena.render();
    }
  }

  try {
    const manager = new T.LoadingManager();
    manager.setURLModifier((url) => {
      // BufferView PNGs become blob URLs inside GLTFLoader. The digest and URI
      // validation above run first (the digest is Rust's), so model data cannot nominate a URL.
      if (!url.startsWith("blob:")) throw new Error("External character assets are blocked.");
      return url;
    });
    const digest = await modelDigest(bytes);
    const gltf = await new GLTFLoader(manager).parseAsync(bytes, "");
    tagModel(gltf.parser, digest, characterRevision());
    root = gltf.scene;
    collectResources(root, resources);
    signal.throwIfAborted();
    // Renderer slot (renderer-registry.ts), decided here once; from now on this loop only
    // drives the handle (reveal progress, settle, dispose).
    const chosen = await chooseMaterialStyle(pack.material, gltf, resources);
    signal.throwIfAborted();
    const applied = await chosen.style.apply({ gltf, resources, lighting: lightingFor(pack), scene });
    style = applied;
    const reveal = (value: number) => chosen.style.materialize(applied, value);
    reveal(0); // resize() renders before the driver's first tick
    signal.throwIfAborted();

    if (arena.unavailable) throw new Error("The character arena is unavailable.");
    renderer.domElement.setAttribute("aria-label", `${pack.name} model viewer`);
    renderer.domElement.setAttribute("role", "img");
    renderer.domElement.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      contextLost = true;
      cancelAnimationFrame(frame);
      frame = 0;
    }, { signal: listeners.signal });

    scene.add(root);
    const clips = gltf.animations.filter((clip) => Number.isFinite(clip.duration) && clip.duration > 0);
    // A still model (no timed animations) sits in its rest pose with an empty clip list.
    const clipMap = clipMapFor(chosen.style, clips.map((clip) => clip.name));
    const initial: T.AnimationClip | null = clipForRole(clipMap, "idle", clips);
    let selected: T.AnimationClip | null = initial;
    let currentLoop: T.AnimationClip | null = initial;
    let manual = false;
    let reaction: T.AnimationAction | null = null;
    let reactionPriority = -Infinity;
    const missingOnce = new Set<string>();
    mixer = new T.AnimationMixer(root);
    const paced = (clip: T.AnimationClip): T.AnimationAction =>
      mixer!.clipAction(clip).reset().setEffectiveTimeScale(clipPlayrate(pack.playrate, clip.name));
    if (initial) paced(initial).play();
    mixer.update(0);
    root.updateMatrixWorld(true);

    const bounds = new T.Box3().setFromObject(root, true);
    const sphere = bounds.getBoundingSphere(new T.Sphere());
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error("The model has invalid bounds.");
    const radius = sphere.radius;
    camera.near = radius * 0.01;
    // Far plane (never inside the stage) and closest orbit come from the active stage (arena.ts).
    arena.fitSubject(radius);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    const distance = radius / Math.sin(T.MathUtils.degToRad(camera.fov / 2)) * 1.08;
    camera.position.copy(sphere.center).add(new T.Vector3(0, radius * 0.12, distance));
    controls.target.copy(sphere.center);
    // The stage's orbit clamp (arena.ts) stands rather than radius-derived values.
    controls.enableDamping = false;
    controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.PAN, RIGHT: null };
    controls.update();
    controls.saveState();

    // A per-character saved default (vidar.json `characterViews`) overrides the computed
    // framing above and becomes the reset target — applied before the first render (below).
    // A stored view that fails validation is logged, not thrown: the computed framing stands.
    if (storedView != null) {
      const validated = validateView(storedView);
      if (validated) {
        camera.position.set(...validated.position);
        camera.zoom = validated.zoom;
        camera.updateProjectionMatrix();
        controls.target.set(...validated.target);
        controls.update();
        controls.saveState();
      } else {
        onError(`The saved view for ${pack.name} is invalid; using the default framing.`);
      }
    }

    const visible = () => !disposed && !contextLost && !arena.unavailable && !document.hidden && intersecting && host.clientWidth > 0 && host.clientHeight > 0;
    function render(): void {
      if (visible()) {
        // Motes must also advance on this renderer's own animation tick
        // (below), not only arena.render's controls/resize path. Same clock as arena.ts,
        // one call site, still no second RAF loop.
        arena.tickStage(clock.getElapsedTime());
        renderer!.render(scene, camera);
      }
    }
    // 15 fps while the window is unfocused (visible but not in use), 60 otherwise; read each tick.
    const frameIntervalNow = () => (document.hasFocus() ? 1000 / 60 : 1000 / 15);
    let nextFrameTime = 0;
    function tick(now: number): void {
      frame = 0;
      if (!visible() || !playing) return;
      // A small tolerance avoids skipping alternate frames on a 60 Hz display.
      if (now >= nextFrameTime - 0.5) {
        mixer!.update(Math.min((now - lastTime) / 1000, 0.1));
        lastTime = now;
        render();
        const frameInterval = frameIntervalNow();
        nextFrameTime += frameInterval;
        // Do not queue catch-up renders after a slow frame.
        if (nextFrameTime < now) nextFrameTime = now + frameInterval;
      }
      frame = requestAnimationFrame(tick);
    }
    function syncActivity(): void {
      cancelAnimationFrame(frame);
      frame = 0;
      lastTime = performance.now();
      nextFrameTime = lastTime + frameIntervalNow();
      render();
      if (visible() && playing) frame = requestAnimationFrame(tick);
    }
    // Materialize-in driver: its own rAF chain so the build-up runs even while the
    // character is paused, then hands rendering back to the normal paths.
    const MATERIALIZE_MS = 1100;
    function driveMaterialize(now: number): void {
      materializeFrame = 0;
      if (disposed || contextLost || !materializeStart) return;
      const linear = Math.min((now - materializeStart) / MATERIALIZE_MS, 1);
      const eased = linear * linear * (3 - 2 * linear);
      reveal(eased);
      if (linear >= 1) style!.settle();
      render();
      if (linear < 1) materializeFrame = requestAnimationFrame(driveMaterialize);
      else materializeStart = 0;
    }
    const resize = () => {
      if (!visible()) { syncActivity(); return; }
      renderer!.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer!.setSize(host.clientWidth, host.clientHeight, false);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      syncActivity();
    };
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    intersectionObserver = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      if (!intersecting) consumeReaction();
      if (intersecting) resize(); else syncActivity();
    });
    intersectionObserver.observe(host);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) consumeReaction();
      syncActivity();
    }, { signal: listeners.signal });
    // Regaining focus returns to 60 fps at once instead of waiting out a 15 fps slot.
    window.addEventListener("focus", syncActivity, { signal: listeners.signal });

    function playSelected(force = false): void {
      if (!force && !reaction && currentLoop === selected) return;
      reaction = null;
      reactionPriority = -Infinity;
      mixer!.stopAllAction();
      if (selected) paced(selected).setLoop(T.LoopRepeat, Infinity).play();
      currentLoop = selected;
      mixer!.update(0);
      render();
    }
    function consumeReaction(): void {
      if (!reaction) return;
      reaction = null;
      reactionPriority = -Infinity;
      playSelected(true);
    }
    function resolveLoop(role: CharacterLoop): T.AnimationClip | null {
      return clipForRole(clipMap, role, clips) ?? initial;
    }
    function startOnce(role: CharacterOnce, priority: number): void {
      if (!playing || manual || (reaction && reactionPriority >= priority)) return;
      const clip = clipForRole(clipMap, role, clips);
      if (!clip) {
        if (!missingOnce.has(role)) {
          missingOnce.add(role);
          if (clips.length) console.warn(`${pack.name} has no ${role} animation.`);
        }
        return;
      }
      mixer!.stopAllAction();
      currentLoop = null;
      reactionPriority = priority;
      reaction = paced(clip).setLoop(T.LoopOnce, 1).play();
      reaction.clampWhenFinished = true;
    }
    mixer.addEventListener("finished", (event) => { if (event.action === reaction) playSelected(true); });
    const raycaster = new T.Raycaster();
    const react = (x: number, y: number) => {
      if (!playing || manual) return;
      const rect = renderer!.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new T.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1), camera);
      if (!raycaster.intersectObject(root!, true).length) return;
      startOnce("yes", 0);
    };
    renderer.domElement.addEventListener("pointerdown", (event) => {
      down = event.button === 0 && event.isPrimary
        ? { x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId } : null;
    }, { signal: listeners.signal });
    renderer.domElement.addEventListener("pointermove", (event) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) down = null;
    }, { signal: listeners.signal });
    renderer.domElement.addEventListener("pointerup", (event) => {
      if (down && down.id === event.pointerId && performance.now() - down.time < 450
          && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 5) react(event.clientX, event.clientY);
      down = null;
    }, { signal: listeners.signal });
    renderer.domElement.addEventListener("pointercancel", () => { down = null; }, { signal: listeners.signal });
    signal.addEventListener("abort", dispose, { once: true, signal: listeners.signal });
    // The arena stays mounted while only this character digitizes in.
    resize();
    materializeStart = performance.now();
    materializeFrame = requestAnimationFrame(driveMaterialize);
    return {
      clips: clips.map((clip) => ({ name: clip.name, label: clipLabelFor(clipMap, clip.name) })), initialClip: initial?.name ?? "",
      styleNote: chosen.note,
      selectClip(name) {
        if (disposed) return;
        const clip = clips.find((item) => item.name === name);
        if (clip) {
          if (manual && selected === clip) return;
          manual = true;
          selected = clip;
          playSelected(true);
        }
      },
      setLoop(role) {
        if (disposed) return;
        manual = false;
        selected = resolveLoop(role);
        if (!reaction) playSelected();
      },
      playOnce(role, priority) { if (!disposed) startOnce(role, priority); },
      setPlaying(value) {
        if (!disposed) {
          playing = value;
          if (!playing) consumeReaction();
          syncActivity();
        }
      },
      resetView() { if (!disposed) { controls!.reset(); render(); } },
      captureView() {
        return {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls!.target.x, controls!.target.y, controls!.target.z],
          zoom: camera.zoom,
        };
      },
      applyView(view, asDefault) {
        if (disposed) return;
        camera.position.set(...view.position);
        camera.zoom = view.zoom;
        camera.updateProjectionMatrix();
        controls!.target.set(...view.target);
        controls!.update();
        if (asDefault) controls!.saveState();
        render();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
