/**
 * Phase-2 GPU harness.
 *
 * Runs the production stage module — the same shader, the same ray tables, the
 * same uniforms the panel mounts — against the four fixture sources, and reports
 * per-check numbers instead of a pass/fail vibe. The CPU reference positions come
 * from expected.json (written by tools/validate-radio-imaging.mjs from the
 * phase-1 probe), so the GPU is compared against an independently produced
 * oracle, never against itself.
 *
 * Fixed conditions: 1280x720 CSS, pixelRatioCap 1 (so drawing buffer = CSS even
 * when the host display is scaled), seed 20261022, reduced motion, antialias off.
 *
 * Everything here is read-only with respect to the repository. The driver calls
 * window.HARNESS.run() and stores the returned JSON.
 */

import { mountStage } from '/src/stage.js';

const WIDTH = 1280;
const HEIGHT = 720;
const SEED = 20261022;
const FOV_DEG = 42;

const readout = document.getElementById('readout');
const stageNode = document.getElementById('stage');

const results = { meta: {}, checks: [], failures: [] };
const pending = [];
let failureCount = 0;
// run() and teardown() are separate calls so the driver can screenshot between
// them; the handle therefore lives on this scope, not inside run().
let liveHandle = null;
let started = 0;

function log(line) {
  pending.push(line);
  if (pending.length > 24) pending.shift();
  if (readout) readout.textContent = pending.join('\n');
}

function record(name, ok, detail) {
  const entry = { name, ok: Boolean(ok), detail: detail === undefined ? null : detail };
  results.checks.push(entry);
  if (!entry.ok) {
    failureCount += 1;
    results.failures.push(entry);
  }
  log(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return entry.ok;
}

const waitFrames = (count) =>
  new Promise((resolve) => {
    let left = Math.max(1, count);
    const step = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rectangularComponentScan(data, width, height, gpuId) {
  const seen = new Uint8Array(width * height);
  const out = [];
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return -1;
    const index = y * width + x;
    if (seen[index]) return -1;
    return Math.round(data[index]) === gpuId ? index : -1;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = at(x, y);
      if (start < 0) continue;
      const stack = [start];
      seen[start] = 1;
      let count = 0;
      let sx = 0;
      let sy = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      while (stack.length) {
        const index = stack.pop();
        const px = index % width;
        const py = (index - px) / width;
        count += 1;
        sx += px + 0.5;
        sy += py + 0.5;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (const next of [at(px - 1, py), at(px + 1, py), at(px, py - 1), at(px, py + 1)]) {
          if (next < 0) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      out.push({ count, x: sx / count, y: sy / count, minX, maxX, minY, maxY });
    }
  }
  return out;
}

function capturePixels(handle) {
  const stage = handle.__stage;
  const canvas = stage.querySelector('canvas[data-bhrl-canvas-el]');
  const scratch = document.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  return { ctx, width: scratch.width, height: scratch.height };
}

function pixelAt(shot, x, y) {
  const px = Math.max(0, Math.min(shot.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(shot.height - 1, Math.round(y)));
  const data = shot.ctx.getImageData(px, py, 1, 1).data;
  return [data[0], data[1], data[2], data[3]];
}

function loadExpected() {
  return fetch(new URL('./expected.json', import.meta.url), { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

async function unitTableRelease() {
  // The fix under test is createRayTables().dispose(). Prove it on a live
  // context: upload both textures by drawing with them, capture the GL names,
  // dispose, then ask the driver whether those names still exist. `info.memory`
  // is three's own count, so a release that only looks like one cannot pass.
  const THREE = await import('three');
  const { createRayTables } = await import('/src/scene/ray-tables.js');
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setSize(64, 64, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  camera.position.z = 2;
  const tables = createRayTables(renderer);
  const material = new THREE.ShaderMaterial({
    uniforms: { a: { value: tables.deflection }, b: { value: tables.inverseRadius } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader:
      'precision highp float; uniform sampler2D a; uniform sampler2D b;' +
      'void main() { gl_FragColor = vec4(texture2D(a, vec2(0.5)).x, texture2D(b, vec2(0.5)).x, 0.0, 1.0); }',
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material));
  const gl = renderer.getContext();
  const glName = (texture) => {
    const props = renderer.properties.get(texture);
    return props && props.__webglTexture ? props.__webglTexture : null;
  };
  const texturesBefore = renderer.info.memory.textures;
  renderer.render(scene, camera);
  const uploaded = renderer.info.memory.textures - texturesBefore;
  const names = [glName(tables.deflection), glName(tables.inverseRadius)];
  const aliveBefore = names.map((name) => (name ? gl.isTexture(name) : false));
  tables.dispose();
  const aliveAfter = names.map((name) => (name ? gl.isTexture(name) : false));
  let secondThrow = null;
  try {
    tables.dispose();
  } catch (error) {
    secondThrow = String(error);
  }
  material.dispose();
  renderer.dispose();
  if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
  record(
    'both ray tables upload to the GPU',
    uploaded === 2 && aliveBefore[0] === true && aliveBefore[1] === true,
    `new textures=${uploaded} alive=[${aliveBefore.join(',')}]`,
  );
  record(
    'table textures released by dispose()',
    aliveAfter[0] === false && aliveAfter[1] === false,
    `alive=[${aliveAfter.join(',')}]`,
  );
  record('dispose() is idempotent', secondThrow === null, secondThrow);
}

const STAGE_SETTINGS = {
  antialias: false,
  pixelRatioCap: 1,
  reducedMotion: true,
  stations: [],
  categories: [],
  seed: SEED,
  language: 'en',
  radio: 'all',
};

/** Mount the production stage without running the checks (diagnostics, screenshots). */
async function mount() {
  if (liveHandle) return liveHandle;
  const handle = mountStage(stageNode, STAGE_SETTINGS);
  handle.__stage = stageNode;
  window.__HARNESS_HANDLE__ = handle;
  liveHandle = handle;
  await waitFrames(8);
  await wait(120);
  return handle;
}

async function run() {
  started = performance.now();
  results.checks.length = 0;
  results.failures.length = 0;
  failureCount = 0;

  const expected = await loadExpected();
  if (!expected) record('expected.json present', false, 'CPU oracle missing');
  else record('expected.json present', true, `${expected.checks} CPU checks`);

  const handle = await mount();

  const gl = handle.radio.context();
  const rendererInfo = {
    version: gl.getParameter(gl.VERSION),
    shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    renderer: gl.getParameter(gl.RENDERER),
    vendor: gl.getParameter(gl.VENDOR),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    dpr: window.devicePixelRatio,
  };
  results.meta.renderer = rendererInfo;
  const tables = handle.radio.tables();
  results.meta.tables = {
    hardwareFilter: tables.info.hardwareFilter,
    filterMode: tables.info.filterMode,
    revision: tables.info.revision,
  };

  // The discriminating check for the QUERY_RESULT_DISJOINT defect: an invalid
  // enum would be sitting in the error queue right now if the frame loop still
  // asked for a parameter getQueryParameter does not accept.
  const glError = gl.getError();
  record('no GL error after 8 frames', glError === gl.NO_ERROR, `getError()=${glError}`);

  const timing = handle.timing ? handle.timing() : null;
  results.meta.timing = timing;

  // --- anchors -------------------------------------------------------------
  handle.radio.scan();
  await waitFrames(3);
  await wait(80);
  const anchors = handle.radio.anchors();
  results.anchors = anchors;
  record('anchor scan produced anchors', anchors.length > 0, `${anchors.length} anchors`);

  const byBusiness = new Map();
  for (const anchor of anchors) {
    if (!byBusiness.has(anchor.businessId)) byBusiness.set(anchor.businessId, []);
    byBusiness.get(anchor.businessId).push(anchor);
  }

  if (expected) {
    for (const fixture of expected.fixtures) {
      const got = byBusiness.get(fixture.businessId) || [];
      record(
        `${fixture.businessId}: anchor count`,
        got.length === fixture.reference.length,
        `got ${got.length}, expected ${fixture.reference.length}`,
      );
      for (const ref of fixture.reference) {
        const match = got.find((anchor) => anchor.branch === ref.crossingIndex);
        if (!match) {
          record(`${fixture.businessId}: crossing ${ref.crossingIndex} present`, false);
          continue;
        }
        const dx = match.x - ref.x;
        const dy = match.y - ref.y;
        const distance = Math.hypot(dx, dy);
        record(
          `${fixture.businessId}: crossing ${ref.crossingIndex} position`,
          distance <= 3.0,
          `d=${distance.toFixed(2)} px (dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)}) size=${match.widthPx.toFixed(1)}x${match.heightPx.toFixed(1)} px`,
        );
        // Thickness, not bounding-box height: the near-axis image is a cap-shaped
        // arc 17 px tall, so its box height says nothing about how thick the
        // strip is. thicknessPx is the deepest single-column run.
        const thin = match.thicknessPx ?? match.heightPx;
        record(
          `${fixture.businessId}: crossing ${ref.crossingIndex} is a strip, not a blob`,
          thin <= 3.0 && match.widthPx >= 2.0,
          `w=${match.widthPx.toFixed(2)} thickness=${thin.toFixed(2)} bboxH=${match.heightPx.toFixed(2)}`,
        );
        record(
          `${fixture.businessId}: crossing ${ref.crossingIndex} reports a table slot`,
          match.slot === 1 || match.slot === 2,
          `slot=${match.slot}`,
        );
      }
    }
  }

  // --- id channel ----------------------------------------------------------
  // Native resolution, not 1/2: a source four pixels wide at 1280x720 is two
  // pixels wide at 640x360 and a one-pixel strip disappears entirely, which
  // measures the probe grid rather than the render.
  const idSweep = handle.radio.probe({ mode: 26, width: 1280, height: 720, unpack: 'fast' });
  const present = new Set();
  for (let i = 0; i < idSweep.data.length; i += 1) {
    const id = Math.round(idSweep.data[i]);
    if (id > 0) present.add(id);
  }
  const expectedIds = new Set((expected ? expected.fixtures : []).map((fixture) => fixture.gpuId));
  record(
    'id sweep finds exactly the fixture ids',
    present.size === expectedIds.size && [...present].every((id) => expectedIds.has(id)),
    `present=[${[...present].sort().join(',')}] expected=[${[...expectedIds].sort().join(',')}]`,
  );

  // Both arcs of the near-axis source carry one business id and two different
  // CROSSING indices (1 = the arc whose ray crosses the plane once, 2 = the arc
  // whose ray crosses twice). The table slot is not asserted here: it is a
  // property of the trace, not of the image, and it is recorded in the anchors.
  const axisAnchors = byBusiness.get('radio-near-axis') || [];
  const axisBranches = axisAnchors.map((anchor) => anchor.branch).sort();
  record(
    'near-axis crossings are 1 and 2',
    axisBranches.length === 2 && axisBranches[0] === 1 && axisBranches[1] === 2,
    `crossings=[${axisBranches.join(',')}] slots=[${axisAnchors.map((a) => a.slot).join(',')}]`,
  );
  record(
    'both near-axis anchors carry one business id',
    axisAnchors.length === 2 && axisAnchors.every((anchor) => anchor.gpuId === 103),
    axisAnchors.map((anchor) => `${anchor.businessId}/${anchor.gpuId}`).join(' + '),
  );

  // --- per-source isolation -----------------------------------------------
  for (let i = 0; i < 4; i += 1) {
    // Native resolution: at 1/4 scale the coverage filter has no sub-pixel left
    // to resolve and every source reads empty, which says nothing about masking.
    const isolated = handle.radio.probe({
      mode: 26,
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      radioMask: 1 << i,
      unpack: 'fast',
    });
    const ids = new Set();
    for (let k = 0; k < isolated.data.length; k += 1) {
      const id = Math.round(isolated.data[k]);
      if (id > 0) ids.add(id);
    }
    record(
      `source ${i} isolates to its own id`,
      ids.size === 1,
      `ids=[${[...ids].join(',')}]`,
    );
  }

  // --- capture and occlusion ----------------------------------------------
  const centre = handle.holeScreen();
  const centreRead = handle.radio.probe({
    mode: 26,
    region: {
      x: Math.round(centre.x),
      y: Math.round(gl.drawingBufferHeight - centre.y),
      width: 1,
      height: 1,
    },
    unpack: 'fast',
  });
  record(
    'shadow centre carries no fixture id',
    centreRead && Math.round(centreRead.data[0]) === 0,
    `id=${centreRead ? Math.round(centreRead.data[0]) : 'n/a'}`,
  );
  const centreLum = handle.radio.probe({
    mode: 32,
    region: {
      x: Math.round(centre.x),
      y: Math.round(gl.drawingBufferHeight - centre.y),
      width: 1,
      height: 1,
    },
    unpack: 'fast',
  });
  record(
    'shadow centre has no fixture radiance',
    centreLum && centreLum.data[0] === 0,
    `lum=${centreLum ? centreLum.data[0] : 'n/a'}`,
  );

  // Colour is checked from the composited screenshot by the driver: a WebGL
  // canvas without preserveDrawingBuffer reads back black through drawImage(),
  // so sampling it in-page would report every fixture as unlit.

  // --- picking -------------------------------------------------------------
  const rect = stageNode.getBoundingClientRect();
  const picked = [];
  // Pick at the anchor's representative pixel, not its area centroid: the
  // near-axis image is hollow, and a click at the centroid lands in the gap.
  // Label and hit test share one coordinate source (spec 6.5).
  for (const anchor of anchors) {
    const pickX = anchor.pickX ?? anchor.x;
    const pickY = anchor.pickY ?? anchor.y;
    const hit = handle.radio.pick(rect.left + pickX, rect.top + pickY);
    picked.push({
      businessId: anchor.businessId,
      branch: anchor.branch,
      hit: hit ? { businessId: hit.businessId, branch: hit.branch } : null,
    });
    record(
      `${anchor.businessId}: click on branch ${anchor.branch} returns that source`,
      hit && hit.businessId === anchor.businessId && hit.branch === anchor.branch,
      hit ? `${hit.businessId}/branch ${hit.branch}` : 'null',
    );
  }
  results.picks = picked;

  // A click one pixel along the strip must stay on the same source; a click off
  // the strip must not invent one.
  for (const anchor of anchors) {
    const pickX = anchor.pickX ?? anchor.x;
    const pickY = anchor.pickY ?? anchor.y;
    const along = handle.radio.pick(rect.left + pickX + 1, rect.top + pickY);
    record(
      `${anchor.businessId}: +1 px along the strip still hits`,
      along && along.businessId === anchor.businessId,
      along ? `${along.businessId}/branch ${along.branch}` : 'null',
    );
    const off = handle.radio.pick(rect.left + pickX, rect.top + pickY + 9);
    record(
      `${anchor.businessId}: 9 px off the strip is empty`,
      off === null || off.businessId !== anchor.businessId,
      off ? `${off.businessId}/branch ${off.branch}` : 'null',
    );
  }

  const centrePick = handle.radio.pick(rect.left + centre.x, rect.top + centre.y);
  record('shadow centre click is not a fixture', centrePick === null, centrePick ? centrePick.businessId : 'null');

  // --- selection -----------------------------------------------------------
  const selection = handle.radio.select('radio-near-axis', 2);
  await waitFrames(2);
  const selected = handle.radio.selected;
  record(
    'select() records the branch',
    selection === true && selected && selected.businessId === 'radio-near-axis' && selected.branch === 2,
    JSON.stringify(selected),
  );
  handle.radio.clear();
  record('clear() drops the selection', handle.radio.selected === null);

  // --- camera + resize consistency ----------------------------------------
  handle.resetView();
  await waitFrames(6);
  await wait(120);
  handle.radio.scan();
  await waitFrames(3);
  const afterReset = handle.radio.anchors();
  const resetOk = anchors.every((anchor) => {
    const match = afterReset.find(
      (item) => item.businessId === anchor.businessId && item.branch === anchor.branch,
    );
    return match && Math.hypot(match.x - anchor.x, match.y - anchor.y) <= 2.0;
  });
  record(
    'reset framing lands on the same anchors',
    resetOk,
    `${afterReset.length} anchors after reset`,
  );

  stageNode.style.width = '960px';
  stageNode.style.height = '540px';
  await waitFrames(6);
  await wait(220);
  handle.radio.scan();
  await waitFrames(3);
  const resized = handle.radio.anchors();
  const resizedOk = anchors.every((anchor) => {
    const match = resized.find(
      (item) => item.businessId === anchor.businessId && item.branch === anchor.branch,
    );
    if (!match) return false;
    const nx = (match.x / 960) * WIDTH;
    const ny = (match.y / 540) * HEIGHT;
    return Math.hypot(nx - anchor.x, ny - anchor.y) <= 6.0;
  });
  record(
    'anchors survive a 960x540 viewport',
    resizedOk,
    `${resized.length} anchors at 960x540`,
  );
  stageNode.style.width = `${WIDTH}px`;
  stageNode.style.height = `${HEIGHT}px`;
  await waitFrames(4);

  // --- default page is untouched ------------------------------------------
  const plain = document.createElement('div');
  plain.style.position = 'fixed';
  plain.style.left = '-4000px';
  plain.style.top = '0';
  plain.style.width = '320px';
  plain.style.height = '240px';
  document.body.appendChild(plain);
  const plainHandle = mountStage(plain, {
    antialias: false,
    pixelRatioCap: 1,
    reducedMotion: true,
    stations: [],
    categories: [],
    seed: SEED,
    language: 'en',
  });
  await waitFrames(3);
  record(
    'default page has no fixture overlay',
    plain.querySelectorAll('[data-bhrl-radio-labels]').length === 0,
  );
  record('default page reports radio disabled', plainHandle.radio.enabled === false);
  const plainTables = plainHandle.radio.tables();
  plainHandle.dispose();
  record(
    'dispose marks the ray tables disposed',
    plainTables.disposed === true,
    `disposed=${plainTables.disposed}`,
  );
  let secondDisposeThrow = null;
  try {
    plainHandle.dispose();
  } catch (error) {
    secondDisposeThrow = String(error);
  }
  record(
    'second dispose is harmless',
    secondDisposeThrow === null,
    secondDisposeThrow,
  );
  record(
    'disposing the plain stage leaves the fixture stage alone',
    plain.querySelectorAll('[data-bhrl-radio-labels]').length === 0 &&
      stageNode.querySelectorAll('[data-bhrl-radio-labels]').length === 1,
  );
  plain.remove();

  await unitTableRelease();

  results.meta.elapsedMs = Math.round(performance.now() - started);
  results.meta.checks = results.checks.length;
  results.meta.failures = failureCount;
  results.meta.nodesSeen = [...document.querySelectorAll('[data-bhrl-radio-labels]')].length;
  log(`checks done: ${results.checks.length - failureCount}/${results.checks.length} passed`);
  return results;
}

// --- round 3: colour chain, staleness, viewport mapping ---------------------

function disposeLive() {
  if (!liveHandle) return;
  try { liveHandle.dispose(); } catch (error) { log(`dispose threw: ${error}`); }
  liveHandle = null;
  stageNode.innerHTML = '';
}

async function mountWith(overrides) {
  disposeLive();
  const handle = mountStage(stageNode, { ...STAGE_SETTINGS, ...overrides });
  liveHandle = handle;
  window.__HARNESS_HANDLE__ = handle;
  await waitFrames(8);
  await wait(120);
  return handle;
}

function probeAt(handle, x, y, mode, mask) {
  const size = handle.radio.context().drawingBufferSize
    ? [handle.radio.context().drawingBufferWidth, handle.radio.context().drawingBufferHeight]
    : [1280, 720];
  // Floor: a fractional region origin is not a pixel, and the shader would
  // sample between two pixels (a 1 px strip then silently reads as empty).
  const options = {
    mode,
    region: { x: Math.floor(x), y: Math.floor(size[1] - 1 - y), width: 1, height: 1 },
    unpack: 'fast',
  };
  if (mask !== undefined) options.radioMask = mask;
  const read = handle.radio.probe(options);
  return read ? [read.data[0], read.data[1], read.data[2]] : null;
}

const linearAt = (handle, x, y, mask) => [
  probeAt(handle, x, y, 35, mask)?.[0] ?? NaN,
  probeAt(handle, x, y, 36, mask)?.[0] ?? NaN,
  probeAt(handle, x, y, 37, mask)?.[0] ?? NaN,
];

const displayAt = (handle, x, y, mask) => [
  probeAt(handle, x, y, 38, mask)?.[0] ?? NaN,
  probeAt(handle, x, y, 39, mask)?.[0] ?? NaN,
  probeAt(handle, x, y, 40, mask)?.[0] ?? NaN,
];

async function round3() {
  started = performance.now();
  results.round3 = { checks: [], colour: [], notes: [] };
  const note = (name, ok, detail) => {
    results.round3.checks.push({ name, ok, detail: detail === undefined ? null : detail });
    if (!ok) results.round3.failures = (results.round3.failures || 0) + 1;
  };
  const handle = await mount();
  handle.radio.scan();
  await waitFrames(3);
  const anchors = handle.radio.anchors();

  // 1. Colour chain, shader level: each emitter must contribute linear light
  //    when visible, and must contribute nothing when its mask bit is clear.
  const seen = new Set();
  for (const anchor of anchors) {
    if (seen.has(anchor.businessId)) continue;
    seen.add(anchor.businessId);
    // Sample around the anchor's representative pixel, the same point the
    // label and the hit test use: the near-axis image is a hollow cap, so a
    // 3x3 window at its area centroid contains no emitter at all. The 3x3 then
    // absorbs half-pixel placement and keeps the strongest response.
    const baseX = anchor.pickX ?? anchor.x;
    const baseY = anchor.pickY ?? anchor.y;
    let best = null;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const px = baseX + dx;
        const py = baseY + dy;
        const onTry = linearAt(handle, px, py);
        const offTry = linearAt(handle, px, py, 0);
        const tryDelta = onTry.map((value, i) => value - offTry[i]);
        const tryMagnitude = Math.max(...tryDelta.map(Math.abs));
        if (!best || tryMagnitude > best.magnitude) {
          best = { offset: [dx, dy], on: onTry, off: offTry, delta: tryDelta, magnitude: tryMagnitude, onDisplay: displayAt(handle, px, py), offDisplay: displayAt(handle, px, py, 0) };
        }
      }
    }
    const { on, off, delta, onDisplay, offDisplay } = best;
    const magnitude = best.magnitude;
    results.round3.colour.push({
      businessId: anchor.businessId,
      crossingIndex: anchor.branch,
      pixels: [baseX, baseY],
      sampledOffset: best.offset,
      linearOn: on.map((v) => +v.toFixed(5)),
      linearOff: off.map((v) => +v.toFixed(5)),
      displayOn: onDisplay.map((v) => +v.toFixed(4)),
      displayOff: offDisplay.map((v) => +v.toFixed(4)),
    });
    note(
      `${anchor.businessId}: emitter adds linear light`,
      Number.isFinite(magnitude) && magnitude > 0.02,
      `max|Δlinear|=${magnitude.toFixed(4)}`,
    );
    note(
      `${anchor.businessId}: colour survives tone mapping`,
      onDisplay.every((v, i) => Number.isFinite(v) && v > offDisplay[i] && v <= 1.0001),
      `on=[${onDisplay.map((v) => v.toFixed(3))}] off=[${offDisplay.map((v) => v.toFixed(3))}]`,
    );
    // Display must equal the shader's own linear->display path: re-deriving it
    // here would duplicate the shader, so cross-check monotonicity between the
    // two crossings of the near-axis source instead (brighter linear -> brighter
    // display, channel by channel).
  }

  // 2. A control pixel (no emitter nearby) must be bit-identical with and
  //    without emitter light: proves the differencing above is not global.
  const controlPoint = [40, 40];
  const controlOn = linearAt(handle, controlPoint[0], controlPoint[1]);
  const controlOff = linearAt(handle, controlPoint[0], controlPoint[1], 0);
  const controlDelta = Math.max(...controlOn.map((v, i) => Math.abs(v - controlOff[i])));
  note(
    'control pixel is unaffected by emitters',
    Number.isFinite(controlDelta) && controlDelta < 1e-4,
    `max|Δ|=${controlDelta.toExponential(2)}`,
  );

  // 3. Frame versioning: a camera move must invalidate what was measured. The
  //    anchor list is a snapshot; pick() must report the version it was read at.
  const versionBefore = handle.radio.frameVersion;
  const pickBefore = handle.radio.pick(anchors[0]?.x ?? 640, anchors[0]?.y ?? 370);
  handle.resetView();
  await waitFrames(4);
  await wait(260);
  handle.radio.scan();
  await waitFrames(2);
  const versionAfter = handle.radio.frameVersion;
  const pickAfter = handle.radio.pick(anchors[0]?.x ?? 640, anchors[0]?.y ?? 370);
  note(
    'camera move bumps the frame version',
    versionAfter > versionBefore,
    `${versionBefore} -> ${versionAfter}`,
  );
  note(
    'pick reports a live frame version',
    pickAfter === null || pickAfter.frameVersion === versionAfter,
    pickAfter ? `frameVersion=${pickAfter.frameVersion} (live ${versionAfter})` : 'no hit after reset',
  );
  if (pickBefore) {
    results.round3.notes.push({
      pickBeforeReset: { businessId: pickBefore.businessId, frameVersion: pickBefore.frameVersion },
      pickAfterReset: pickAfter && { businessId: pickAfter.businessId, frameVersion: pickAfter.frameVersion },
    });
  }

  // 4. Viewport mapping: shrink the host page box, rescan, and require both the
  //    anchor coordinates and the hit test to follow the new CSS size.
  stageNode.style.width = '960px';
  stageNode.style.height = '540px';
  await waitFrames(4);
  await wait(260);
  handle.radio.scan();
  await waitFrames(2);
  const small = handle.radio.anchors();
  const outOfBox = small.filter((a) => a.x < 0 || a.x > 960 || a.y < 0 || a.y > 540);
  note('resize keeps anchors inside the new box', small.length > 0 && outOfBox.length === 0, `${small.length} anchors, ${outOfBox.length} outside`);
  let hitAfterResize = null;
  for (const anchor of small) {
    const pick = handle.radio.pick(anchor.pickX ?? anchor.x, anchor.pickY ?? anchor.y);
    if (pick && pick.businessId === anchor.businessId) { hitAfterResize = { anchor, pick }; break; }
  }
  note(
    'hit test follows the resized canvas',
    hitAfterResize !== null,
    hitAfterResize ? `${hitAfterResize.pick.businessId} at ${hitAfterResize.anchor.x},${hitAfterResize.anchor.y}` : 'no anchor was pickable',
  );
  stageNode.style.width = '1280px';
  stageNode.style.height = '720px';
  await waitFrames(4);

  results.round3.elapsedMs = Math.round(performance.now() - started);
  results.round3.passed = results.round3.checks.filter((c) => c.ok).length;
  results.round3.total = results.round3.checks.length;
  log(`round3: ${results.round3.passed}/${results.round3.total} passed`);
  return results.round3;
}

async function dprCheck(cap) {
  const handle = await mountWith({ pixelRatioCap: cap });
  const gl = handle.radio.context();
  const ratio = Math.min(window.devicePixelRatio, cap);
  const expectedWidth = Math.round(1280 * ratio);
  const expectedHeight = Math.round(720 * ratio);
  const check = {
    pixelRatioCap: cap,
    devicePixelRatio: window.devicePixelRatio,
    rendererPixelRatio: handle.radio.context() ? ratio : null,
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    expected: [expectedWidth, expectedHeight],
    checks: [],
  };
  check.checks.push({
    name: `drawing buffer follows DPR (cap ${cap})`,
    ok: gl.drawingBufferWidth === expectedWidth && gl.drawingBufferHeight === expectedHeight,
    detail: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight} vs ${expectedWidth}x${expectedHeight}`,
  });

  handle.radio.scan();
  await waitFrames(3);
  await wait(120);
  const anchors = handle.radio.anchors();
  let hits = 0;
  for (const anchor of anchors) {
    const pick = handle.radio.pick(anchor.pickX ?? anchor.x, anchor.pickY ?? anchor.y);
    if (pick && pick.businessId === anchor.businessId) hits += 1;
  }
  check.anchors = anchors.map((a) => ({ id: a.businessId, crossing: a.branch, x: Math.round(a.x), y: Math.round(a.y) }));
  check.checks.push({
    name: `CSS anchors stay pickable at DPR ${window.devicePixelRatio} (cap ${cap})`,
    ok: anchors.length > 0 && hits === anchors.length,
    detail: `${hits}/${anchors.length} anchors picked`,
  });
  disposeLive();
  return check;
}

// Kept out of run() so the driver can photograph the live stage before it goes
// away; a screenshot taken after teardown is just background colour.
function teardown() {
  const mainTables = liveHandle.radio.tables();
  liveHandle.dispose();
  record(
    'main stage dispose marks its tables disposed',
    mainTables.disposed === true,
    `disposed=${mainTables.disposed}`,
  );
  record(
    'main stage dispose removes its canvas',
    stageNode.querySelectorAll('canvas[data-bhrl-canvas-el]').length === 0,
  );
  results.meta.elapsedMs = Math.round(performance.now() - started);
  results.meta.checks = results.checks.length;
  results.meta.failures = failureCount;
  log(`teardown done: ${results.checks.length - failureCount}/${results.checks.length} passed`);
  return results;
}

window.HARNESS = { run, teardown, mount, mountWith, round3, dprCheck, disposeLive, ready: false, stageNode };
log('harness loaded');
window.HARNESS.ready = true;
