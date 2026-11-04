// Source-driven timeline + real CPU particle-buffer regression (no GPU claims).
// Run: node tools/test-transition.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PerspectiveCamera, Vector3 } from 'three';
import { createStationsLayer } from '../src/nodes/stations-layer.js';
import { createCameraRig } from '../src/scene/camera-rig.js';
import { createSpaceHaze } from '../src/scene/space-haze.js';
import { buildClusterLayout } from '../src/cluster/layout.js';
import { GENRE_IDS } from '../src/radio/genres.js';
import { buildFragmentShader, IMAGING_CONSTANTS } from '../src/scene/geodesic.glsl.js';
import { DISK_INNER, RS } from '../src/scene/dimensions.js';

// Execute the scalar observer math extracted from the actual shader. This is a
// numeric guard; compilation and rendered shadow size still need a GPU check.
{
  const shader = buildFragmentShader();
  const observer = shader.slice(shader.indexOf('  float holeScale = '), shader.indexOf('  float fCam = '));
  assert.ok(observer.includes('uProbeMode == 0'));
  const step = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // The extracted code refers to max()/length(), just as the GPU does.
  const run = new Function('p', 'mode', 'smoothstep', 'q = -1',
    `const max = Math.max, min = Math.min, length = Math.abs; ${observer.replace(/\b(?:float|vec3)\b/g, 'let').replace(/\buDiscTransfer\b/g, 'p').replace(/\buDiscReturn\b/g, 'q').replace(/\buProbeMode\b/g, 'mode').replace(/\buCamPos\b/g, '20')} return { holeScale, rCam };`);
  const samples = [0, 0.25, 0.5, 0.75, 0.9, 1].map((p) => run(p, 0, step));
  assert.equal(samples[0].holeScale, 1);
  assert.equal(samples.at(-1).holeScale, 0);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].holeScale < samples[i - 1].holeScale);
    assert.ok(samples[i].rCam > samples[i - 1].rCam);
  }
  for (const mode of [21, 65, 66]) assert.equal(run(0.8, mode, step).rCam, 20, 'capture/probe observer changed');
  assert.equal(run(-1, 0, step).rCam, 20, 'resting observer changed');
  let previous = -1;
  for (const q of [0, 0.12, 0.2, 0.35, 0.52, 0.72, 0.8, 1]) {
    const sample = run(-1, 0, step, q);
    assert.ok(sample.holeScale >= previous, 'return shadow shrank while gathering');
    previous = sample.holeScale;
    if (q >= 0.72) assert.equal(sample.rCam, 20, 'shadow not at full size before particle arrivals');
    for (const mode of [21, 65, 66]) assert.equal(run(-1, mode, step, q).rCam, 20, 'return affected probes');
  }
  // Follow the actual hold timeline, not hand-picked uniform values: nested
  // smoothsteps previously hid a rapid growth burst behind a monotonicity pass.
  let lastScale = 0;
  for (let frame = 0; frame <= 138; frame++) {
    const time = frame / 138; // 2.3 seconds at 60 Hz.
    const progress = 1 - step(0, 1, time);
    const q = discReturnProgress(progress);
    assert.ok(Math.abs(q - time) < 1e-7, 'return clock eased the wall time twice');
    const scale = run(-1, 0, step, q).holeScale;
    assert.ok(scale - lastScale < 0.016, 'return shadow jumps between frames');
    const reversed = run(1 - Math.min(time / 0.72, 1), 0, step).holeScale;
    assert.ok(Math.abs(scale - reversed) < 1e-7, 'growth differs from the reversed departure curve');
    if (time >= 0.2 && time <= 0.5) assert.ok(scale > 0.15 && scale < 0.8, 'visible growth was compressed');
    lastScale = scale;
  }
  // Execute the production GLSL phase expression too, and cross the old atan
  // branch cut: adjacent pixels must never switch between two whole sectors.
  const expression = shader.match(/float discReturnPhase\(vec2 uv\)\s*\{\s*return ([^;]+);/)[1];
  const gpuPhase = new Function('u', 'v', `const sin = Math.sin; return ${expression.replaceAll('uv.x', 'u').replaceAll('uv.y', 'v')};`);
  for (let x = 0; x <= 1; x += 0.02) for (let y = 0; y <= 1; y += 0.02) {
    const phase = discReturnPhase(x, y);
    assert.ok(phase >= 0.74 && phase <= 0.88, 'merge overlaps changing shadow geometry');
    assert.ok(Math.abs(phase - gpuPhase(x, y)) < 1e-12, 'CPU/GLSL merge clocks differ');
    assert.ok(Math.abs(phase - discReturnPhase(x, y + 1e-6)) < 1e-4, 'merge phase has a spatial cut');
  }
  for (const x of [0.1, 0.25, 0.49]) {
    assert.ok(Math.abs(discReturnPhase(x, 0.5 - 1e-6) - discReturnPhase(x, 0.5 + 1e-6)) < 1e-4,
      'angular branch cut splits the return disc');
  }
  assert.ok(shader.includes('float dissolve = 1.0 - smoothstep(0.0, 0.12, holeScale);'));
  console.log('PASS hole contracts before dissolving; reverse expands; resting/capture/probe observer unchanged.');
}
import { buildDiscFragments, createDiscTransfer, DISC_TRANSFER_LANDING, discTransferHandoff, discReturnPhase, discReturnProgress } from '../src/scene/disc-transfer.js';

const source = readFileSync(new URL('../src/stage.js', import.meta.url), 'utf8');
const exitEnd = Number(source.match(/const WORM_END_S = ([\d.]+)/)[1]);
assert.equal(exitEnd, 2.3, 'the shared hold duration changed');
const exitDuration = exitEnd;
const timelineTick = source.slice(source.indexOf('      // Resolve the timeline before'), source.indexOf('      currentLod = computeLod();'));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep01 = (x) => x * x * (3 - 2 * x);
const inverseSmoothstep = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : 0.5 - Math.sin(Math.asin(1 - 2 * v) / 3));
const declarations = [
  'worm', 'ringPoint', 'prepareDiscTransfer', 'startHold', 'cancelHold', 'lockHold', 'beginCover', 'handOver',
  'settleExit', 'finishTransition',
  'finishWormhole', 'driveCluster', 'driveCharge', 'driveDark',
  'burstOf', 'darkAt', 'advanceWormhole', 'applyTransition',
  'enterCluster', 'exitCluster', 'clearSelection', 'armExit', 'restoreClusterAfterCancel', 'skipWormhole', 'holeOrbitLimits',
];
function declaration(name) {
  const isFunction = name === 'holeOrbitLimits';
  const start = source.indexOf(isFunction ? `    function ${name}()` : `    const ${name} = `);
  assert.ok(start >= 0, `missing source declaration: ${name}`);
  const end = source.indexOf(isFunction ? '\n    }' : '\n    };', start);
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
    genre, genres: [genre],
    position: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius },
    metadata: { primaryCategory: genre, presence: 1, layout: { radius, angle, height: 0 } },
  };
}));
assert.equal(GENRE_IDS.length, 13);
// The cluster must sample the same diffuse sky and display curve as the hole,
// including its world-to-Schwarzschild rotation (not a mode-specific dimmer).
{
  const haze = createSpaceHaze();
  try {
    const shader = buildFragmentShader();
    const skyShader = haze.object.material.fragmentShader;
    const compact = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, '');
    for (const name of ['hash31', 'valueNoise', 'fbm3', 'backgroundDiffuse', 'acesFilmic', 'linearToSrgb']) {
      const pattern = new RegExp(`(?:float|vec3) ${name}\\([^]*?^}`, 'm');
      assert.equal(compact(skyShader.match(pattern)[0]), compact(shader.match(pattern)[0]), `cluster ${name} differs from the hole baseline`);
    }
    const diskSource = readFileSync(new URL('../src/scene/accretion-disk.js', import.meta.url), 'utf8');
    const rotate = new Function('RS', `return (${diskSource.match(/function toShader\([^]*?^}/m)[0]});`)(RS);
    assert.equal(haze.object.material.uniforms.uExposure.value, IMAGING_CONSTANTS.EXPOSURE);
    for (const eye of [[0, 1, 8], [4, 3, -7], [-2, 5, 1]]) {
      const view = new PerspectiveCamera(42, 1.6, 0.01, 100);
      view.position.set(...eye); view.lookAt(0, 0, 0); view.updateMatrixWorld();
      for (const frame of [undefined, { elements: view.matrixWorld.elements,
        tanHalfFov: Math.tan(view.fov * Math.PI / 360), viewport: { x: 800, y: 500 } }]) {
        haze.update(0, view, frame);
        const e = view.matrixWorld.elements;
        for (const [name, xyz] of [['uCamRight', [e[0], e[1], e[2]]],
          ['uCamUp', [e[4], e[5], e[6]]], ['uCamForward', [-e[8], -e[9], -e[10]]]]) {
          const actual = new Vector3(...haze.object.material.uniforms[name].value).normalize();
          const expected = new Vector3(...rotate(...xyz, [])).normalize();
          assert.ok(actual.distanceTo(expected) < 1e-12, `${name}: cluster sky samples a different brightness region`);
        }
      }
    }
    console.log('PASS shared sky: identical diffuse/noise/display formulas, exposure and camera sample directions (CPU/uniform checks).');
  } finally { haze.dispose(); }
}
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
  const layout = buildClusterLayout(stations, { seed: 7, vocabulary: GENRE_IDS, byGenre: true, forms: true });
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

  // Exercise the actual material's scalar GLSL, not a second copy of its curves.
  // This checks math/ownership only; GPU compilation and appearance need a browser.
  const transfer = createDiscTransfer({ getDrawingBufferSize: (out) => out.set(2048, 1024) });
  try {
    transfer.begin(snapshot, layout);
    const { vertexShader, fragmentShader } = transfer.object.material;
    assert.match(vertexShader, /float point = /, 'point formation is still tied to the whole flight');
    const curves = vertexShader.slice(vertexShader.indexOf('  float p = '), vertexShader.indexOf('  vec3 radial = '));
    const size = vertexShader.match(/vec2 size = (.*);/)[1];
    const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return smoothstep01(t); };
    const mix = (a, b, t) => Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t;
    const run = new Function('uProgress', 'aDelay', 'uCellPx', 'clamp', 'smoothstep', 'mix', 'vec2',
      `${curves.replace(/\bfloat\b/g, 'let')} return { flight, point, size: ${size} };`);
    const shape = (p, delay, cell) => run(p, delay, cell, (x, a, b) => Math.max(a, Math.min(b, x)), smoothstep, mix, (x) => [x, x]);
    assert.match(vertexShader, /vPoint = point;/);
    // Round sprites alone still preserve pixel-grid sheets. Exercise spatial
    // breakup within ONE station, including cells whose flight is still delayed.
    const scatter = transfer.object.geometry.getAttribute('aScatter');
    assert.ok(scatter, 'round dots still move as an undisturbed image-cell sheet');
    assert.deepEqual(Array.from(scatter.array), Array.from(fragments.scatter));
    const patch = { width: 64, height: 64, pixels: new Uint8Array(64 * 64 * 4).fill(255), ids: new Float32Array(64 * 64), camera };
    const cloud = buildDiscFragments(patch, layout);
    assert.deepEqual(buildDiscFragments(patch, layout).scatter, cloud.scatter, 'scatter changed on replay');
    assert.equal(new Set(cloud.station).size, 1);
    const spreadCode = vertexShader.match(/float spread = (.*);/)[1];
    const spread = new Function('p', 'smoothstep', `return ${spreadCode};`);
    assert.match(vertexShader, /world \+= aScatter \* spread;/, 'scatter is not applied to actual positions');
    assert.equal(spread(0, smoothstep), 0, 'unstarted capture moved');
    assert.equal(spread(1, smoothstep), 0, 'scatter changed the landing target');
    for (const p of [0.02, 0.06, 0.3, 0.7, 0.95]) {
      const amount = spread(p, smoothstep);
      assert.ok(amount > 0 && amount <= 1);
      assert.equal(amount, spread(p, smoothstep), 'reverse/replay depends on elapsed time');
    }
    assert.ok(spread(0.06, smoothstep) > 0.9 && shape(0.06, 0.32, [4, 4]).flight === 0, 'delayed dots still form sheets');
    const normal = cloud.right.clone().cross(cloud.up);
    const depth = [];
    const occupied = new Set();
    const radius = Math.max(...cloud.scatter);
    let neighbourEnergy = 0;
    for (let i = 0; i < cloud.count; i++) {
      const offset = Array.from(cloud.scatter.subarray(i * 3, i * 3 + 3));
      occupied.add(offset.map((v) => Math.max(0, Math.min(3, Math.floor((v / radius + 1) * 2)))).join(','));
      depth.push(new Vector3().fromArray(cloud.scatter, i * 3).dot(normal));
      if (i % patch.width) {
        for (let k = 0; k < 3; k++) neighbourEnergy += (cloud.scatter[i * 3 + k] - cloud.scatter[(i - 1) * 3 + k]) ** 2;
      }
    }
    const cellStep = new Vector3().fromArray(cloud.source, 3).distanceTo(new Vector3().fromArray(cloud.source));
    assert.ok(Math.sqrt(neighbourEnergy / (patch.height * (patch.width - 1))) > cellStep, 'neighbours still travel as a rigid patch');
    assert.ok(Math.max(...depth) - Math.min(...depth) > cellStep * 2, 'dots still occupy a flat sheet');
    assert.ok(occupied.size >= 48, 'scatter forms correlated strands instead of filling a volume');
    console.log('PASS spatial breakup: independent same-station offsets, depth, delayed dots, exact endpoints and deterministic reverse envelope (CPU/scalar GLSL only).');
    const mask = fragmentShader.slice(fragmentShader.indexOf('  float d = '), fragmentShader.indexOf('  if (alpha'));
    const alpha = new Function('vLocal', 'vPoint', 'uOpacity', 'length', 'smoothstep', 'mix',
      `${mask.replace(/\bfloat\b/g, 'let')} return alpha;`);
    const opacity = (local, point, value = 1) => alpha(local, point, value, (v) => Math.hypot(...v), smoothstep, mix);
    for (const delay of [0, 0.16, 0.32]) {
      for (const cell of [[4, 4], [8, 4]]) {
        assert.deepEqual(shape(0, delay, cell).size, cell, 'unstarted transfer stopped filling the disc');
        assert.equal(shape(0, delay, cell).point, 0);
        // Even delayed cells must be dots from the first advancing frame.
        for (const p of [0.000001, 0.01, 0.08, 0.16, 0.32, 0.5, 1]) {
          const s = shape(p, delay, cell);
          assert.equal(s.point, 1, 'advancing transfer still contains rectangular cells');
          assert.deepEqual(s.size, [2.2, 2.2], 'advancing transfer still contains large shards');
          assert.equal(opacity([0.5, 0.5], s.point), 0, 'a delayed cell retained square corners');
          assert.equal(s.flight, smoothstep01(clamp01((p - delay) / (1 - delay))), 'point formation changed the flight timing');
        }
      }
    }
    assert.equal(opacity([0.5, 0.5], 0), 1, 'intact disc acquired a dot lattice');
    assert.equal(opacity([0.5, 0.5], 1), 0, 'airborne dot retained square corners');
    assert.equal(opacity([0, 0], 1), 1, 'dot lost its captured centre brightness');
    assert.equal(opacity([0, 0], 1, 0), 0, 'dot ignored the existing material handoff');
    console.log('PASS transfer material: intact unstarted disc, dots only at every advancing sample including delayed cells, unchanged flight timing and opacity handoff (scalar GLSL only).');
  } finally {
    transfer.dispose();
  }
}
function harness(reducedMotion = false) {
  const layer = createStationsLayer(stations, { seed: 7 });
  const ring = { progress: 0, completed: 0, pulses: 0, visible: false,
    show() { this.visible = true; }, hide() { this.progress = 0; this.visible = false; },
    setProgress(p) { this.progress = p; this.visible = true; },
    pulse() { this.pulses++; },
    complete() {
      // Every fill waits for the endpoint image: the cluster is installed one
      // frame before the crossing branch, so the tick still lands that leg.
      // (`pending` is the seam filling the ring right after its own draw.)
      if (!this.pending) assert.equal(context.renderedEnd, true, 'ring completed before the endpoint draw');
      this.pending = false;
      this.completed++; this.progress = 1; this.visible = false;
    },
  };
  const disk = { opacity: 1, transfer: -1, captures: 0,
    setOpacity(x) { this.opacity = x; },
    setDiscTransfer(x) { this.transfer = x; },
    setDiscReturn(x) { this.returning = x; },
    captureDisc(sourceCamera) {
      this.captures++; this.capturedCamera = sourceCamera.clone();
      return { width: 13, height: 8, pixels: new Uint8Array(13 * 8 * 4).fill(255),
        ids: Float32Array.from({ length: 13 * 8 }, (_, i) => i), camera: sourceCamera.clone() };
    }, update() {}, setStationSpin(value) { this.spin = value; },
    setStationEmission() {}, setStationGain() {}, setCharge() {}, setRingIntensity() {},
    setDiscInner(x) { this.inner = x; },
  };
  const discTransfer = { active: false, progress: 0,
    begin() { this.active = true; }, setProgress(p) { this.progress = p; },
    end() { this.active = false; },
  };
  const context = vm.createContext({
    layer, holdRing: ring, disk, discTransfer, camera, Vector3, elapsed: 0, reducedMotion, stations, GENRE_IDS, buildClusterLayout,
    describe: (error) => error.message, console: { warn() {} },
    clamp01, smoothstep01, inverseSmoothstep, DISC_TRANSFER_LANDING, discTransferHandoff, discReturnProgress, buildDiscFragments, Math, layoutCache: new Map(), catalog: { seed: 7 },
    performance: { now: () => context.now }, now: 0, renderedEnd: false,
    machine: { mode: 'black-hole', progress: 0, target: 0,
      wormCharge: 0, wormDark: 0, wormTakeover: 0 },
    settings: { reducedMotion }, renderer: { toneMappingExposure: 1.15 },
    starfield: { setDim() {} },
    container: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    rig: { isSettled: true, home: { radius: 8, phi: 0.4, theta: 0, target: { x: 0, y: 0, z: 0 } },
      framing() { return { ...this.home, home: this.home }; },
      setHome(next) { if (next) for (const key of Object.keys(next)) if (next[key] !== undefined) this.home[key] = next[key]; } },
    hoverGroupId: null, setGroupHover() {}, showHint() {}, hintFor: (key) => key,
    WORM_RING_S: 1, WORM_END_S: exitEnd, WORM_RECOIL_S: 0.22,
    HOLD_PULSE_S: 0.6, WORM_DEADZONE_PX: 6,
    WORM_CALM_RATE: 5, WORM_REVEAL_RATE: 1 / 1.15, TRANSITION_RATE: 0.95,
    HOLE_STATION_DIM: 0.55, dirty: false, transitioning: false,
    DISK_INNER, RS,
    requestFrame() {}, selectedIndex: -1, selectedId: null, emitSelect() {}, clearTimers() {}, notifyMode() {},
    syncDataset() {},
    HOLE_MIN_RADIUS: Number(source.match(/const HOLE_MIN_RADIUS = ([\d.]+)/)[1]), focusOrSelect() {},
  });
  vm.runInContext(code, context);
  const api = context.api;
  const layout = buildClusterLayout(stations, { seed: 7, vocabulary: GENRE_IDS, byGenre: true, forms: true });
  assert.equal(layout.groups.filter((g) => g.count > 0).length, 13);
  function endpoint() {
    assert.ok(disk.opacity < 1e-4, 'black-hole pass is still visible');
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
    context.renderedEnd = false;
    const completions = ring.completed;
    if (typeof context.rig.update === 'function') context.rig.update(Math.min(dt, 0.05));
    // Execute the production timeline/uniform seam, not just its CPU clock.
    vm.runInContext(timelineTick, context);
    if (context.machine.returning) assert.equal(disk.returning, discReturnProgress(context.machine.progress), 'live disc uniform missed a return frame');
    if (discTransfer.active && context.machine.progress <= DISC_TRANSFER_LANDING) {
      assert.equal(layer.object.visible, false, 'old substitute particle population is still drawn in flight');
      assert.ok(disk.transfer >= 0, 'unbroken original disc is still drawn behind its source fragments');
    }
    layer.update(dt, camera, 900);
    // This is a CPU-side render seam, not a WebGL render. The production tick
    // ordering is asserted separately below.
    const leg = api.worm.landedLeg;
    // The pass direction is gone once it lands, so the landing is recognised
    // by the state it leaves behind, not by a leg the source just cleared.
    // The ring is filled by whatever stands on the endpoint: the tick for an
    // entry, the landing frame for an exit. Read it before the hold is closed,
    // which is what clears the leg.
    if (api.worm.pulseEnd) {
      // The tick publishes the endpoint, clears the request and closes the
      // hold; the ring is filled at the start of that same tick.
      api.worm.pulseEnd = false;
      if (context.machine.target > 0.5) context.machine.mode = 'cluster';
      context.renderedEnd = true;
      ring.pending = false;
      ring.complete();
      assert.equal(ring.completed, completions + 1, 'entry filled the ring twice');
    } else if (api.worm.landed && leg) {
      // A closed leg lands once. `landed` outlives it (the tick closes it one
      // frame later), and without this guard the same leg lands again on every
      // later frame, re-walking the reset geometry each time.
      api.worm.landed = false;
      // The landing frame draws the endpoint before anything closes it, so the
      // ring may fill from here — that is exactly what the tick does.
      context.renderedEnd = true;
      // An entry is closed by its own tick (the `pulseEnd` above), not here: the
      // landing frame only proves the endpoint image and lets the ring fill.
      if (leg === 'exit') {
        // A press with nothing to gather has no crossing to report: the tick
        // already filled the ring on the same frame, and the seam records its
        // fill as `pending`.
        const quiet = ring.pending;
        ring.pending = context.forcedFill ? quiet : true;
        context.forcedFill = false;
        if (!quiet) ring.complete();
        api.finishWormhole();
        assert.equal(context.machine.progress, 0, 'exit did not upload its exact endpoint');
        assert.equal(discTransfer.active, false, 'exit draw still belongs to captured fragments');
        assert.equal(disk.transfer, -1, 'exit ring leads the normal ray-traced disc draw');
        assert.equal(disk.opacity, 1);
        assert.ok(layer.object.geometry.getAttribute('aCluster').array.every((v) => v === 0));
        // This is `finishWormhole`'s own work: if the tick ever stops calling
        // it, the ring stays on screen and the machine keeps cluster mode, so
        // the hole's long press is ignored.
        assert.equal(context.machine.mode, 'black-hole', 'exit left the machine in cluster mode');
        assert.equal(context.transitioning, false, 'exit left the transition armed');
        assert.equal(ring.visible, false, 'exit left the progress ring on screen');
      }
    }
  }
  return { context, api, layer, ring, layout, frame, endpoint };
}
const event = { clientX: 400, clientY: 300, pointerId: 1, button: 0 };
let cases = 0;
// A search tap may release before any frame, below the recoil threshold, or
// after visible travel. Every cancellation must hand the disc back eventually.
for (const reducedMotion of [false, true]) {
  for (const advance of [0, 0.01, 0.08]) {
    const h = harness(reducedMotion);
    let spin = 1;
    h.context.disk.setStationSpin = (value) => { spin = value; };
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal(h.api.startHold('enter', event), true);
      if (advance) h.frame(h.context.now / 1000 + advance);
      h.api.cancelHold();
      // A no-travel tap must restore immediately, not wait for another frame.
      if (advance === 0 || (!reducedMotion && advance === 0.01)) {
        assert.equal(h.api.worm.kind, null, 'no-travel tap deferred restoration to a recoil');
        assert.equal(h.context.discTransfer.active, false, 'no-travel tap deferred capture cleanup');
        assert.equal(h.context.disk.transfer, -1, 'no-travel tap deferred ray tracing');
      }
      if (h.api.worm.kind === 'recoil') h.frame(h.context.now / 1000 + 1);
      assert.equal(h.api.worm.kind, null);
      assert.equal(h.api.worm.layoutReady, false);
      assert.equal(h.context.discTransfer.active, false, 'search tap left captured disc active');
      assert.equal(h.context.disk.transfer, -1, 'search tap did not restore ray tracing');
      assert.equal(spin, 1, 'search tap left station spin frozen');
      assert.equal(h.context.machine.progress, 0);
      assert.equal(h.context.machine.target, 0);
      assert.equal(h.context.disk.opacity, 1);
      assert.equal(h.ring.visible, false);
      h.frame(h.context.now / 1000 + 1);
      assert.equal(h.context.discTransfer.active, false, 'idle frame revived the capture');
    }
    if (!reducedMotion) assert.equal(h.context.disk.captures, 2, 'next hold reused a stale capture');
    h.layer.dispose(); cases++;
  }
}
for (const hz of [15, 30, 60]) {
  const h = harness();
  const start = h.layer.positionAt(0);
  h.api.startHold('enter', event);
  let previousProgress = 0;
  let before = h.layer.object.geometry.getAttribute('position').array.slice();
  const arrival = 2.3;
  assert.equal(h.ring.visible, true, 'entry ring missed the first frame');
  for (let n = 1; ; n++) {
    h.frame(n / hz, 1 / hz);
    // The landing frame hands the geometry over at the endpoint and closes the
    // hold; the mode is published with it, so there is nothing left to climb.
    if (h.context.machine.mode === 'cluster') break;
    assert.ok(h.context.machine.progress >= previousProgress, 'competing tween pulled progress backwards');
    previousProgress = h.context.machine.progress;
    const buffer = h.layer.object.geometry.getAttribute('position').array;
    assert.ok(buffer.every(Number.isFinite));
    const maxStep = buffer.reduce((m, v, i) => Math.max(m, Math.abs(v - before[i])), 0);
    assert.ok(maxStep < 0.8, `particle teleport: ${maxStep} at ${hz} Hz`);
    before = buffer.slice();
    if (n / hz < arrival) {
      assert.equal(h.ring.completed, 0);
      assert.equal(h.ring.visible, true);
      assert.ok(Math.abs(h.ring.progress - Math.min(0.999, h.context.machine.progress)) < 1e-12, 'entry ring drifted from the geometry');
    }
    if (n === Math.ceil(hz * 0.5)) {
      assert.notDeepEqual(h.layer.positionAt(0), start, 'no under-hand movement');
      assert.ok(h.ring.progress < 1);
    }
  }
  assert.equal(h.ring.completed, 1, `entry ring never filled at ${hz} Hz`);
  assert.equal(h.context.machine.mode, 'cluster', `mode not published at the landing frame, ${hz} Hz`);
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
  if (firstFrame < 2.32) {
    assert.equal(h.api.worm.locked, false, 'entry committed before its ring filled');
    h.frame(2.3, 0.05);
    h.frame(2.4, 0.05);
  } else {
    h.frame(firstFrame + 0.1, 0.05);
  }
  // The entry hands over before its landing frame is drawn, so it needs one
  // more frame of the tick: draw the endpoint, then close the pass. Always
  // ahead of the clock — the seam keeps no history, and a frame that went
  // back would walk the travel a second time.
  h.frame(h.context.now / 1000 + 0.2, 0.05);
  // The endpoint is already on screen when this branch lands: the call draws
  // it before it returns. Closing the pass is the tick's next step, and only
  // that close frees the captured disc.
  if (firstFrame >= 2.32) {
    h.ring.pending = true;
    h.api.finishWormhole();
  } else {
    h.ring.pending = true;
    h.api.finishWormhole();
  }
  h.endpoint(); h.layer.dispose(); cases++;
}
{
  const h = harness(true);
  h.api.startHold('enter', event);
  assert.equal(h.ring.visible, true, 'calm entry missed immediate feedback');
  h.frame(0.05);
  assert.ok(h.context.machine.progress > 0);
  h.frame(0.1);
  assert.equal(h.ring.completed, 0);
  assert.equal(h.ring.visible, true);
  assert.equal(h.ring.progress, h.context.machine.progress);
  h.frame(0.17);
  assert.equal(h.ring.completed, 1);
  // A calm entry fills the ring at the start of its tick, then the tick closes
  // the pass on that same frame; the seam has no tick of its own.
  h.ring.pending = true;
  h.api.finishWormhole();
  h.endpoint(); h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  h.context.renderedEnd = false;
  h.api.startHold('exit', { ...event, button: 2 });
  // An exit lands on its own frame and the hold is still held; the release
  // after the lock must not rewind it. The landing asserts its own endpoint
  // inside frame(), so this replay only reads the resting state back.
  h.frame(2.5 + exitDuration + 0.1);
  assert.equal(h.context.machine.progress, 0);
  h.api.cancelHold();
  assert.equal(h.api.worm.kind, null);
  assert.equal(h.context.machine.progress, 0);
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(exitDuration + 0.1);
  h.api.cancelHold();
  assert.equal(h.api.worm.kind, null, 'a released exit restarted itself');
  assert.equal(h.api.worm.recoilTarget, 0, 'the release did not hand the disc back');
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  h.context.renderedEnd = false;
  h.api.startHold('exit', { ...event, button: 2 });
  // Held only a fifth of the way: letting go gives the disc back rather than
  // finishing a pass it never armed.
  h.frame(2.5 + 0.5);
  h.api.cancelHold();
  assert.equal(h.api.worm.kind, 'recoil');
  assert.ok(h.context.machine.progress < 1);
  assert.equal(h.ring.visible, true);
  h.frame(2.5 + 0.5 + 0.5);
  assert.equal(h.api.worm.kind, null);
  assert.equal(h.context.machine.progress, 1);
  assert.equal(h.ring.visible, false);
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  h.context.renderedEnd = false;
  h.api.startHold('exit', { ...event, button: 2 });
  // Held all the way: the hole is back, and the cluster is gone.
  h.frame(2.5 + exitDuration + 0.1);
  assert.equal(h.context.machine.progress, 0);
  assert.equal(h.context.disk.opacity, 1);
  assert.equal(h.api.worm.kind, null);
  h.layer.dispose(); cases++;
}
for (const advance of [0, 0.01]) {
  // A right tap: armed on the press, released before anything advanced. It must
  // leave no hold and no recoil behind, or the favourites tap would pay a shake.
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  const armed = h.context.machine.progress;
  h.api.startHold('exit', { ...event, button: 2 });
  // Right is now nothing but the gathering hold: a press that never moved the
  // clock leaves no hold, no recoil and no motion behind.
  h.context.machine.returning = false;
  h.api.cancelHold();
  assert.equal(h.context.machine.returning, false, 'a near-zero exit cancellation leaked return styling');
  assert.equal(h.context.machine.target, 1, 'a near-zero exit cancellation kept the hole as destination');
  assert.equal(h.api.worm.kind, null, 'a right tap must not leave a recoil');
  assert.equal(h.api.worm.armed, false, 'a right tap must disarm the exit');
  assert.equal(h.ring.visible, false, 'a right tap must leave no ring');
  assert.equal(h.context.machine.progress, armed, 'a right tap must not move the frame');
  h.frame(3.0);
  assert.equal(h.context.machine.progress, armed);
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(3 + exitDuration);
  h.api.startHold('enter', event);
  assert.equal(h.context.machine.returning, false);
  assert.equal(h.context.disk.opacity, 1, 'next entry did not start with the original disc');
  h.frame(3 + exitDuration + 0.5);
  assert.equal(h.context.disk.opacity, 1, 'return opacity leaked into the next forward capture');
  h.frame(3 + exitDuration + 2.5);
  // The 2.5 s covers the second entry's own crossing; its landing tick closes.
  if (h.api.worm.landedLeg) {
    h.ring.pending = true;
    h.api.finishWormhole();
  }
  h.endpoint();
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  const initial = stations.map((_, i) => h.layer.positionAt(i));
  h.api.startHold('enter', event); h.frame(2.5);
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(3.2);
  h.frame(2.5 + exitDuration);
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
  h.frame(2.5);
  // The retry lands on its own tick, which closes the pass; the seam has none.
  h.ring.pending = true;
  h.api.finishWormhole();
  h.endpoint();
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  const captures = h.context.disk.captures;
  const before = h.layer.object.geometry.attributes.position.array.slice();
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(2.5);
  // A press on the settled cluster takes the long way back: the tick opens a
  // crossing for it, so the ring starts empty and fills at the landing.
  assert.ok(h.ring.progress <= 0.001, 'exit ring did not start empty');
  assert.equal(h.context.disk.captures, captures + 1, 'return did not sample the true saved-view landing image');
  assert.equal(h.context.machine.returning, true);
  assert.deepEqual(h.layer.object.geometry.attributes.position.array, before, 'return replaced the live cluster on press');
  h.frame(3.2);
  assert.equal(h.context.discTransfer.active, false, 'return introduced a second particle population');
  h.context.forcedFill = true;
  // The gap between these two frames outlives the return, so the closing tick
  // lands the endpoint, fills its own ring and restores the hole on that frame:
  // the seam sees a closed pass, not a crossing it has to fill.
  h.frame(2.5 + exitDuration);
  assert.ok(h.ring.completed >= 2 && h.ring.completed <= 3, 'settled return did not fill its ring');
  assert.equal(h.context.machine.progress, 0, 'settled return did not restore the hole');
  // The cluster was the leg, not the destination: the press landed on the hole.
  assert.equal(h.context.machine.mode, 'black-hole', 'settled return left the cluster on screen');
  h.layer.dispose(); cases++;
}
// An armed exit owns the return image even before its first moving frame.
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  h.api.startHold('exit', { ...event, button: 2 });
  h.api.armExit();
  h.api.cancelHold(true);
  assert.equal(h.context.machine.returning, false, 'unmoved cancellation leaked return state');
  assert.equal(h.context.disk.returning, -1, 'unmoved cancellation left real-disc mask enabled');
  assert.equal(h.context.disk.spin, 1, 'unmoved cancellation froze station spin');
  assert.equal(h.context.machine.progress, 1);
  h.layer.dispose(); cases++;
}
// Public navigation shares the image clock and retires it in either direction.
for (const target of [0, 1]) {
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  assert.equal(h.api.exitCluster({}), true);
  assert.equal(h.context.machine.returning, true);
  for (const progress of [0.9, 0.6, 0.2]) {
    h.context.machine.progress = progress; h.api.applyTransition();
    h.layer.update(1 / 60, camera, 900);
    assert.ok(h.layer.object.geometry.attributes.aCluster.array.every((value) => Math.abs(value - progress) < 1e-6));
    assert.equal(h.context.disk.returning, discReturnProgress(progress));
  }
  if (target === 1) h.api.enterCluster(null);
  h.context.machine.target = target; h.context.machine.progress = target;
  h.api.applyTransition();
  h.api.finishTransition();
  h.layer.update(1 / 60, camera, 900);
  assert.ok(h.layer.object.geometry.attributes.aCluster.array.every((value) => value === target), 'released flow missed the exact endpoint');
  assert.equal(h.context.machine.returning, false);
  assert.equal(h.context.disk.returning, -1);
  assert.equal(h.context.disk.spin, 1);
  h.layer.dispose(); cases++;
}
// Sample immediate motion and shared geometry/ring progress in both motion modes.
for (const calm of [false, true]) {
  for (const hz of [15, 30, 60]) {
    const h = harness(calm);
    h.api.startHold('enter', event); h.frame(2.5);
    h.api.startHold('exit', { ...event, button: 2 });
    assert.equal(h.ring.visible, true, 'exit missed immediate feedback');
    // The scalar is 1 at the cluster and the exit empties the arc, so a press
    // that has not drawn a frame yet shows an empty arc, not a full one.
    assert.ok(h.ring.progress <= 0.001, 'exit ring did not start empty');
    const end = calm ? 1 / 0.95 : exitDuration;
    for (let n = 1; n <= Math.ceil((end + 0.4) * hz); n++) {
      const t = n / hz;
      h.frame(2.5 + t, 1 / hz);
      if (t < end) {
        assert.ok(h.context.machine.progress < 1, 'exit still has an idle threshold');
        assert.equal(h.ring.visible, true, 'exit motion has no progress ring');
        // The counts differ between legs: releasing a live cluster back to the
        // hole fills the ring once, a full crossing from the field twice.
        assert.ok(h.ring.completed === 1 || h.ring.completed === 2, 'exit motion filled its ring more than once');
        assert.ok(Math.abs(h.ring.progress - Math.min(0.999, 1 - h.context.machine.progress)) < 1e-12);
        assert.equal(h.api.worm.locked, false);
      }
    }
    // The entry and the return each fill the ring once; the closing tick that
    // lands the return records its fill too when the loop crosses the endpoint.
    assert.ok(h.ring.completed >= 2 && h.ring.completed <= 3, 'return filled its ring out of step');
    assert.equal(h.context.machine.mode, 'black-hole');
    assert.equal(h.api.worm.kind, null);
    h.layer.dispose(); cases++;
  }
}
for (const firstExitFrame of [0.56, exitDuration + 0.1]) {
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  // A previous hold must not choose this exit's target.
  h.api.worm.target = 'field';
  h.api.startHold('exit', { ...event, button: 2 });
  h.frame(2.5 + firstExitFrame);
  if (firstExitFrame < exitDuration) {
    assert.equal(h.ring.progress, 1 - h.context.machine.progress);
    h.frame(2.5 + exitDuration);
  }
  // The first frame already crosses the endpoint: the tick lands and fills on
  // it, so only its own record shows up here.
  assert.ok(h.ring.completed === 2 || h.ring.completed === 3, 'return filled its ring out of step');
  h.layer.dispose(); cases++;
}
for (const leg of ['enter', 'exit']) {
  const h = harness();
  if (leg === 'exit') { h.api.startHold('enter', event); h.frame(2.5); }
  const start = h.context.now / 1000;
  h.api.startHold(leg, { ...event, button: leg === 'exit' ? 2 : 0 });
  h.frame(start + 1.1);
  h.api.cancelHold();
  assert.equal(h.api.worm.kind, 'recoil');
  h.frame(start + 2);
  assert.equal(h.api.worm.kind, null);
  assert.equal(h.context.machine.progress, leg === 'exit' ? 1 : 0);
  assert.equal(h.ring.visible, false);
  assert.equal(h.ring.completed, leg === 'exit' ? 1 : 0);
  h.layer.dispose(); cases++;
}
{
  const h = harness();
  h.api.startHold('enter', event); h.frame(2.5);
  h.api.startHold('exit', { ...event, button: 2 }); h.frame(3.2);
  assert.equal(h.api.skipWormhole(), true);
  h.frame(3.21);
  assert.ok(h.ring.completed === 2 || h.ring.completed === 3, 'skip did not complete with its final draw');
  assert.equal(h.context.machine.progress, 0);
  h.layer.dispose(); cases++;
}
// Exercise the production cancel/repress state machine with a real positive-dt
// buffer flush. Reversing only setFlow misses a return-mode/material swap.
for (const portion of [0.3, 0.75]) {
  const h = harness();
  try {
    h.api.startHold('enter', event); h.frame(2.5);
    h.api.startHold('exit', { ...event, button: 2 });
    const release = 2.5 + exitDuration * portion;
    h.frame(release);
    const positions = h.layer.object.geometry.attributes.position.array;
    const uniforms = h.layer.object.material.uniforms;
    const before = positions.slice();
    h.api.cancelHold();
    assert.equal(h.context.machine.returning, true, 'cancel dropped the live return before its endpoint');
    h.frame(release);
    assert.equal(uniforms.uReturning.value, 1, 'cancel replaced the small round return material');
    assert.deepEqual(positions, before, 'cancel jumped the live particle buffer at the same clock');
    h.frame(release + 0.03);
    const recoiling = positions.slice();
    h.api.startHold('exit', { ...event, button: 2 });
    h.frame(release + 0.03);
    assert.equal(uniforms.uReturning.value, 1, 'repress lost the live return material');
    assert.ok(positions.every((v, i) => Math.abs(v - recoiling[i]) < 1e-4), 'repress jumped the real sprite buffer');
    h.api.cancelHold();
    h.frame(release + 1);
    assert.equal(h.context.machine.progress, 1);
    assert.equal(h.context.machine.returning, false);
    assert.equal(uniforms.uReturning.value, 0, 'settled cluster retained return styling');
    assert.equal(h.api.worm.kind, null);
    cases++;
  } finally {
    h.layer.dispose();
  }
}
// Recoil uses the same scalar as the picture, and repress in either half of
// either direction must preserve the current geometry, arc and one-shot setup.
for (const calm of [false, true]) {
  for (const leg of ['enter', 'exit']) {
    for (const portion of [0.2, 0.8]) {
      const h = harness(calm);
      if (leg === 'exit') { h.api.startHold('enter', event); h.frame(2.5); }
      const start = h.context.now / 1000;
      const duration = leg === 'enter' ? (calm ? 0.17 : 2.32) : (calm ? 1 / 0.95 : 1.2);
      const pointer = { ...event, button: leg === 'exit' ? 2 : 0 };
      h.api.startHold(leg, pointer);
      h.frame(start + duration * portion);
      const released = h.ring.progress;
      h.api.cancelHold();
      assert.equal(h.ring.visible, true, 'release hid the arc instead of unwinding');
      assert.equal(h.ring.progress, released, 'release snapped the arc');
      h.frame(start + duration * portion + 0.03);
      assert.ok(h.ring.progress < released, 'recoil did not unwind the arc');
      const progress = h.context.machine.progress;
      const ring = h.ring.progress;
      const captures = h.context.disk.captures;
      const positions = stations.map((_, i) => h.layer.positionAt(i));
      assert.equal(h.api.startHold(leg, pointer), true);
      assert.ok(Math.abs(h.ring.progress - ring) < 1e-12, 'repress snapped the arc');
      h.api.advanceWormhole(h.context.now);
      h.layer.update(0, camera, 900);
      assert.ok(Math.abs(h.context.machine.progress - progress) < 1e-4, 'repress jumped the geometry');
      // A resume has to be a resume, not a freeze: the arc moving on does not
      // prove the geometry did. Step the same leg one frame further and require
      // it to advance by a visible-but-continuous amount from where it stood.
      const resumed = h.context.machine.progress;
      h.api.advanceWormhole(h.context.now + 16);
      h.layer.update(0, camera, 900);
      const step = Math.abs(h.context.machine.progress - resumed);
      assert.ok(step > 1e-6, 'repress left the geometry frozen');
      // One 16 ms frame cannot cover more than a fraction of the leg, whatever
      // that leg's length is; a restart would overshoot by the leg's head start.
      assert.ok(step < 16 / (duration * 1000) * 2, 'repress restarted the leg instead of continuing it');
      assert.equal(h.context.disk.captures, captures, 'repress recaptured the scene');
      for (let i = 0; i < positions.length; i++) {
        const p = h.layer.positionAt(i), before = positions[i];
        assert.ok(Math.hypot(p.x-before.x,p.y-before.y,p.z-before.z) < 1e-4, 'repress teleported a particle');
      }
      h.api.cancelHold();
      h.frame(h.context.now / 1000 + 1);
      assert.equal(h.context.machine.progress, leg === 'exit' ? 1 : 0);
      assert.equal(h.ring.visible, false);
      assert.equal(h.api.worm.kind, null);
      h.layer.dispose(); cases++;
    }
  }
}
// Both modes and a subsequent size refit keep the same far stop. Defaults are
// unchanged: only the allowed zoom range grows, not the initial/home framing.
{
  const h = harness();
  const liveCamera = camera.clone();
  const rig = createCameraRig(liveCamera, { addEventListener() {}, removeEventListener() {} });
  h.context.camera = liveCamera;
  h.context.rig = rig;
  const home = rig.framing().home;
  const limits = h.api.holeOrbitLimits();
  assert.equal(limits.maxRadius, h.layout.maxRadius);
  rig.setLimits(limits);
  for (const key of ['radius', 'phi', 'theta']) assert.equal(rig.framing().home[key], home[key], `default ${key} changed`);
  assert.deepEqual(rig.framing().home.target, home.target);
  rig.setHome({ ...home, radius: limits.maxRadius, ...limits });
  for (let i = 0; i < 80; i++) rig.update(0.05);
  const position = liveCamera.position.clone(), rotation = liveCamera.quaternion.clone();
  h.api.startHold('enter', event); h.frame(2.5);
  assert.equal(rig.framing().home.maxRadius, limits.maxRadius, 'cluster enlarged the shared far stop');
  h.api.startHold('exit', { ...event, button: 2 });
  for (let n = 1; n <= 180; n++) h.frame(2.5 + n / 60);
  rig.setLimits(h.api.holeOrbitLimits()); // Same refit performed after a canvas resize.
  rig.update(0.05);
  assert.equal(rig.framing().home.maxRadius, limits.maxRadius);
  assert.ok(liveCamera.position.distanceTo(position) < 1e-9, 'far return/size refit pulled the camera closer');
  assert.ok(1 - Math.abs(liveCamera.quaternion.dot(rotation)) < 1e-12);
  rig.dispose(); h.layer.dispose(); cases++;
}
// Real camera transforms must remain fixed, including a focused near view,
// a far cluster view beyond the hole's usual ceiling, and unfinished damping.
for (const calm of [false, true]) {
  for (const radius of [2.35, 28, 80]) {
    for (const cancel of [false, true]) {
      const h = harness(calm);
      h.api.startHold('enter', event); h.frame(2.5);
      const liveCamera = camera.clone();
      const rig = createCameraRig(liveCamera, {
        addEventListener() {}, removeEventListener() {},
      });
      rig.setHome({ radius, phi: 1.2, theta: 2, target: { x: 3, y: 2, z: 1 }, minRadius: 2.2, maxRadius: 100 });
      for (let i = 0; i < 80; i++) rig.update(0.05);
      if (radius < 6) {
        rig.focusOn({ x: 1, y: 2, z: 3 }, { distance: radius });
        for (let i = 0; i < 80; i++) rig.update(0.05);
        assert.ok(Math.abs(rig.framing().radius - radius) < 1e-9, 'near-focus fixture did not reach the requested radius');
      } else if (radius === 28) {
        rig.setHome({ radius: 40, theta: 2.5, minRadius: 2.2, maxRadius: 100 });
        rig.update(0.01);
        assert.equal(rig.isSettled, false);
      }
      h.context.camera = liveCamera;
      h.context.rig = rig;
      h.context.selectedIndex = 0;
      h.context.selectedId = stations[0].id;
      const position = liveCamera.position.clone(), rotation = liveCamera.quaternion.clone();
      const unchanged = () => {
        assert.ok(liveCamera.position.distanceTo(position) < 1e-9, 'return/cancel moved the current camera');
        assert.ok(1 - Math.abs(liveCamera.quaternion.dot(rotation)) < 1e-12, 'return/cancel rotated the current camera');
      };
      h.api.startHold('exit', { ...event, button: 2 });
      if (!calm) {
        const captured = h.context.disk.capturedCamera;
        assert.ok(captured.position.distanceTo(position) < 1e-9, 'return captured a default camera instead of the live view');
        assert.ok(1 - Math.abs(captured.quaternion.dot(rotation)) < 1e-12);
      }
      unchanged();
      for (let n = 1; n <= 180; n++) {
        h.frame(2.5 + n / 60);
        if (cancel && n === 20) h.api.cancelHold();
        unchanged();
      }
      assert.equal(h.context.machine.progress, cancel ? 1 : 0);
      assert.equal(rig.isSettled, true);
      rig.dispose(); h.layer.dispose(); cases++;
    }
  }
}
// Exercise the real DOM ring implementation without a browser or timed waits.
// Only the document/timer boundary is stubbed; SVG and style writes are real.
{
  const timers = new Map();
  let timerId = 0;
  const node = () => ({
    style: {}, attributes: {}, children: [], parentNode: null, visibleFlushes: 0,
    getBoundingClientRect() {
      assert.equal(this.style.opacity, '1', 'completion did not commit a visible ring');
      this.visibleFlushes++;
      return {};
    },
    setAttribute(k, v) { this.attributes[k] = v; },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
  });
  const ringContext = vm.createContext({
    document: { createElement: node, createElementNS: node },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  const ringSource = readFileSync(new URL('../src/nodes/hold-ring.js', import.meta.url), 'utf8');
  vm.runInContext(ringSource.replace('export function createHoldRing', 'function createHoldRing') + '\nglobalThis.createHoldRing = createHoldRing;', ringContext);
  const container = node();
  const ring = ringContext.createHoldRing(container);
  const arc = ring.element.children[0].children[2];
  ring.show(100, 100); ring.setProgress(0);
  assert.equal(ring.element.style.opacity, '1');
  assert.equal(ring.element.style.transition, 'none', 'entry ring still has a delayed fade-in');
  ring.setProgress(0.5);
  assert.ok(Math.abs(+arc.attributes['stroke-dashoffset'] - Math.PI * 17) < 1e-10);
  ring.complete();
  assert.equal(arc.attributes['stroke-dashoffset'], '0');
  assert.match(ring.element.style.transition, /220ms/);
  ring.show(100, 100); ring.setProgress(0.1);
  assert.equal(timers.size, 0, 'repress left a stale completion timer');
  assert.equal(ring.element.style.transition, 'none');
  ring.hide(); ring.setProgress(0.2, 100, 100);
  assert.equal(ring.element.style.opacity, '1');
  assert.equal(ring.element.style.transition, 'none', 'delayed exit appearance still fades in');
  ring.dispose();
  assert.equal(container.children.length, 0);
  console.log('PASS real SVG ring: immediate show/re-show, same-clock arc, full endpoint and completion-timer cancellation.');
}
// The production quality controller must lower GPU raster work without
// changing the transition clock, and restore the resting resolution afterwards.
{
  let pixelRatio = 2, resizeCount = 0;
  const quality = vm.createContext({
    ratio: 2, viewport: { w: 1920, h: 1080 }, worm: { kind: 'enter' },
    renderer: { getPixelRatio: () => pixelRatio, setPixelRatio: (v) => { pixelRatio = v; } },
    applySize(force) { assert.equal(force, true); resizeCount++; }, dirty: false, Math,
  });
  vm.runInContext(`let qualityAt = 0, qualitySlow = 0; ${declaration('updateTransitionQuality')} globalThis.update = updateTransitionQuality;`, quality);
  quality.update(1000, 16.7);
  const budget = pixelRatio;
  assert.ok(budget < 0.6 && budget >= 0.5, 'entry did not cap the raster budget');
  for (let n = 1; n <= 3; n++) quality.update(1000 + n * 110, 30);
  assert.equal(pixelRatio, 0.5, 'sustained slow frames did not lower quality to its floor');
  quality.update(1700, 250);
  assert.equal(pixelRatio, 0.5, 'background pause changed the floor');
  quality.worm.kind = null;
  for (let n = 1; n <= 20; n++) quality.update(1700 + n * 310, 16.7);
  assert.equal(pixelRatio, 2, 'resting pixel ratio was not restored');
  assert.ok(resizeCount > 1 && quality.dirty, 'quality changes did not resize/redraw');
  console.log('PASS adaptive raster budget: entry cap, consecutive slow frames, floor, pause and idle restoration.');
}
// Sprite sizes are in CSS pixels; the uniform must track even sub-1 DPR.
{
  const layer = createStationsLayer(stations, { seed: 7 });
  for (const ratio of [0.5, 0.581, 1, 2]) {
    layer.setPixelRatio(ratio);
    assert.equal(layer.object.material.uniforms.uPixelRatio.value, ratio);
  }
  layer.dispose();
  console.log('PASS particle pixel ratio follows reduced raster resolution without inflating sprites.');
}
// Sample the exact production flight function, not a duplicate implementation.
{
  const layerSource = readFileSync(new URL('../src/nodes/stations-layer.js', import.meta.url), 'utf8');
  const start = layerSource.indexOf('  function sampleFlight(');
  const end = layerSource.indexOf('\n  }', start) + 4;
  const flight = vm.createContext({ returning: true, flightPosition: new Vector3(), Math,
    wrapAngle: (v) => Math.atan2(Math.sin(v), Math.cos(v)), RS: 1 });
  vm.runInContext(`${layerSource.slice(start, end)} globalThis.sample = sampleFlight;`, flight);
  const args = [2, 0.1, 0, -12, 7, 8];
  const destination = flight.sample(...args, 1).clone();
  const origin = flight.sample(...args, 0).clone();
  assert.ok(destination.distanceTo(new Vector3(-12, 7, 8)) < 1e-10);
  assert.ok(origin.distanceTo(new Vector3(2, 0.1, 0)) < 1e-10);
  let radius = Math.hypot(destination.x, destination.z);
  let angle = Math.atan2(destination.z, destination.x);
  for (let n = 1; n <= 150; n++) {
    const p = flight.sample(...args, 1 - n / 150);
    const next = Math.hypot(p.x, p.z);
    const nextAngle = Math.atan2(p.z, p.x);
    const turn = Math.atan2(Math.sin(nextAngle - angle), Math.cos(nextAngle - angle));
    assert.ok(next <= radius + 1e-10, 'return radius re-expanded while gathering');
    assert.ok(turn < 0, 'return spiral reversed direction');
    assert.ok(Number.isFinite(p.y)); radius = next; angle = nextAngle;
  }
  console.log('PASS return flight: exact live endpoints, continuous polar gathering without radial rebound.');
}
// The settled return keeps its live population, but never turns its veil into
// flying band fragments. Check the real buffers and material, not a mock layer.
{
  const layer = createStationsLayer(stations, { seed: 7 });
  try {
    const layout = buildClusterLayout(stations, { seed: 7, vocabulary: GENRE_IDS, byGenre: true, forms: true });
    layer.setCluster(layout);
    layer.setClusterAmount(1);
    layer.setFlow(1);
    layer.update(1 / 60, camera, 900);
    const geometry = layer.object.geometry;
    const start = geometry.attributes.position.array.slice();
    const ids = geometry.attributes.aStation.array.slice();
    const material = layer.object.material;
    layer.setReturning(true);
    assert.equal(material.uniforms.uReturning?.value, 1, 'return still wears disk-band sprites');
    layer.update(1 / 60, camera, 900);
    assert.deepEqual(geometry.attributes.position.array, start, 'return moved the initial cluster');
    const snapshots = new Map();
    for (const blend of [1, 0.8, 0.5, 0.2, 0, 0.2, 0.5, 0.8, 1]) {
      layer.setFlow(blend);
      layer.update(1 / 60, camera, 900);
      const positions = geometry.attributes.position.array;
      if (snapshots.has(blend)) assert.deepEqual(positions, snapshots.get(blend), 'return scatter does not retrace on cancel');
      else snapshots.set(blend, positions.slice());
      assert.deepEqual(geometry.attributes.aStation.array, ids, 'return replaced station identities');
      if (blend === 0.5) {
        let scattered = 0;
        for (let i = 0; i < ids.length; i++) {
          const centre = layer.positionAt(ids[i]);
          const distance = Math.hypot(positions[i * 3] - centre.x, positions[i * 3 + 1] - centre.y, positions[i * 3 + 2] - centre.z);
          if (distance > 0.2) scattered++;
        }
        assert.ok(scattered > ids.length / 2, 'return particles still fly as rigid station knots');
      }
    }
    layer.setFlow(0);
    layer.update(1 / 60, camera, 900);
    layer.setReturning(false);
    layer.update(1 / 60, camera, 900);
    assert.deepEqual(geometry.attributes.position.array, snapshots.get(0), 'scatter changed the final disc');
    assert.equal(material.uniforms.uReturning.value, 0, 'return styling leaked into the resting disc');
    const shader = material.vertexShader;
    const step = (a, b, x) => smoothstep01(clamp01((x - a) / (b - a)));
    const code = shader.slice(shader.indexOf('    float point = '), shader.indexOf('    gl_PointSize = '));
    assert.ok(code.includes('uReturning') && code.includes('min(sizePx, 2.2)'), 'return does not cap airborne dots');
    const size = new Function('uReturning', 'aCluster', 'sizePx', 'smoothstep', 'mix', 'min', `${code.replace(/\bfloat\b/g, 'let')} return sizePx;`);
    const mix = (a, b, t) => a + (b - a) * t;
    assert.equal(size(1, 1, 12, step, mix, Math.min), 12, 'first return frame changed live star size');
    assert.ok(Math.abs(size(1, 0.5, 12, step, mix, Math.min) - 2.2) < 1e-10, 'return veil is still a large shard');
    assert.equal(size(0, 0.5, 12, step, mix, Math.min), 12, 'ordinary stars changed size');
    assert.match(material.fragmentShader, /float shape = max\(vCluster, uReturning\);/);
    assert.match(material.fragmentShader, /float e = mix\(eDisk, eStar, shape\);/);
    console.log('PASS live return points: unchanged population/endpoints, individual spatial breakup, exact cancel replay, compact round flight material (CPU/scalar GLSL only).');
  } finally {
    layer.dispose();
  }
}
// True-image return: same live buffers, exact sampled landing pixels and a
// complementary per-pixel light handoff, including a deterministic cancellation.
{
  const layer = createStationsLayer(stations, { seed: 7 });
  try {
    const layout = buildClusterLayout(stations, { seed: 7, vocabulary: GENRE_IDS, byGenre: true, forms: true });
    const data = buildDiscFragments({ width: 13, height: 8, camera,
      pixels: new Uint8Array(13 * 8 * 4).fill(255),
      ids: Float32Array.from({ length: 13 * 8 }, (_, i) => i) }, layout);
    layer.setCluster(layout); layer.setFlow(1); layer.update(1 / 60, camera, 900);
    const geometry = layer.object.geometry, material = layer.object.material;
    const ids = geometry.attributes.aStation.array.slice();
    const initial = geometry.attributes.position.array.slice();
    layer.setReturnDisc(data); layer.setReturning(true);
    const snapshots = new Map();
    for (const gather of [0, 0.1, 0.3, 0.6, 0.8, 0.95, 1, 0.8, 0.3, 0]) {
      layer.setFlow(1 - smoothstep01(gather)); layer.update(1 / 60, camera, 900);
      assert.equal(layer.object.geometry, geometry, 'return replaced live geometry');
      assert.equal(layer.object.material, material, 'return replaced live material');
      assert.deepEqual(geometry.attributes.aStation.array, ids);
      const positions = geometry.attributes.position.array;
      const alpha = geometry.attributes.aReturnAlpha.array;
      assert.ok(positions.every(Number.isFinite), 'return produced nonfinite positions');
      if (snapshots.has(gather)) assert.deepEqual(positions, snapshots.get(gather), 'mapped return did not retrace');
      else snapshots.set(gather, positions.slice());
      if (gather === 0) assert.deepEqual(positions, initial, 'return cut the initial cluster');
      for (let p = 0; p < ids.length; p++) {
        const cell = data.station.indexOf(ids[p]);
        const phase = discReturnPhase(data.uv[cell * 2], data.uv[cell * 2 + 1]);
        const reveal = smoothstep01(clamp01((gather - phase) / 0.10));
        assert.ok(Math.abs(alpha[p] + reveal - 1) < 1e-5, 'point and true disc have different merge clocks');
        if (gather >= phase) for (let axis = 0; axis < 3; axis++) {
          assert.ok(Math.abs(positions[p * 3 + axis] - data.source[cell * 3 + axis]) < 1e-5,
            'return landed on the physical ring instead of the actual imaged disc');
        }
      }
    }
    assert.match(material.vertexShader, /max\(clamp\(aCluster, 0\.0, 1\.0\), uReturning\)/);
    const shader = buildFragmentShader();
    assert.ok(shader.includes('color = mix(sky, color, reveal);'));
    assert.ok(shader.includes('float reveal = smoothstep(phase, phase + 0.10, uDiscReturn);'));
    console.log('PASS true-image return: live buffer identity, local scatter, exact imaged landing, complementary reveal and exact cancel replay (CPU/scalar GLSL only).');
  } finally { layer.dispose(); }
}
const tickStart = source.indexOf('    const tick = ');
const tickEnd = source.indexOf('\n    };', tickStart);
const tick = source.slice(tickStart, tickEnd);
assert.ok(tick.indexOf('advanceWormhole(now)') < tick.indexOf('layer.update(dt, camera, viewport.h)'));
assert.ok(tick.indexOf('layer.update(dt, camera, viewport.h)') < tick.indexOf('if (dirty) draw()'));
assert.ok(tick.indexOf('if (dirty) draw()') < tick.indexOf('if (worm.pulseEnd)'));
// The exit lands through `handOver`, which snaps progress to its target, so the
// ordinary tween branch never runs and finishTransition is never reached. Only
// the tick's landed branch can retire the ring and report black-hole; dropping
// it left the ring full and the machine stuck in cluster mode (2026-11-03).
assert.ok(tick.includes('if (worm.landed) finishWormhole();'), 'the tick no longer closes the exit landing');
assert.ok(
  tick.indexOf('if (dirty) draw()') < tick.indexOf('if (worm.landed) finishWormhole();'),
  'the exit closed before its endpoint was drawn',
);
assert.ok(tick.includes('if (!worm.kind && machine.progress !== machine.target)'));
assert.equal(tick.includes('layer.setHoleOnly('), false, 'tick has a second visibility owner');
// A quick release on the hole is a tap even though the press was consumed at
// pointer down: the host needs that tap to open its search box, and the tap has
// to survive the recoil its own cancelled wind-up leaves behind.
{
  const gate = source.indexOf('const wormIdle = !worm.kind');
  assert.ok(gate > 0, 'the consumed press never reaches the hole tap');
  const tap = source.indexOf('settings.onHoleTap()', gate);
  assert.ok(tap > gate, 'the hole tap gate does not reach the host callback');
  const guard = source.slice(gate, tap);
  assert.ok(guard.includes("worm.kind === 'recoil'"), 'a cancelled wind-up swallows the tap');
  assert.ok(guard.includes('isSelectionGesture(tapMoved, tapHeld)'), 'the tap ignores the click geometry');
  assert.ok(guard.includes('centerAt(press.downX, press.downY).inside'), 'the tap is not anchored to the press origin');
  console.log('PASS hole tap survives the consumed press: recoil is not a crossing, geometry and origin still gate the host callback.');
}
// The right button does two things, decided by how long it is held: past a
// click's length it gathers the cluster back into a disc, and shorter than that
// it is a click that asks the host for the library where the press landed. The
// ring is only ever drawn by the hold, so a short press never leaves one behind.
{
  const down = source.indexOf("if (event.button === 2) {", source.indexOf('const onPointerDown'));
  const up = source.indexOf('const onPointerUp');
  assert.ok(down > 0 && down < up, 'the right-button press has no branch of its own');
  const branch = source.slice(down, source.indexOf('if (event.button !== 0) return;', down));
  assert.ok(branch.includes('armRightHold(event)'), 'the right button no longer arms the gathering hold');
  assert.ok(branch.includes('armRightHold(event, false)'), 'a press in the hole cannot ask for the library');
  assert.ok(!branch.includes('menuHoldTimer'), 'the right button still waits on a tap window');
  assert.ok(branch.includes("machine.mode === 'black-hole'"), 'the right button holds inside the hole');
  assert.ok(source.includes('const RIGHT_HOLD_DELAY_S = 0.12;'), 'the right hold has no click-length delay');
  const arm = source.slice(source.indexOf('const armRightHold ='), source.indexOf('const centerAt ='));
  assert.ok(arm.includes('setTimeout('), 'the delayed hold is never scheduled');
  assert.ok(arm.includes('RIGHT_HOLD_DELAY_S * 1000'), 'the delay is not the shared constant');
  assert.ok(arm.includes("startHold('exit', pending.press, pending.since)"), 'the delayed press never becomes a hold');
  assert.ok(source.includes("(typeof sinceMs === 'number' ? sinceMs : performance.now())"), 'the hold clock ignores the real press');
  const upSlice = source.slice(up, source.indexOf('if (!press.active || press.id !== event.pointerId) return;', up));
  assert.ok(upSlice.includes("settings.onFavourites(clicked.press.clientX, clicked.press.clientY)"), 'a short right press never asks for the library');
  assert.ok(upSlice.includes('clicked.press.pointerId === event.pointerId'), 'another pointer may take the click over');
  assert.ok(upSlice.includes('cancelHold()'), 'releasing before the ring fills does not cancel');
  const move = source.slice(source.indexOf('const onPointerMove'), up);
  assert.ok(move.includes('exitArm.press.clientX'), 'a drag cannot take the pending hold back');
  assert.ok(arm.includes('pending.holdable'), 'a click-only press is never retired');
}
console.log(`PASS ${cases} transition cases + production frame ordering; 13 nonempty fixture groups; real particle buffers and interaction anchors. GPU/browser acceptance NOT exercised.`);
if (process.argv.includes('--bundles')) {
  for (const file of ['client.js', 'client.stage.js']) {
    let registration;
    const context = vm.createContext({
      window: { __ModuleLoader__: { load(value) { registration = value; } } },
      console, setTimeout, clearTimeout, URL, URLSearchParams, TextDecoder, TextEncoder, AbortController,
    });
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, { filename: file });
    assert.equal(registration.id, 'dsh-blackhole-radio-lab');
    const exports = registration.factory((name) => { assert.equal(name, 'react'); return {}; });
    const keys = Object.keys(exports).sort();
    assert.deepEqual(keys, file === 'client.js' ? ['apply', 'inject'] : ['STAGE_PHASE', 'isSelectionGesture', 'mountStage']);
    console.log(`PASS loader ${file}: ${registration.id} ${JSON.stringify(keys)}`);
  }
}
