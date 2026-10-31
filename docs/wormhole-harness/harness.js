/**
 * GPU harness for the wormhole transition pass.
 *
 * The stage cannot be checked from Node: `src/scene/wormhole.js` is a shader,
 * and a shader that fails to link still builds, still type-checks and still
 * passes every CPU validator. So the only honest questions — does it compile,
 * does it put light on the screen, how long does a frame take — are asked here,
 * in a real WebGL context.
 *
 * It renders the pass on its own over black at three moments of the crossing
 * (the charge, the middle of the tube, the exit ring), reads the pixels back,
 * and times a run of frames with the GPU synchronised so the number is the
 * frame's cost rather than the driver's queue.
 *
 * Usage: node tools/harness-server.mjs --port 8741
 *        open http://127.0.0.1:8741/docs/wormhole-harness/
 */

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Color,
} from 'three';

import { createWormhole } from '/src/scene/wormhole.js';

const WIDTH = 1280;
const HEIGHT = 720;

/** The three moments the design cares about, as the stage drives them. */
const MOMENTS = [
  {
    name: 'charge',
    note: '蓄力：洞口从黑洞阴影张开（t≈0.6s / 2.5s）',
    frame: {
      center: { x: 0.5, y: 0.5 },
      shadow: 0.1,
      mouth: 0.24,
      alpha: 0.8,
      streak: 0.75,
      rim: 0.95,
      progress: 0.24,
      throat: 0.55,
      exitR: 0.045,
      exitGlow: 0.25,
      exitAlpha: 0,
    },
  },
  {
    name: 'tube',
    note: '管内推进：口已覆盖全屏（t≈1.5s / 2.5s）',
    frame: {
      center: { x: 0.5, y: 0.5 },
      shadow: 0.1,
      mouth: 1.15,
      alpha: 1,
      streak: 1,
      rim: 1,
      progress: 0.6,
      throat: 0.55,
      exitR: 0.37,
      exitGlow: 0.41,
      exitAlpha: 0.83,
    },
  },
  {
    name: 'exit',
    note: '出口：光点撑满画面（t≈2.0s / 2.5s）',
    frame: {
      center: { x: 0.5, y: 0.5 },
      shadow: 0.1,
      mouth: 1.15,
      alpha: 1,
      streak: 0.5,
      rim: 0.6,
      progress: 0.8,
      throat: 0.55,
      exitR: 1.12,
      exitGlow: 0.8,
      exitAlpha: 1,
    },
  },
];

const stage = document.getElementById('stage');
const readout = document.getElementById('readout');

const renderer = new WebGLRenderer({
  antialias: false,
  alpha: false,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setClearColor(new Color(0x030408), 1);
stage.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 100);
camera.position.set(0, 0, 6);

const worm = createWormhole();
worm.setViewport(WIDTH, HEIGHT);
worm.object.renderOrder = 0;
scene.add(worm.object);

worm.object.visible = true;
worm.setPhase(MOMENTS[0].frame);
renderer.render(scene, camera);

/**
 * three keeps the link log on the program, and `diagnostics.runnable` is the
 * one field that answers "would this have drawn anything".
 */
function shaderReport() {
  const programs = (renderer.info && renderer.info.programs) || [];
  if (programs.length === 0) return { programs: 0, runnable: null, log: 'no program cached' };
  const failed = programs.filter((program) => program.diagnostics && program.diagnostics.runnable === false);
  const log = failed
    .map((program) => {
      const d = program.diagnostics;
      const frag = (d.fragmentShader && d.fragmentShader.log) || '';
      const vert = (d.vertexShader && d.vertexShader.log) || '';
      return [frag.trim(), vert.trim(), (d.programLog || '').trim()].filter(Boolean).join(' | ');
    })
    .join(' || ');
  return { programs: programs.length, runnable: failed.length === 0, log: log || 'ok' };
}

/** Read the whole frame back and describe what the pass actually painted. */
function sample() {
  const gl = renderer.getContext();
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let lit = 0;
  let sum = 0;
  let max = 0;
  let warm = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    if (luma > max) max = luma;
    if (luma > 6) lit += 1;
    if (r > g + 12 && g > b) warm += 1;
  }
  const total = WIDTH * HEIGHT;
  return {
    litPixels: lit,
    liveRatio: +(lit / total).toFixed(4),
    meanLuma: +(sum / total).toFixed(3),
    maxLuma: +max.toFixed(1),
    warmRatio: +(warm / total).toFixed(4),
  };
}

/**
 * Time a run of frames with a real synchronisation after each one.
 *
 * gl.finish() is not enough: Chrome's ANGLE backend returns before the GPU has
 * drawn, which reported this pass at 0.15 ms — a number no 44-step raymarch at
 * 1280x720 can hit. A one-pixel readPixels is the portable way to wait for the
 * frame, so the number below is the frame's cost rather than the queue's.
 */
function timeFrames(frames) {
  const gl = renderer.getContext();
  const probe = new Uint8Array(4);
  const times = [];
  for (let i = 0; i < frames; i += 1) {
    const phase = (i % 40) / 40;
    worm.setPhase({ ...MOMENTS[1].frame, progress: 0.2 + phase * 0.7, mouth: 0.9 });
    worm.update(1 / 60);
    const t0 = performance.now();
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    frames,
    meanMs: +mean.toFixed(2),
    medianMs: +at(0.5).toFixed(2),
    p95Ms: +at(0.95).toFixed(2),
    maxMs: +times[times.length - 1].toFixed(2),
    fps: +(1000 / mean).toFixed(1),
  };
}

function run() {
  const report = { width: WIDTH, height: HEIGHT, moments: [] };
  for (const moment of MOMENTS) {
    worm.reset();
    worm.setPhase(moment.frame);
    worm.update(0.4);
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    gl.finish();
    report.moments.push({ name: moment.name, note: moment.note, pixels: sample() });
  }
  report.shader = shaderReport();
  report.timing = timeFrames(120);
  report.renderer = (() => {
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  })();
  window.__wormholeHarness = report;
  readout.textContent = [
    `shader  ${report.shader.runnable ? 'OK' : 'FAILED'}  (${report.shader.programs} program)`,
    report.shader.runnable ? '' : report.shader.log,
    ...report.moments.map((m) => `${m.name.padEnd(7)} lit ${m.pixels.liveRatio}  luma ${m.pixels.meanLuma}  warm ${m.pixels.warmRatio}`),
    `timing  mean ${report.timing.meanMs}ms  p95 ${report.timing.p95Ms}ms  ~${report.timing.fps}fps`,
    report.renderer,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Show one moment and hold it, for a screenshot or a manual look.
 * `__wormholeShow('exit')` leaves the pass on the exit ring.
 */
window.__wormholeShow = (name) => {
  const moment = MOMENTS.find((entry) => entry.name === name) || MOMENTS[0];
  worm.setPhase(moment.frame);
  worm.update(0.5);
  renderer.render(scene, camera);
  return moment.name;
};

try {
  run();
} catch (error) {
  window.__wormholeHarness = { error: String(error && error.stack ? error.stack : error) };
  readout.textContent = `harness failed\n${error}`;
}
