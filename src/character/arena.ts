import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createHomeSphere } from "./home-sphere";

export type CharacterArena = ReturnType<typeof createCharacterArena>;

/** Panel-owned stage. Character disposal must never dispose these resources. */
export function createCharacterArena(host: HTMLElement, onError: (message: string) => void) {
  // The dome makes the canvas opaque, so the panel CSS background behind it no longer
  // needs to show through; alpha clearing stays for the moment the sphere hasn't mounted.
  const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.NoToneMapping;
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute("aria-label", "Character arena");
  const scene = new T.Scene();
  const homeSphere = createHomeSphere(scene);
  const clock = new T.Clock();
  const camera = new T.PerspectiveCamera(35, 1, 0.01, 1000);
  camera.position.set(0, 2, 8);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.minPolarAngle = 0.01;
  controls.maxPolarAngle = 1.5;
  controls.maxDistance = 12;
  controls.enableDamping = false;
  controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.PAN, RIGHT: null };
  controls.update();
  let disposed = false;
  let contextLost = false;
  let intersecting = true;
  const listeners = new AbortController();
  const render = () => {
    if (!disposed && !contextLost && !document.hidden && intersecting && host.clientWidth > 0 && host.clientHeight > 0) {
      // Ties mote movement to this render path rather than a second RAF loop; they
      // only advance on controls changes, resizes and other explicit renders, so they
      // sit still while the character's own animation tick draws directly (accepted).
      homeSphere.tick(clock.getElapsedTime());
      renderer.render(scene, camera);
    }
  };
  const resize = () => {
    if (disposed || contextLost || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    homeSphere.resize(renderer.domElement.height, camera.fov);
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
    host, renderer, scene, camera, controls, render, homeSphere, clock,
    get unavailable() { return disposed || contextLost; },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.abort();
      sizing.disconnect();
      visibility.disconnect();
      controls.removeEventListener("change", render);
      controls.dispose();
      homeSphere.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
