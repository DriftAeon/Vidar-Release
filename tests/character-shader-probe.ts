// Browser/WebView2 regression probe. Build as an IIFE with `three` external
// (probeThree), then evaluate in the isolated character harness, never live Vidar.
import * as T from 'three';
import { buildEyeShineVertex, buildEyeShineFragment } from '../src/character/vendor/dsts/effects/eyeShine.glsl';

const renderer = new T.WebGLRenderer({ alpha: true });
const target = new T.WebGLRenderTarget(8, 8);
const scene = new T.Scene();
const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
camera.position.z = 1;
const texels = new Uint8Array([255, 255, 255, 0]);
const texture = new T.DataTexture(texels, 1, 1, T.RGBAFormat);
texture.needsUpdate = true;
const material = new T.ShaderMaterial({
  vertexShader: buildEyeShineVertex(), fragmentShader: buildEyeShineFragment(),
  defines: { CHR_EYE_MATCAP: '' },
  uniforms: { uMatcap: { value: texture }, uMatcapTilt: { value: new T.Vector2() } },
  transparent: true, blending: T.AdditiveBlending, depthWrite: false,
});
const geometry = new T.PlaneGeometry(2, 2);
scene.add(new T.Mesh(geometry, material));
renderer.setClearColor(0x000000, 1);
renderer.setRenderTarget(target);
function sample(alpha: number): number[] {
  texels[3] = alpha;
  texture.needsUpdate = true;
  renderer.render(scene, camera);
  const pixel = new Uint8Array(4);
  renderer.readRenderTargetPixels(target, 4, 4, 1, 1, pixel);
  return Array.from(pixel);
}
try {
  const transparent = sample(0);
  const half = sample(128);
  const opaque = sample(255);
  const checks = [
    { name: 'Transparent white matcap texels add no light', pass: transparent.slice(0, 3).every(v => v === 0), pixel: transparent },
    { name: 'Half coverage adds half intensity', pass: half.slice(0, 3).every(v => Math.abs(v - 128) <= 1), pixel: half },
    { name: 'Opaque highlights remain white', pass: opaque.slice(0, 3).every(v => v === 255), pixel: opaque },
  ];
  (window as unknown as { characterShaderResults: unknown }).characterShaderResults = checks;
  if (checks.some(check => !check.pass)) throw new Error(JSON.stringify(checks));
} finally {
  geometry.dispose(); material.dispose(); texture.dispose(); target.dispose();
  renderer.dispose(); renderer.forceContextLoss();
}
