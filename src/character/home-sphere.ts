import * as T from "three";
import type { StageFactory } from "./stage";

/**
 * The built-in default stage (`defaultStage`, the stage slot in stage.ts).
 * The "Cyber home" environment: an inside-out gridded dome, a faded platform with a
 * faint cell overlay, slow-rising motes, and a slow floor ripple (softened). The rest is ported from an earlier mock (`gridDome()`,
 * `homeFloor()`, `sparkles()`); this module owns every resource it creates and
 * disposes them on `dispose()`. Time only advances when the owner calls `tick()`
 * (from `arena.render()`), so this adds no second animation loop.
 */
const GRID_FN = "float gridLine(float p, float w) { return 1.0 - min(abs(fract(p - 0.5) - 0.5) / (fwidth(p) * w), 1.0); }";

const NAVY = { top: 0x0b1f45, bottom: 0x06122a, line: 0x2a6cff };
const DOME_RADIUS = 200;
const FLOOR_RADIUS = 40;
const FLOOR_COLOR = 0x0a1a38;
const OVERLAY = { color: 0x3c8cff, alpha: 0.26, cell: 1.25 };
const MOTE_COUNT = 260;
const MOTE_COLORS = [0x3cf0ff, 0x6fa8ff, 0xffffff];
const MOTE_DIM = 0.7;
const MOTE_RISE_PERIOD = 14;
const MOTE_RISE_SPEED = 0.25;
/** Floor ripple (r4 mock item 01): a ring leaves the feet every PERIOD s and runs out to REACH,
 *  its life envelope reaching 0 at both ends so the wrap never pops; the dome echo climbs the
 *  lower latitudes as the ring fades and is also back to 0 by the wrap. */
const RIPPLE = { period: 10, speed: 1.5, reach: 15, width: 0.6, floorGain: 0.9, domeGain: 0.5, hilite: 0x6fd0ff };
const RIPPLE_GLSL = `
const float R_SPEED = ${RIPPLE.speed.toFixed(3)}, R_REACH = ${RIPPLE.reach.toFixed(3)}, R_WIDTH = ${RIPPLE.width.toFixed(3)};
float rippleRadius(float phase) { return phase * R_SPEED; }
float rippleLife(float ringR) { return smoothstep(0.0, 1.5, ringR) * (1.0 - smoothstep(R_REACH * 0.6, R_REACH, ringR)); }
float echoLife(float ringR) { return smoothstep(R_REACH * 0.65, R_REACH * 0.9, ringR) * (1.0 - smoothstep(R_REACH * 0.9, R_REACH, ringR)); }`;
/** Smallest mote sprite in device pixels; below this they alias into sparkle. */
const MOTE_MIN_PX = 3;

function gridDome(): T.Mesh {
  const material = new T.ShaderMaterial({
    side: T.BackSide,
    uniforms: {
      top: { value: new T.Color(NAVY.top) },
      bottom: { value: new T.Color(NAVY.bottom) },
      line: { value: new T.Color(NAVY.line) },
      lineA: { value: 0.3 },
      N: { value: 48 },
      horizon: { value: 0.35 },
      hCol: { value: new T.Color(NAVY.line) },
      ripple: { value: 0 },
      hilite: { value: new T.Color(RIPPLE.hilite) },
      gain: { value: RIPPLE.domeGain },
    },
    vertexShader: `varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top, bottom, line, hCol, hilite; uniform float lineA, N, horizon, ripple, gain; varying vec3 vP;
${GRID_FN}
${RIPPLE_GLSL}
void main() {
  float lon = atan(vP.z, vP.x) / 6.2831853 * N;
  float lat = asin(clamp(vP.y, -1.0, 1.0)) / 3.1415926 * N * 0.5;
  float l = max(gridLine(lon, 1.0), gridLine(lat, 1.0)) * smoothstep(0.98, 0.85, abs(vP.y));
  vec3 c = mix(bottom, top, smoothstep(-0.2, 0.9, vP.y));
  c = mix(c, line, l * lineA);
  // echo: a soft band climbing from the horizon while the floor ring fades out
  float ringR = rippleRadius(ripple);
  float bandY = 0.22 * smoothstep(R_REACH * 0.65, R_REACH, ringR);
  float band = exp(-pow((vP.y - bandY) / 0.07, 2.0));
  c += hilite * l * band * echoLife(ringR) * gain;
  c += hCol * horizon * exp(-abs(vP.y) * 14.0);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`,
  });
  const mesh = new T.Mesh(new T.SphereGeometry(DOME_RADIUS, 96, 48), material);
  mesh.renderOrder = -1;
  return mesh;
}

/** Radial white-to-black gradient used as an alpha map so the floor's edge never shows. */
function fadeTexture(solidTo: number): T.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "#fff");
  gradient.addColorStop(solidTo, "#fff");
  gradient.addColorStop(1, "#000");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new T.CanvasTexture(canvas);
  texture.anisotropy = 8;
  return texture;
}

function homeFloor(): { group: T.Group; overlayMaterial: T.ShaderMaterial; disposables: (T.BufferGeometry | T.Material | T.Texture)[] } {
  const group = new T.Group();
  const disposables: (T.BufferGeometry | T.Material | T.Texture)[] = [];

  const fade = fadeTexture(0.3);
  disposables.push(fade);
  const baseGeometry = new T.CircleGeometry(FLOOR_RADIUS, 128);
  disposables.push(baseGeometry);
  // MeshBasic, not the mock's MeshLambertMaterial: the character renderer's lighting is
  // baked into its own materials (see renderer-registry.ts), not real scene lights that would reach the floor.
  const baseMaterial = new T.MeshBasicMaterial({ color: FLOOR_COLOR, alphaMap: fade, transparent: true, depthWrite: false });
  disposables.push(baseMaterial);
  const base = new T.Mesh(baseGeometry, baseMaterial);
  base.rotateX(-Math.PI / 2);
  group.add(base);

  const overlayGeometry = new T.CircleGeometry(FLOOR_RADIUS, 128);
  disposables.push(overlayGeometry);
  const overlayMaterial = new T.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      col: { value: new T.Color(OVERLAY.color) },
      alpha: { value: OVERLAY.alpha },
      cell: { value: OVERLAY.cell },
      R: { value: FLOOR_RADIUS },
      ripple: { value: 0 },
      hilite: { value: new T.Color(RIPPLE.hilite) },
      gain: { value: RIPPLE.floorGain },
    },
    vertexShader: `varying vec3 vW; void main() { vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`,
    fragmentShader: `uniform vec3 col, hilite; uniform float alpha, cell, R, ripple, gain; varying vec3 vW;
${GRID_FN}
${RIPPLE_GLSL}
void main() {
  vec2 p = vW.xz; float r = length(p);
  float l = max(gridLine(p.x / cell, 1.0), gridLine(p.y / cell, 1.0));
  float ringR = rippleRadius(ripple);
  float d = (r - ringR) / R_WIDTH;
  float pulse = exp(-d * d) * rippleLife(ringR) * gain; // gaussian profile: no hard ring edge
  float fade = 1.0 - smoothstep(R * 0.2, R * 0.85, r);
  gl_FragColor = vec4(col + hilite * pulse, l * (alpha + pulse) * fade);
  #include <colorspace_fragment>
}`,
  });
  disposables.push(overlayMaterial);
  const overlay = new T.Mesh(overlayGeometry, overlayMaterial);
  overlay.rotateX(-Math.PI / 2);
  overlay.position.y = 0.002;
  group.add(overlay);

  return { group, overlayMaterial, disposables };
}

function motes(): { points: T.Points; disposables: (T.BufferGeometry | T.Material)[] } {
  const positions = new Float32Array(MOTE_COUNT * 3);
  const colors = new Float32Array(MOTE_COUNT * 3);
  const phases = new Float32Array(MOTE_COUNT);
  const sizes = new Float32Array(MOTE_COUNT);
  const palette = MOTE_COLORS.map((color) => new T.Color(color));
  for (let i = 0; i < MOTE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 10 + Math.random() * 30;
    positions.set([Math.cos(angle) * radius, Math.random() * 14, Math.sin(angle) * radius], i * 3);
    const color = palette[Math.floor(Math.random() * palette.length)];
    colors.set([color.r * MOTE_DIM, color.g * MOTE_DIM, color.b * MOTE_DIM], i * 3);
    phases[i] = Math.random();
    sizes[i] = 0.06 + Math.random() * 0.08;
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
  geometry.setAttribute("acol", new T.BufferAttribute(colors, 3));
  geometry.setAttribute("phase", new T.BufferAttribute(phases, 1));
  geometry.setAttribute("size", new T.BufferAttribute(sizes, 1));
  const material = new T.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    uniforms: { time: { value: 0 }, scale: { value: 1 } },
    vertexShader: `attribute vec3 acol; attribute float phase; attribute float size;
uniform float time; uniform float scale; varying vec3 vC; varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.5 + 0.5 * sin(time * (0.6 + phase) + phase * 6.2831);
  float px = size * scale / -mv.z;
  // Sub-pixel points snap between pixels and read as sparkle in a small panel: floor the
  // sprite at MIN_PX and trade the lost area for alpha so each mote keeps its brightness.
  float minPx = ${MOTE_MIN_PX.toFixed(1)};
  vA = (0.35 + 0.65 * tw) * min(1.0, (px * px) / (minPx * minPx)); vC = acol;
  gl_PointSize = max(px, minPx);
}`,
    fragmentShader: `varying vec3 vC; varying float vA;
void main() { float a = pow(smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)), 2.0) * vA; gl_FragColor = vec4(vC, a);
  #include <colorspace_fragment>
}`,
  });
  return { points: new T.Points(geometry, material), disposables: [geometry, material] };
}

/** The built-in default stage. Far bound: never inside the dome, since a clipped dome leaves
 *  the canvas transparent and the additive motes then composite as flicker against the panel
 *  background. Orbit clamp: no view from under the floor, no drifting past the platform's edge. */
export const defaultStage: StageFactory = {
  create(scene) {
    const sphere = createHomeSphere(scene);
    return {
      far: DOME_RADIUS * 2,
      orbit: { minPolarAngle: 0.01, maxPolarAngle: 1.5, maxDistance: 12 },
      tick: sphere.tick,
      resize: sphere.resize,
      dispose: sphere.dispose,
    };
  },
};

function createHomeSphere(scene: T.Scene) {
  const dome = gridDome();
  const floor = homeFloor();
  const moteField = motes();
  scene.add(dome, floor.group, moteField.points);
  const moteMaterial = moteField.points.material as T.ShaderMaterial;
  const domeMaterial = dome.material as T.ShaderMaterial;
  const disposables: (T.BufferGeometry | T.Material | T.Texture)[] = [
    dome.geometry, dome.material as T.Material,
    ...floor.disposables,
    ...moteField.disposables,
  ];

  return {
    /** Advances mote twinkle and rise and the floor ripple. Call only from the existing render path (no own RAF). */
    tick(elapsedSeconds: number) {
      moteMaterial.uniforms.time.value = elapsedSeconds;
      // phase wrapped on the CPU: float32 time in the shader loses precision over a long session
      const ripple = elapsedSeconds % RIPPLE.period;
      domeMaterial.uniforms.ripple.value = ripple;
      floor.overlayMaterial.uniforms.ripple.value = ripple;
      moteField.points.position.y = (elapsedSeconds * MOTE_RISE_SPEED) % MOTE_RISE_PERIOD - MOTE_RISE_PERIOD / 2;
      moteField.points.rotation.y = elapsedSeconds * 0.01;
    },
    /** Keeps mote screen size stable across resizes. `pixelHeight` is the drawing buffer height (device pixels), as in the mock. */
    resize(pixelHeight: number, verticalFovDegrees: number) {
      moteMaterial.uniforms.scale.value = pixelHeight / (2 * Math.tan(T.MathUtils.degToRad(verticalFovDegrees / 2)));
    },
    dispose() {
      scene.remove(dome, floor.group, moteField.points);
      disposables.forEach((resource) => resource.dispose());
    },
  };
}
