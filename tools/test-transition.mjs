// Source-driven timeline + real CPU particle-buffer regression (no GPU claims).
// Run: node tools/test-transition.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PerspectiveCamera, Vector3 } from 'three';
import { createStationsLayer } from '../src/nodes/stations-layer.js';
import { buildClusterLayout } from '../src/cluster/layout.js';
import { GENRE_IDS } from '../src/radio/genres.js';
import { buildFragmentShader } from '../src/scene/geodesic.glsl.js';

// Execute the scalar observer math extracted from the actual shader. This is a
// numeric guard; compilation and rendered shadow size still need a GPU check.
{
  const shader = buildFragmentShader();
  const observer = shader.slice(shader.indexOf('  float holeScale = '), shader.indexOf('  float fCam = '));
  assert.ok(observer.includes('uProbeMode == 0'));
  const step = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // The extracted code refers to max()/length(), just as the GPU does.
  const run = new Function('p', 'mode', 'smoothstep',
    `const max = Math.max, length = Math.abs; ${observer.replace(/\b(?:float|vec3)\b/g, 'let').replace(/\buDiscTransfer\b/g, 'p').replace(/\buProbeMode\b/g, 'mode').replace(/\buCamPos\b/g, '20')} return { holeScale, rCam };`);
  const samples = [0, 0.25, 0.5, 0.75, 0.9, 1].map((p) => run(p, 0, step));
  assert.equal(samples[0].holeScale, 1);
  assert.equal(samples.at(-1).holeScale, 0);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].holeScale < samples[i - 1].holeScale);
    assert.ok(samples[i].rCam > samples[i - 1].rCam);
  }
  for (const mode of [21, 65, 66]) assert.equal(run(0.8, mode, step).rCam, 20, 'capture/probe observer changed');
  assert.equal(run(-1, 0, step).rCam, 20, 'resting observer changed');
  assert.ok(shader.includes('float dissolve = 1.0 - smoothstep(0.0, 0.12, holeScale);'));
  console.log('PASS hole contracts before dissolving; reverse expands; resting/capture/probe observer unchanged.');
}
import { buildDiscFragments, DISC_TRANSFER_LANDING, discTransferHandoff } from '../src/scene/disc-transfer.js';

const source = readFileSync(new URL('../src/stage.js', import.meta.url), 'utf8');
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep01 = (x) => x * x * (3 - 2 * x);
const declarations = [
  'worm', 'ringPoint', 'prepareDiscTransfer', 'startHold', 'cancelHold', 'lockHold', 'beginCover',
  'finishWormhole', 'driveNebula', 'driveCluster', 'driveCharge', 'driveDark',
  'burstOf', 'darkAt', 'advanceWormhole', 'applyTransition',
  'enterCluster', 'exitCluster',
];
function declaration(name) {
  const start = source.indexOf(`    const ${name} = `);
  assert.ok(start >= 0, `missing source declaration: ${name}`);
  const end = source.indexOf('\n    };', start);
  if (name === 'burstOf' || name === 'darkAt') return source.slice(start, source.indexOf('\n', start));
  assert.ok(end > start, `missing declaration end: ${name}`);
  return source.slice(start, end + 7);
}
const code = `${declarations.map(declaration).join('\n')}\nglobalThis.api = { ${declarations.join(', ')} };`;
const stations = GENRE_IDS.flatMap((genre, group) => Array.from({ length: 8 }, (_, k) => {
  const angle = (group * 8 + k) * 0.23;
  const radius = 1.5 + k * 0.32;
  return {
    id: `${genre}-${k}`, name: `${genre} ${k}`, categories: [genre],
    position: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius },
    metadata: { primaryCategory: genre, presence: 1, layout: { radius, angle, height: 0 } },
  };
}));
assert.equal(GENRE_IDS.length, 13);
const camera = new PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(0, 1, 8);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
{
  const width = 13, height = 8;
  const pixels = new Uint8Array(width * height * 4);
  const ids = new Float32Array(width * height);
  for (let i = 0; i < ids.length; i++) {
    pixels.set([30 + i, 90, 160, i % 7 ? 255 : 0], i * 4);
    ids[i] = i % 5 ? i : -1; // Unowned gas must inherit a real observed identity.
  }
  const before = pixels.slice();
  const layout = buildClusterLayout(stations, { seed: 7, vocabulary: GENRE_IDS });
  const snapshot = { width, height, pixels, ids, camera };
  const fragments = buildDiscFragments(snapshot, layout);
  assert.equal(fragments.count, pixels.filter((_, i) => i % 4 === 3 && pixels[i] > 0).length);
  assert.deepEqual(pixels, before, 'capture colours were repainted');
  const observed = new Set(Array.from(ids).filter((id, i) => id >= 0 && pixels[i * 4 + 3]));
  for (let n = 0; n < fragments.count; n++) {
    const id = fragments.station[n];
    assert.ok(observed.has(id), 'a fragment was invented for an unobserved station');
    const point = { x: fragments.source[n * 3], y: fragments.source[n * 3 + 1], z: fragments.source[n * 3 + 2] };
    const projected = camera.position.clone().copy(point).project(camera);
    assert.ok(Math.abs(projected.x - (fragments.uv[n * 2] * 2 - 1)) < 1e-6);
    assert.ok(Math.abs(projected.y - (fragments.uv[n * 2 + 1] * 2 - 1)) < 1e-6);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(fragments.target[n * 3 + k] - layout.positions[id * 3 + k]) < 0.019);
  }
  assert.deepEqual(buildDiscFragments(snapshot, layout).source, fragments.source, 'source construction is not reversible/deterministic');
  assert.throws(() => buildDiscFragments({ ...snapshot, ids: new Float32Array(ids.length).fill(-1) }, layout), /no station attribution/);
  assert.equal(discTransferHandoff(DISC_TRANSFER_LANDING), 0, 'resting stars appeared before the source arrived');
  assert.equal(discTransferHandoff(1), 1);
  console.log(`PASS ${fragments.count} real source-cell mappings: captured colour, projected origin, observed station identity, category destination, late-only material handoff.`);
}
function harness(reducedMotion = false) {
  const layer = createStationsLayer(stations, { seed: 7 });
  const ring = { progress: 0, completed: 0, visible: false,
    show() { this.visible = true; }, hide() { this.visible = false; },
    setProgress(p) { this.progress = p; this.visible = true; },
    complete() {
      assert.equal(context.renderedEnd, true, 'ring completed before the endpoint draw');
      this.completed++; this.progress = 1; this.visible = false;
    },
  };
  const disk = { opacity: 1, transfer: -1, captures: 0,
    setOpacity(x) { this.opacity = x; },
    setDiscTransfer(x) { this.transfer = x; },
    captureDisc(sourceCamera) { this.captures++; this.capturedCamera = sourceCamera.clone(); return {}; }, update() {}, setStationSpin() {},
    setStationEmission() {}, setStationGain() {}, setCharge() {}, setRingIntensity() {},
  };
  const discTransfer = { active: false, progress: 0,
    begin() { this.active = true; }, setProgress(p) { this.progress = p; },
    end() { this.active = false; },
  };
  const context = vm.createContext({
    layer, holdRing: ring, disk, discTransfer, camera, Vector3, elapsed: 0, reducedMotion, stations, GENRE_IDS, buildClusterLayout,
    describe: (error) => error.message, console: { warn() {} },
    clamp01, smoothstep01, DISC_TRANSFER_LANDING, discTransferHandoff, Math, layoutCache: new Map(), catalog: { seed: 7 },
    performance: { now: () => context.now }, now: 0, renderedEnd: false,
    machine: { mode: 'black-hole', progress: 0, target: 0, nebula: 0, nebulaTarget: 0,
      wormCharge: 0, wormDark: 0, wormCover: 0, wormTakeover: 0 },
    settings: { onCenterClick() {} }, renderer: { toneMappingExposure: 1.15 },
    starfield: { setDim() {} }, nebula: null,
    container: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    rig: { framing: () => ({ radius: 8, phi: 0.4, theta: 0 }), setHome() {} },
    WORM_RING_S: 1, WORM_END_S: 2.5, WORM_OUT_RING_S: 0.55,
    WORM_OUT_VEIL_S: 1.15, WORM_OUT_END_S: 1.75, WORM_RECOIL_S: 0.22,
    WORM_CALM_RATE: 5, WORM_REVEAL_RATE: 1 / 1.15, TRANSITION_RATE: 0.95,
    HOLE_STATION_DIM: 0.55, dirty: false, transitioning: false, nebulaSpeed: 0,
    requestFrame() {}, clearSelection() {}, clearTimers() {}, notifyMode() {},
    syncDataset() {}, finishNebulaTransition() {}, exitNebula() {}, enterNebula() {},
    holeOrbitLimits: () => ({ minRadius: 3.6, maxRadius: 44 }), focusOrSelect() {},
  });
  vm.runInContext(code, context);
  const api = context.api;
  const layout = buildClusterLayout(stations, { seed: 7, vocabulary: GENRE_IDS });
  assert.equal(layout.groups.filter((g) => g.count > 0).length, 13);
  function endpoint() {
    assert.equal(disk.opacity, 0, 'black-hole pass is still visible');
    assert.equal(context.machine.progress, 1, 'timeline not exactly at endpoint');
    for (let i = 0; i < stations.length; i++) {
      const p = layer.positionAt(i);
      for (const [axis, offset] of [['x', 0], ['y', 1], ['z', 2]]) {
        assert.ok(Math.abs(p[axis] - layout.positions[i * 3 + offset]) < 1e-5, `anchor ${i} not at its destination`);
      }
    }
    const mix = layer.object.geometry.getAttribute('aCluster').array;
    assert.ok(mix.every((v) => v === 1), 'a particle is still in transit');
  }
  function frame(seconds, dt = 1 / 60) {
    context.now = seconds * 1000;
    api.advanceWormhole(context.now);
    if (discTransfer.active && context.machine.progress <= DISC_TRANSFER_LANDING) {
      assert.equal(layer.object.visible, false, 'old substitute particle population is still drawn in flight');
      assert.ok(disk.transfer >= 0, 'unbroken original disc is still drawn behind its source fragments');
    }
    layer.update(dt, camera, 900);
    // This is a CPU-side render seam, not a WebGL render. The production tick
    // ordering is asserted separately below.
    if (api.worm.landed) {
      if (api.worm.kind === 'enter') {
        endpoint();
        assert.equal(ring.completed, 0);
      } else {
        assert.equal(context.machine.progress, 0, 'exit did not upload its exact endpoint');
        assert.equal(discTransfer.active, false, 'exit draw still belongs to captured fragments');
        assert.equal(disk.transfer, -1, 'exit ring leads the normal ray-traced disc draw');
        assert.equal(disk.opacity, 1);
        assert.ok(layer.object.geometry.getAttribute('aCluster').array.every((v) => v === 0));
      }
      context.renderedEnd = true;
      api.finishWormhole();
    }
  }
  return { context, api, layer, ring, layout, frame, endpoint };
}
const event = { clientX: 400, clientY: 300, pointerId: 1, button: 0 };
let cases = 0;
for (const hz of [15, 30, 60]) {
  const h = harness();
  const start = h.layer.positionAt(0);
  h.api.startHold('enter', event);
  let previousProgress = 0;
  let before = h.layer.object.geometry.getAttribute('position').array.slice();
  for (let n = 1; n <= Math.ceil(2.5 * hz); n++) {
    h.frame(n / hz, 1 / hz);
    assert.ok(h.context.machine.progress >= previousProgress, 'competing tween pulled progress backwards');
    previousProgress = h.context.machine.progress;
    const buffer = h.layer.object.geometry.getAttribute('position').array;
    assert.ok(buffer.every(Number.isFinite));
    const maxStep = buffer.reduce((m, v, i) => Math.max(m, Math.abs(v - before[i])), 0);
    assert.ok(maxStep < 0.8, `particle teleport: ${maxStep} at ${hz} Hz`);
    before = buffer.slice();
    if (n / hz < 2.5) assert.equal(h.ring.completed, 0);
    if (n === Math.ceil(hz * 0.5)) {
      assert.notDeepEqual(h.layer.positionAt(0), start, 'no under-hand movement');
      assert.ok(h.ring.progress < 1);
    }
  }
  assert.equal(h.ring.completed, 1);
  assert.equal(h.context.machine.mode, 'cluster');
  h.endpoint();
  h.layer.update(0.05, camera, 900);
  h.endpoint(); // ownership handback must not retract the final buffers
  assert.equal(h.layer.interactive(0), true);
  h.layer.setSelectedIndex(0);
  h.layer.setPlayingIndex(0, false);
  assert.equal(h.layer.marker.visible, true);
  assert.ok(h.layer.marker.position.distanceTo({ ...h.layer.positionAt(0) }) < 1e-5);
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event);
  h.frame(0.6);
  h.api.cancelHold();
  h.frame(0.71);
  const before = h.context.machine.progress;
  h.api.startHold('enter', event);
  h.api.advanceWormhole(h.context.now);
  assert.ok(Math.abs(h.context.machine.progress - before) < 1e-4, 'repress jumped the travel');
  h.api.cancelHold();
  h.frame(1.0);
  assert.equal(h.api.worm.kind, null);
  assert.equal(h.context.machine.progress, 0);
  assert.equal(h.ring.completed, 0);
  assert.equal(h.context.disk.opacity, 1);
  h.layer.dispose(); cases++;
}
for (const firstFrame of [1.1, 3.0]) {
  const h = harness();
  h.api.startHold('enter', event);
  h.frame(firstFrame, 0.05);
  assert.equal(h.api.worm.layoutReady || h.ring.completed === 1, true, 'late first frame lost layout');
  if (firstFrame < 2.5) {
    h.api.cancelHold(); // committed entry is not cancelled by release
    assert.equal(h.api.worm.kind, 'enter');
    h.frame(2.5, 0.05);
  }
  h.endpoint(); h.layer.dispose(); cases++;
}
{
  const h = harness(true);
  h.api.startHold('enter', event);
  h.frame(0.6);
  assert.equal(h.context.machine.progress, 0);
  h.frame(1.1);
  assert.equal(h.ring.completed, 0);
  h.frame(1.2);
  assert.equal(h.ring.completed, 1);
  h.endpoint(); h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  h.context.renderedEnd = false;
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(2.7);
  h.api.cancelHold();
  assert.equal(h.api.worm.kind, null, 'cancelled exit unexpectedly recoils into the hole');
  assert.equal(h.context.machine.progress, 1);
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  const initial = stations.map((_, i) => h.layer.positionAt(i));
  h.api.startHold('enter', event); h.frame(2.5);
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(3.2);
  h.frame(4.25);
  assert.equal(h.api.worm.kind, null);
  assert.equal(h.context.machine.mode, 'black-hole');
  for (let i = 0; i < stations.length; i++) {
    const p = h.layer.positionAt(i);
    assert.ok(Math.hypot(p.x - initial[i].x, p.y - initial[i].y, p.z - initial[i].z) < 1e-5);
  }
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.api.cancelHold();
  h.frame(0.3);
  assert.equal(h.context.machine.progress, 0);
  assert.equal(h.api.worm.kind, null);
  assert.equal(h.ring.completed, 0);
  h.layer.dispose(); cases++;
}
for (const failedOwner of ['capture', 'build']) {
  const h = harness();
  const capture = h.context.disk.captureDisc;
  const begin = h.context.discTransfer.begin;
  if (failedOwner === 'capture') h.context.disk.captureDisc = () => { throw new Error('GPU readback rejected'); };
  else h.context.discTransfer.begin = () => { throw new Error('no station attribution'); };
  assert.equal(h.api.startHold('enter', event), false);
  assert.equal(h.api.worm.kind, null);
  assert.equal(h.api.worm.layoutReady, false, 'failed capture installed an ownerless layout');
  assert.equal(h.context.discTransfer.active, false);
  assert.equal(h.context.machine.progress, 0);
  h.context.disk.captureDisc = capture;
  h.context.discTransfer.begin = begin;
  assert.equal(h.api.startHold('enter', event), true);
  h.frame(2.5); h.endpoint();
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  const framing = h.context.machine.savedCamera;
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(3.2);
  const expected = new Vector3().setFromSphericalCoords(framing.radius, framing.phi, framing.theta);
  assert.ok(h.context.disk.capturedCamera.position.distanceTo(expected) < 1e-8, 'exit captured the focused cluster camera instead of the saved hole framing');
  h.frame(4.25);
  assert.equal(h.ring.completed, 2);
  h.layer.dispose(); cases++;
}
const tickStart = source.indexOf('    const tick = ');
const tickEnd = source.indexOf('\n    };', tickStart);
const tick = source.slice(tickStart, tickEnd);
assert.ok(tick.indexOf('advanceWormhole(now)') < tick.indexOf('layer.update(dt, camera, viewport.h)'));
assert.ok(tick.indexOf('layer.update(dt, camera, viewport.h)') < tick.indexOf('if (dirty) draw()'));
assert.ok(tick.indexOf('if (dirty) draw()') < tick.indexOf('if (worm.landed) finishWormhole()'));
assert.ok(tick.includes('if (!worm.kind && machine.progress !== machine.target)'));
assert.equal(tick.includes('layer.setHoleOnly('), false, 'tick has a second visibility owner');
console.log(`PASS ${cases} transition cases + production frame ordering; 13 nonempty fixture groups; real particle buffers and interaction anchors. GPU/browser acceptance NOT exercised.`);
if (process.argv.includes('--bundles')) {
  for (const file of ['client.js', 'client.stage.js']) {
    let registration;
    const context = vm.createContext({
      window: { __ModuleLoader__: { load(value) { registration = value; } } },
      console, setTimeout, clearTimeout, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController,
    });
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, { filename: file });
    assert.equal(registration.id, '@local/dsh-blackhole-radio-lab');
    const exports = registration.factory((name) => { assert.equal(name, 'react'); return {}; });
    const keys = Object.keys(exports).sort();
    assert.deepEqual(keys, file === 'client.js' ? ['apply', 'inject'] : ['STAGE_PHASE', 'isSelectionGesture', 'mountStage']);
    console.log(`PASS loader ${file}: ${registration.id} ${JSON.stringify(keys)}`);
  }
}
