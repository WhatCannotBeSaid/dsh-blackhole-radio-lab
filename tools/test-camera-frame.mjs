import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Scene } from 'three';
import { createCameraFrame } from '../src/scene/camera-frame.js';
import { createAccretionDisk } from '../src/scene/accretion-disk.js';
import { createSpaceHaze } from '../src/scene/space-haze.js';

const baselineIndex = process.argv.indexOf('--baseline');
async function baseline(name, factory) {
  if (baselineIndex < 0) return factory;
  const dir = process.argv[baselineIndex + 1];
  assert.ok(dir, '--baseline needs a backup directory');
  const sourceUrl = new URL(`../src/scene/${name}.js`, import.meta.url);
  const source = readFileSync(`${dir}/src__scene__${name}.js`, 'utf8').replace(/from '([^']+)'/g, (_, spec) =>
    `from '${spec === 'three' ? import.meta.resolve('three') : new URL(spec, sourceUrl).href}'`);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return mod[factory.name];
}
const beforeDisk = await baseline('accretion-disk', createAccretionDisk);
const beforeHaze = await baseline('space-haze', createSpaceHaze);

const keys = ['uCamPos', 'uCamRight', 'uCamUp', 'uCamForward', 'uTanHalfFov', 'uViewport',
  'uTime', 'uOpacity', 'uStationPhase', 'uProbeMode', 'uProbeRect'];
function snapshot(part) {
  const uniforms = part.object.material.uniforms;
  return Object.fromEntries(keys.filter((key) => key in uniforms).map((key) => {
    const value = uniforms[key].value;
    return [key, Array.isArray(value) ? [...value] : value?.toArray ? value.toArray() : value];
  }));
}
function makePair(diskFactory, hazeFactory) {
  const renderer = {
    width: 976, height: 821, reads: 0, target: null, outputColorSpace: 'original', toneMapping: 0,
    getDrawingBufferSize(out) { this.reads++; return out.set(this.width, this.height); },
    getRenderTarget() { return this.target; },
    setRenderTarget(target) { this.target = target; },
    clear() {},
    render() { this.probeState = snapshot(disk); },
    readRenderTargetPixels(target, x, y, width, height, pixels) { pixels.fill(0); },
  };
  const disk = diskFactory({ renderer });
  const haze = hazeFactory({ renderer });
  const scene = new Scene();
  scene.add(disk.object, haze.object);
  return { renderer, disk, haze, scene };
}
const current = makePair(createAccretionDisk, createSpaceHaze);
const original = makePair(beforeDisk, beforeHaze);
const camera = new PerspectiveCamera(42, 1, 0.1, 400);
let matrixUpdates = 0;
const updateMatrixWorld = camera.updateMatrixWorld.bind(camera);
camera.updateMatrixWorld = (...args) => { matrixUpdates++; return updateMatrixWorld(...args); };
const updateFrame = createCameraFrame(current.renderer);
let scratch;
function counted(pair, fn, expected) {
  matrixUpdates = 0;
  pair.renderer.reads = 0;
  let tangentCalls = 0;
  const tan = Math.tan;
  Math.tan = (value) => { tangentCalls++; return tan(value); };
  try { fn(); } finally { Math.tan = tan; }
  assert.equal(matrixUpdates, expected, 'camera matrix refresh count');
  assert.equal(pair.renderer.reads, expected, 'drawing-buffer read count');
  assert.equal(tangentCalls, expected, 'FOV tangent count');
}
function equalPairs(label) {
  assert.deepEqual(snapshot(current.disk), snapshot(original.disk), `${label}: disk`);
  assert.deepEqual(snapshot(current.haze), snapshot(original.haze), `${label}: haze`);
}
try {
  for (const part of ['disk', 'haze']) {
    assert.equal(current[part].object.material.vertexShader, original[part].object.material.vertexShader);
    assert.equal(current[part].object.material.fragmentShader, original[part].object.material.fragmentShader);
  }
  for (let i = 0; i < 360; i++) {
    const angle = i * 0.037;
    camera.position.set(12 * Math.sin(angle), Math.cos(angle * 0.4) * 9, 18 * Math.cos(angle));
    camera.lookAt(Math.sin(angle * 0.3), 0.3, 0);
    camera.fov = [16, 42, 67, 85][i % 4];
    camera.aspect = [1, 976 / 821, 1920 / 1080][i % 3];
    camera.zoom = i % 2 ? 1 : 1.5;
    camera.updateProjectionMatrix();
    for (const pair of [current, original]) {
      pair.renderer.width = [1, 976, 1920, 3840][i % 4];
      pair.renderer.height = [1, 821, 1080, 2160][i % 4];
      if (i % 60 === 0) {
        pair.disk.setStationSpin(i % 120 ? 1 : 0);
        pair.disk.setOpacity(i % 120 ? 1 : 0.25);
      }
    }
    const time = i / 60;
    counted(current, () => {
      const frame = updateFrame(camera);
      if (scratch) assert.equal(frame, scratch, 'reuse scratch storage, not frame allocations');
      scratch = frame;
      current.disk.update(time, camera, frame);
      current.haze.update(time, camera, frame);
    }, 1);
    counted(original, () => {
      original.disk.update(time, camera);
      original.haze.update(time, camera);
    }, 2);
    equalPairs(`frame ${i}`);
  }
  console.log('PASS 360 frames: all camera/clock/probe uniforms equal; matrix/FOV/viewport work 2 -> 1 per pair; shader strings unchanged.');

  // Independent capture cameras must not consume the regular frame scratch.
  const captureCamera = camera.clone();
  captureCamera.position.set(3, 4, 8);
  captureCamera.lookAt(1, 0, 0);
  captureCamera.fov = 31;
  const hazeBefore = snapshot(current.haze);
  const scratchBefore = { elements: [...scratch.elements], viewport: scratch.viewport.toArray(), tan: scratch.tanHalfFov };
  for (const pair of [current, original]) {
    pair.disk.update(7, captureCamera);
    pair.disk.setViewport(71, 43);
  }
  equalPairs('independent capture and viewport override');
  assert.deepEqual(snapshot(current.haze), hazeBefore);
  assert.deepEqual({ elements: [...scratch.elements], viewport: scratch.viewport.toArray(), tan: scratch.tanHalfFov }, scratchBefore);

  // Only the renderer boundary is a stub: the production probe override/finally runs.
  for (const pair of [current, original]) {
    const before = snapshot(pair.disk);
    const parent = pair.disk.object.parent;
    const blending = pair.disk.object.material.blending;
    pair.disk.probe({ mode: 1, width: 2, height: 3, eye: { x: 3, y: 1, z: -8 }, time: 99, tanHalfFov: 0.17 });
    assert.equal(pair.renderer.probeState.uTime, 99);
    assert.equal(pair.renderer.probeState.uTanHalfFov, 0.17);
    assert.deepEqual(pair.renderer.probeState.uViewport, [2, 3]);
    assert.deepEqual(snapshot(pair.disk), before, 'probe restores uniforms');
    assert.equal(pair.disk.object.parent, parent);
    assert.equal(pair.disk.object.material.blending, blending);
    assert.equal(pair.renderer.target, null);
    assert.equal(pair.renderer.outputColorSpace, 'original');
    const region = { x: 2, y: 4, width: 1, height: 1 };
    pair.disk.probe({ mode: 1, region });
    assert.deepEqual(pair.renderer.probeState.uViewport, [71, 43], 'region retains full viewport');
    assert.deepEqual(snapshot(pair.disk), before);
    pair.disk.update(8, camera);
  }
  equalPairs('regular camera restored after capture and probe');
  assert.deepEqual(snapshot(current.haze), hazeBefore);
  counted(current, () => {
    const frame = updateFrame(camera);
    current.disk.update(9, camera, frame);
    current.haze.update(9, camera, frame);
  }, 1);
  original.disk.update(9, camera); original.haze.update(9, camera);
  equalPairs('next shared frame after probe');
  console.log('PASS independent capture camera, viewport/region/probe overrides and restore, then next shared frame.');

  // Preserve standalone two-argument and renderer-less callers.
  const noRenderer = [createAccretionDisk(), beforeDisk(), createSpaceHaze(), beforeHaze()];
  try {
    noRenderer.forEach((part) => part.update(11, camera));
    assert.deepEqual(snapshot(noRenderer[0]), snapshot(noRenderer[1]));
    assert.deepEqual(snapshot(noRenderer[2]), snapshot(noRenderer[3]));
    noRenderer[2].update(12, null);
    assert.deepEqual(snapshot(noRenderer[2]), snapshot(noRenderer[3]));
  } finally { noRenderer.forEach((part) => part.dispose()); }

  const stage = readFileSync(new URL('../src/stage.js', import.meta.url), 'utf8');
  assert.match(stage, /const cameraFrame = updateCameraFrame\(camera\);\s+disk\.update\(elapsed, camera, cameraFrame\);\s+spaceHaze\.update\(elapsed, camera, cameraFrame\);/);
  assert.ok(stage.includes('disk.update(elapsed, sourceCamera);'));
  assert.ok(stage.includes('disk.update(elapsed, camera);'));
  assert.ok(stage.includes('disk.update(0, camera);'));
  console.log('PASS standalone/no-renderer calls and production frame wiring. GPU/browser/visual/performance acceptance NOT exercised.');
} finally {
  for (const pair of [current, original]) { pair.disk.dispose(); pair.haze.dispose(); }
}
