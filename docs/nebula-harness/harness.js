/**
 * Phase-3 nebula harness.
 *
 * Mounts the production stage module — the same layout, particles, labels and
 * pointer paths the panel uses — with the phase-2 mock repository behind it, and
 * reports per-check numbers instead of a pass/fail vibe. The driver calls
 * window.NEBULA.run(), then takes the screenshots through window.NEBULA.shot().
 *
 * Fixed conditions: 1280x720 CSS, pixelRatioCap 1 (drawing buffer = CSS even on
 * a scaled display), seed 20261022, no reduced motion, so the frame timings mean
 * something. Everything here is read-only with respect to the repository.
 */

import { mountStage } from '/src/stage.js';
import { createMockRadioRepository } from '/src/radio/repository.js';

const WIDTH = 1280;
const HEIGHT = 720;
const SEED = 20261022;

const readout = document.getElementById('readout');
const stageNode = document.getElementById('stage');

const checks = [];
const failures = [];
const errors = [];
const log = [];
let live = null;
// The stage exposes its diagnostic surface on the window and only one stage can
// own it, so the harness captures each mount's debug object at mount time.
let D = null;
let repo = null;
let visible = [];

window.addEventListener('error', (event) => errors.push(String(event.message || event.error)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

function note(line) {
  log.push(line);
  if (log.length > 30) log.shift();
  if (readout) readout.textContent = log.join('\n');
}

function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  if (!ok) failures.push(name + (detail === undefined ? '' : ` — ${detail}`));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  // A hidden tab throttles requestAnimationFrame to nothing. Fall back to a
  // timer so the harness still runs when driven from a background window.
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 80);
  });
}

async function waitFrames(count) {
  for (let i = 0; i < count; i += 1) await nextFrame();
}

function settingsFor(extra) {
  return {
    antialias: true,
    pixelRatioCap: 1,
    reducedMotion: false,
    stations: extra && extra.stations !== undefined ? extra.stations : repo.list(),
    categories: [],
    seed: SEED,
    language: 'zh',
    radio: 'all',
    genres: extra && extra.genres !== undefined ? extra.genres : visible,
    nebulaPreview: extra ? extra.nebulaPreview !== false : true,
    ...(extra && extra.settings ? extra.settings : {}),
  };
}

/** A synthetic pointer sequence on the canvas. The stage and the rig both see it. */
function pointer(type, x, y) {
  const canvas = stageNode.querySelector('canvas[data-bhrl-canvas-el]');
  const rect = canvas.getBoundingClientRect();
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 7,
    pointerType: 'mouse',
    isPrimary: true,
  });
  canvas.dispatchEvent(event);
}

async function drag(from, to) {
  pointer('pointerdown', from.x, from.y);
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    pointer('pointermove', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await waitFrames(1);
  }
  pointer('pointerup', to.x, to.y);
  await waitFrames(6);
}

async function click(x, y) {
  pointer('pointerdown', x, y);
  await waitFrames(1);
  pointer('pointerup', x, y);
  await waitFrames(4);
}

function wheel(deltaY, times) {
  const canvas = stageNode.querySelector('canvas[data-bhrl-canvas-el]');
  const rect = canvas.getBoundingClientRect();
  for (let i = 0; i < times; i += 1) {
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY,
        deltaMode: 0,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );
  }
}

function labels() {
  return live ? D.nebulaLabels() : [];
}

function state() {
  return live ? D.state() : null;
}

function volumeOf(id) {
  const info = D.nebulaInfo();
  return info ? info.volumes.find((volume) => volume.id === id) || null : null;
}

let baseFraming = null;

async function mount(live_ = true) {
  // A second mount must not stack on the first: two stages share the canvas
  // area and both keep drawing, which quietly doubles every screenshot.
  if (live) {
    live.dispose();
    live = null;
    stageNode.innerHTML = '';
  }
  repo = createMockRadioRepository({ count: 240, seed: SEED });
  visible = repo.visibleGenres();
  live = mountStage(stageNode, settingsFor({}));
  live.__stage = stageNode;
  D = window.__BHRL_DEBUG__;
  window.__NEBULA_HANDLE__ = live;
  // Captured once: shot() must always start from the authored view, not from
  // whatever the previous shot left the rig at.
  baseFraming = { ...D.handles().rig.framing().home };
  await waitFrames(10);
  await wait(200);
  D.settle();
  await waitFrames(3);
  return live;
}

let runPromise = null;

/**
 * Two callers can reach run() — a driver that retries, a probe that polls — and
 * two interleaved runs would drive the same stage and poison each other's
 * numbers. One run at a time, and each run starts from an empty ledger.
 */
function run() {
  if (!runPromise) {
    runPromise = runOnce().finally(() => {
      runPromise = null;
    });
  }
  return runPromise;
}

async function runOnce() {
  checks.length = 0;
  failures.length = 0;
  errors.length = 0;
  if (!live) await mount();
  D.settle();
  await waitFrames(4);

  const info = D.nebulaInfo();
  const st = state();
  note('nebula: ' + (info ? info.volumes.length : 0) + ' volumes, ' + (info ? info.particleCount : 0) + ' particles');

  // --- mount and state ------------------------------------------------------
  record('preview enters the nebula space', st.mode === 'nebula' && st.state === 'nebula', JSON.stringify(st));
  record('tn reaches one', st.tn === 1, String(st.tn));
  record('the volume count is the visible genre count', Boolean(info) && info.volumes.length === visible.length, `${info && info.volumes.length} vs ${visible.length}`);
  record('the layout carries a signature', Boolean(info) && /^[0-9a-f]+$/.test(info.signature), info && info.signature);
  record('the layout extent is positive', Boolean(info) && info.extent > 0, info && info.extent);
  record('every volume has a positive radius', Boolean(info) && info.volumes.every((volume) => volume.radius > 0));
  record('one shared particle buffer', Boolean(info) && info.particleCount > 10000 && info.particleCount <= 26000, String(info && info.particleCount));
  record('every volume has particles', Boolean(info) && info.perNebula.length === info.volumes.length && info.perNebula.every((count) => count >= 620), info && JSON.stringify(info.perNebula));
  record('every volume has a few stars', Boolean(info) && info.starsPerNebula.every((count) => count >= 6), info && JSON.stringify(info.starsPerNebula));
  record('no volume swallows another', (() => {
    if (!info) return false;
    for (let i = 0; i < info.volumes.length; i += 1) {
      for (let j = i + 1; j < info.volumes.length; j += 1) {
        const a = info.volumes[i];
        const b = info.volumes[j];
        const distance = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z);
        if (distance < (a.radius + b.radius) * 0.82) return false;
      }
    }
    return true;
  })());

  // --- labels ---------------------------------------------------------------
  const list = labels();
  record('one label per volume', list.length === visible.length, `${list.length} vs ${visible.length}`);
  record('labels are finite and on screen', list.length > 0 && list.every((label) => Number.isFinite(label.position.x + label.position.y)));
  record('labels stay inside the box', list.every((label) => label.x >= -8 && label.x <= WIDTH + 8 && label.y >= -8 && label.y <= HEIGHT + 8), JSON.stringify(list.map((label) => [label.id, Math.round(label.x), Math.round(label.y)])));
  const overlaps = (() => {
    let count = 0;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (list[i].occluded || list[j].occluded) continue;
        const dx = list[i].x - list[j].x;
        const dy = list[i].y - list[j].y;
        if (Math.hypot(dx, dy) < 22) count += 1;
      }
    }
    return count;
  })();
  record('labels do not pile up', overlaps === 0, `${overlaps} overlapping pairs`);
  record('every label carries its live count', list.every((label) => Number.isInteger(label.count) && label.count > 0), JSON.stringify(list.map((label) => [label.id, label.count])));
  record('counts come from the repository', list.reduce((sum, label) => sum + label.count, 0) === visible.reduce((sum, genre) => sum + genre.count, 0));

  // --- hover ----------------------------------------------------------------
  const probeIndex = list.findIndex((label) => !label.occluded);
  D.nebulaHover(list[probeIndex].index);
  await waitFrames(3);
  const hovered = labels();
  const hoveredLabels = hovered.filter((label) => label.hovered);
  record('hover marks exactly one volume', hoveredLabels.length === 1 && hoveredLabels[0].id === list[probeIndex].id, JSON.stringify(hoveredLabels.map((label) => label.id)));
  record('hover does not move the sky', hoveredLabels.every((label) => {
    const volume = volumeOf(label.id);
    const before = info.volumes.find((entry) => entry.id === label.id);
    return Boolean(volume && before) && Math.abs(volume.center.x - before.center.x) < 1e-6;
  }));
  D.nebulaHover(-1);
  await waitFrames(2);
  record('leaving hover clears it', labels().every((label) => !label.hovered));

  // --- picking and selection ------------------------------------------------
  const target = list.find((label) => !label.occluded && label.index >= 0);
  const hit = D.nebulaPick(target.x, target.y);
  record('a label position picks its own volume', Boolean(hit) && hit.id === target.id, JSON.stringify(hit) + ' vs ' + target.id);
  record('empty space picks nothing', D.nebulaPick(WIDTH - 4, 4) === null);

  const before = state().genreId;
  await click(target.x, target.y);
  const selected = state();
  record('a click selects the genre', selected.genreId === target.id, `${before} → ${selected.genreId}`);
  record('a click stays in the nebula space', selected.mode === 'nebula' && selected.tn === 1, JSON.stringify({ mode: selected.mode, tn: selected.tn }));
  record('selection marks one label', labels().filter((label) => label.selected).length === 1 && labels().find((label) => label.selected).id === target.id);

  // --- camera ---------------------------------------------------------------
  const framing = D.handles().rig.framing();
  const thetaBefore = framing.theta;
  await drag({ x: 520, y: 380 }, { x: 700, y: 430 });
  const afterDrag = D.handles().rig.framing();
  record('a drag rotates the camera', Math.abs(afterDrag.theta - thetaBefore) > 0.05, `${thetaBefore.toFixed(3)} → ${afterDrag.theta.toFixed(3)}`);
  record('a drag does not select', state().genreId === target.id, String(state().genreId));
  record('a drag stays inside the orbit bounds', afterDrag.radius >= afterDrag.home.minRadius - 0.001 && afterDrag.radius <= afterDrag.home.maxRadius + 0.001);

  wheel(-320, 40);
  await waitFrames(20);
  const zoomedIn = D.handles().rig.framing();
  record('the wheel pulls in and stops at the floor', zoomedIn.radius >= zoomedIn.home.minRadius - 0.001 && zoomedIn.radius < afterDrag.radius, `${zoomedIn.radius.toFixed(1)} floor ${zoomedIn.home.minRadius.toFixed(1)}`);
  wheel(320, 80);
  await waitFrames(24);
  const zoomedOut = D.handles().rig.framing();
  record('the wheel pushes out and stops at the ceiling', zoomedOut.radius <= zoomedOut.home.maxRadius + 0.001 && zoomedOut.radius > zoomedIn.radius, `${zoomedOut.radius.toFixed(1)} ceiling ${zoomedOut.home.maxRadius.toFixed(1)}`);
  record('the camera never enters a volume', info.volumes.every((volume) => {
    const distance = Math.hypot(volume.center.x, volume.center.y, volume.center.z);
    return zoomedIn.radius > distance - volume.radius;
  }), zoomedIn.radius.toFixed(1));

  // --- sizes ----------------------------------------------------------------
  stageNode.style.width = '420px';
  stageNode.style.height = '900px';
  await waitFrames(12);
  await wait(120);
  const portrait = labels();
  const portraitFraming = D.handles().rig.framing();
  record(
    'a narrow portrait box re-frames',
    portraitFraming.home.radius > framing.home.radius * 1.6,
    `${framing.home.radius.toFixed(1)} → ${portraitFraming.home.radius.toFixed(1)}`,
  );
  record('labels survive the portrait box', portrait.length === visible.length && portrait.every((label) => label.x >= -8 && label.x <= 420 + 8 && label.y >= -8 && label.y <= 900 + 8), JSON.stringify(portrait.map((label) => [label.id, Math.round(label.x), Math.round(label.y)])));
  stageNode.style.width = `${WIDTH}px`;
  stageNode.style.height = `${HEIGHT}px`;
  await waitFrames(10);

  // --- leaving and re-entering ---------------------------------------------
  const signature = info.signature;
  const particles = info.particleCount;
  D.exitNebula();
  D.settle();
  await waitFrames(3);
  record('leaving returns to the hole', state().mode === 'black-hole' && state().tn === 0, JSON.stringify(state()));
  D.enterNebula();
  D.settle();
  await waitFrames(3);
  const again = D.nebulaInfo();
  record('re-entry rebuilds the same sky', again.signature === signature && again.particleCount === particles, `${again.signature} / ${again.particleCount}`);
  record('re-entry restores the selection', state().genreId === target.id, String(state().genreId));

  // --- black hole regression ------------------------------------------------
  const plain = document.createElement('div');
  plain.style.cssText = 'position:fixed;left:-4000px;top:0;width:320px;height:240px;overflow:hidden';
  document.body.appendChild(plain);
  const plainHandle = mountStage(plain, settingsFor({ nebulaPreview: false, stations: repo.list(), genres: [] }));
  const plainDebug = window.__BHRL_DEBUG__;
  window.__BHRL_DEBUG__ = D;
  await waitFrames(6);
  const plainState = plainDebug.state();
  record('the default mount is still the black hole', plainState.mode === 'black-hole' && plainState.tn === 0, JSON.stringify(plainState));
  record('the hole stays interactive', plainDebug.center(160, 120).inside === true);
  record('the hole shows no nebula labels', plainDebug.nebulaLabels().length === 0);
  record('the hole still draws its own labels', plain.querySelectorAll('[data-bhrl-labels]').length === 1);
  const plainCanvas = plain.querySelectorAll('canvas[data-bhrl-canvas-el]').length;
  plainHandle.dispose();
  record('disposing a plain stage leaves nothing behind', plainCanvas === 1 && plain.querySelectorAll('canvas[data-bhrl-canvas-el]').length === 0);
  plain.remove();

  // --- particles untouched by interaction -----------------------------------
  const parts = D.handles().parts;
  record('the scene exposes one nebula layer', Boolean(parts.nebula) && parts.nebula.object.name === 'nebula-volumes');

  // --- frame timing ---------------------------------------------------------
  await waitFrames(4);
  const bench = D.benchmark(60);
  const frameMs = bench.msPerFrame;
  const calls = bench.calls;
  const triangles = bench.triangles;

  record('no runtime errors', errors.length === 0, errors.join(' | '));
  record('the frame budget holds', frameMs < 24, `${frameMs.toFixed(2)} ms/frame over ${bench.frames} frames`);

  note(`frame ${frameMs.toFixed(2)} ms on ${bench.device}, ${calls} draw calls, ${bench.points} points`);

  return {
    meta: {
      seed: SEED,
      width: WIDTH,
      height: HEIGHT,
      pixelRatioCap: 1,
      volumes: info.volumes.length,
      particles: info.particleCount,
      signature: info.signature,
      extent: info.extent,
      checkedAt: new Date().toISOString(),
    },
    metrics: {
      frameMs: Math.round(frameMs * 100) / 100,
      benchFrames: bench.frames,
      drawCalls: calls,
      triangles,
      points: bench.points,
      device: bench.device,
      msSubmit: bench.msSubmit,
      labels: list.length,
      labelOverlaps: overlaps,
      perNebula: info.perNebula,
      starsPerNebula: info.starsPerNebula,
      camera: D.handles().rig.framing(),
    },
    checks,
    failures,
    errors,
  };
}

/**
 * Put the camera at a named observation angle for a screenshot, with the
 * readout hidden. Angles are expressed against the layout's own home framing.
 */
async function shot(name) {
  if (!live) await mount();
  document.body.classList.add('shot');
  readout.style.display = 'none';
  const rig = D.handles().rig;
  const home = baseFraming || rig.framing().home;
  const angles = {
    default: { theta: home.theta, phi: home.phi, radius: home.radius },
    low: { theta: home.theta + 0.72, phi: 1.42, radius: home.radius * 0.92 },
    wide: { theta: home.theta - 0.55, phi: 0.92, radius: home.radius * 1.12 },
    close: { theta: home.theta + 0.3, phi: 1.2, radius: home.radius * 0.42 },
    zoomed: { theta: home.theta + 1.15, phi: 1.34, radius: home.radius * 0.62 },
  };
  const angle = angles[name] || angles.default;
  rig.setHome({
    radius: angle.radius,
    phi: angle.phi,
    theta: angle.theta,
    target: { x: 0, y: 0, z: 0 },
    minRadius: home.minRadius,
    maxRadius: home.maxRadius,
  });
  await waitFrames(30);
  await wait(900);
  await waitFrames(4);
  return { name, framing: rig.framing(), labels: labels().length, state: state() };
}

async function dispose() {
  if (live) {
    live.dispose();
    live = null;
  }
  stageNode.innerHTML = '';
}

window.NEBULA = { run, mount, shot, dispose, state, labels, settings: { WIDTH, HEIGHT, SEED } };
note('nebula harness ready');
