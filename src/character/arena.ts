import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { defaultStage } from "./home-sphere";
import type { Stage, StageFactory } from "./stage";
import { cameraFar } from "./stage-pick";

export type CharacterArena = ReturnType<typeof createCharacterArena>;

/** The camera's far plane before any character is framed. */
const BASE_FAR = 1000;

/** Panel-owned stage. Character disposal must never dispose these resources. */
export function createCharacterArena(host: HTMLElement, onError: (message: string) => void, initialStage: StageFactory = defaultStage) {
  // The dome makes the canvas opaque, so the panel CSS background behind it no longer
  // needs to show through; alpha clearing stays for the moment the sphere hasn't mounted.
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.NoToneMapping;
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "Character arena");
  const scene = new T.Scene();
  let stage: Stage = initialStage.create(scene);
  // The framed character's bounding radius (renderer.ts), so a stage swap keeps its far plane.
  let subjectRadius: number | null = null;
  const clock = new T.Clock();
  const camera = new T.PerspectiveCamera(35, 1, 0.01, BASE_FAR);
  camera.position.set(0, 2, 8);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  // Orbit clamp and far bound come from the active stage.
  const applyStageBounds = () => {
    controls.minPolarAngle = stage.orbit.minPolarAngle;
    controls.maxPolarAngle = stage.orbit.maxPolarAngle;
    controls.maxDistance = stage.orbit.maxDistance;
    // The furthest orbit must never clip the character or the stage.
    if (subjectRadius !== null) {
      camera.far = cameraFar(subjectRadius * 100, stage.far, stage.orbit.maxDistance, subjectRadius);
      controls.minDistance = stage.orbit.minDistance ?? subjectRadius * 0.4;
    } else {
      camera.far = cameraFar(BASE_FAR, stage.far, stage.orbit.maxDistance, null);
      controls.minDistance = stage.orbit.minDistance ?? 0;
    }
    camera.updateProjectionMatrix();
  };
  applyStageBounds();
  controls.enableDamping = false;
  controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.PAN, RIGHT: null };
  controls.update();
  let disposed = false;
  let contextLost = false;
  let intersecting = true;
  const listeners = new AbortController();
  const tickStage = (elapsedSeconds: number) => stage.tick?.(elapsedSeconds);
  const render = () => {
    if (!disposed && !contextLost && !document.hidden && intersecting && host.clientWidth > 0 && host.clientHeight > 0) {
      // Ties mote movement to this render path rather than a second RAF loop; they
      // only advance on controls changes, resizes and other explicit renders, so they
      // sit still while the character's own animation tick draws directly (accepted).
      tickStage(clock.getElapsedTime());
      renderer.render(scene, camera);
    }
  };
  const resize = () => {
    if (disposed || contextLost || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    stage.resize?.(renderer.domElement.height, camera.fov);
    render();
  };
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
    onError("The graphics context was lost. Switch to another character and back to reload it.");
  }, { signal: listeners.signal });
  controls.addEventListener("change", render);
  const sizing = new ResizeObserver(resize);
  const visibility = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    if (intersecting) resize();
  });
  document.addEventListener("visibilitychange", resize, { signal: listeners.signal });
  host.append(renderer.domElement);
  sizing.observe(host);
  visibility.observe(host);
  resize();
  return {
    host, renderer, scene, camera, controls, render, clock, tickStage,
    get unavailable() { return disposed || contextLost; },
    /** A character was framed with this bounding radius: far plane and closest orbit follow it. */
    fitSubject(radius: number) {
      subjectRadius = radius;
      applyStageBounds();
    },
    /** Swaps the active stage; the camera keeps its place, clamped to the new orbit bounds. */
    setStage(next: StageFactory) {
      if (disposed) { next.discard?.(); return; }
      stage.dispose();
      stage = next.create(scene);
      applyStageBounds();
      controls.update();
      if (renderer.domElement.height > 0) stage.resize?.(renderer.domElement.height, camera.fov);
      renderer.renderLists.dispose();
      render();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      sizing.disconnect();
      visibility.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      stage.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
