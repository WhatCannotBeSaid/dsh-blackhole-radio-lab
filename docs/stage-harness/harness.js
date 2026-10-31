/**
 * Whole-stage acceptance harness.
 *
 * The wormhole harness proves the pass draws. This one proves the *stage*
 * navigates: it mounts the real `mountStage` over a deterministic mock
 * catalogue, then drives the same gestures a person would — hold the centre,
 * wait out the crossing, land in the cluster, click a berth, step back — and
 * reports the state machine's own answers plus a frame-time sample taken while
 * the transition is running.
 *
 * Everything below is the shipped code path. Nothing is stubbed except the
 * catalogue, which the repository already ships as a deterministic mock.
 *
 * Usage: node tools/harness-server.mjs --port 8741
 *        open http://127.0.0.1:8741/docs/stage-harness/
 */

import { createMockRadioRepository } from '/src/radio/repository.js';
import { mountStage } from '/src/stage.js';

const readout = document.getElementById('readout');
const log = [];
const say = (line) => {
  log.push(line);
  readout.textContent = log.join('\n');
};

const repo = createMockRadioRepository({ count: 640, seed: 7 });

const stage = mountStage(document.getElementById('stage'), {
  antialias: true,
  pixelRatioCap: 1,
  stations: repo.list(),
  seed: repo.seed,
  categories: repo.anchors || [],
  genres: typeof repo.visibleGenres === 'function' ? repo.visibleGenres() : [],
  language: 'zh',
  onMode: (snapshot) => {
    window.__lastMode = snapshot;
  },
  onCenterClick: () => {},
  onSelect: () => {},
  onPlay: () => {},
  onHover: () => {},
  onGenreChange: () => {},
});

const canvas = document.querySelector('#stage canvas');
const box = () => canvas.getBoundingClientRect();

/** Sample frames for `ms` while the transition runs. */
function sampleFrames(ms) {
  return new Promise((resolve) => {
    const times = [];
    let last = performance.now();
    const stop = last + ms;
    const step = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (now < stop) requestAnimationFrame(step);
      else {
        const sorted = times.slice(1).sort((a, b) => a - b);
        const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
        const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
        resolve({
          frames: sorted.length,
          meanMs: +mean.toFixed(2),
          medianMs: +at(0.5).toFixed(2),
          p95Ms: +at(0.95).toFixed(2),
          maxMs: +sorted[sorted.length - 1].toFixed(2),
          fps: +(1000 / mean).toFixed(1),
        });
      }
    };
    requestAnimationFrame(step);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pointer(type, x, y, extra = {}) {
  const rect = box();
  const event = new PointerEvent(type, {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: rect.left + x,
    clientY: rect.top + y,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  canvas.dispatchEvent(event);
}

const state = () => (stage && typeof stage.state === 'object' && stage.state) || {};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The hole is the centre of the canvas, whatever size the window is.
 *
 * Hard-coded coordinates were the reason an earlier run "failed to hold": the
 * press landed near the middle of a 1256×821 window and well off the centre of
 * a 952×953 one, so the gesture never started.
 */
const centre = () => {
  const rect = box();
  return { x: Math.round(rect.width / 2), y: Math.round(rect.height / 2), w: rect.width, h: rect.height };
};

/**
 * Hold the centre long enough to cross, then wait for the field to settle.
 *
 * The hold is driven by frame time, so a slow first second can start it late;
 * the retry is what makes this harness boringly reliable instead of flaky.
 */
async function holdCentre(times = 3) {
  const before = state();
  const mid = centre();
  for (let attempt = 1; attempt <= times; attempt += 1) {
    pointer('pointermove', mid.x, mid.y);
    await wait(80);
    pointer('pointerdown', mid.x, mid.y);
    await wait(1400);
    pointer('pointerup', mid.x, mid.y);
    await wait(2600);
    const after = state();
    if (after.mode === 'cluster' && Number(after.progress) > 0.9) return { attempt, before, after };
    if (!same(before.mode, 'black-hole')) break;
  }
  return { attempt: 0, before, after: state() };
}

async function run() {
  const report = { steps: [] };
  report.catalogue = {
    keys: Object.keys(repo),
    stations: repo.list().length,
    categories: (repo.anchors || []).length,
    genres: (typeof repo.visibleGenres === 'function' ? repo.visibleGenres() : []).length,
    canvas: [canvas.width, canvas.height],
  };

  // 1. The hole as it boots.
  await wait(1800);
  report.steps.push({ step: 'boot', state: JSON.parse(JSON.stringify(stage.state || {})), fps: await sampleFrames(700) });

  // 2. Hold the centre: the crossing starts on press, not on release.
  const hold = await holdCentre(3);
  report.steps.push({
    step: 'hold→cluster',
    attempt: hold.attempt,
    state: JSON.parse(JSON.stringify(stage.state || {})),
    fps: await sampleFrames(600),
  });

  window.__stageReport = report;
  window.__stage = stage;
  say(`boot ok · ${report.steps.map((s) => `${s.step}:${s.state.mode}/${s.fps.fps}fps`).join(' · ')}`);
  return report;
}

window.__stageReady = run().catch((error) => {
  window.__stageReport = { error: String(error && error.stack ? error.stack : error), log };
  say(`harness failed: ${error}`);
});

/**
 * The rest of the walk, one step at a time, callable from the outside so a
 * person can watch each stage instead of reading a finished transcript.
 *
 *   await __acceptance()          // berth → shelf field → back → back
 */
window.__acceptance = async () => {
  if (window.__stageReady) await window.__stageReady;
  const out = { steps: [] };
  const snap = () => JSON.parse(JSON.stringify(stage.state || {}));

  // 1. Click a berth. The stage reports where the berths project to, so the
  // nearest one is pressed — the berth itself is the door, and the closest one
  // is the largest target. Opening it must stay inside the cluster page: the
  // state machine answers `expanded`, never a third mode.
  const berths = (typeof stage.clusterPoints === 'function' ? stage.clusterPoints() : [])
    .filter((point) => point.x > 8 && point.y > 8 && point.x < centre().w - 8 && point.y < centre().h - 8)
    .sort((a, b) => a.distance - b.distance);
  out.berths = berths.slice(0, 3);
  if (berths.length) {
    const { x, y, id } = berths[0];
    pointer('pointermove', x, y);
    await wait(120);
    pointer('pointerdown', x, y);
    await wait(60);
    pointer('pointerup', x, y);
    await wait(1600);
    out.steps.push({ step: 'berth→shelf', clicked: [x, y], berth: id, state: snap() });
  } else {
    out.steps.push({ step: 'berth→shelf', state: snap(), note: 'no berth reported by clusterPoints()' });
  }

  // 2. Right-hold: one level out, back to the whole field.
  const mid = centre();
  pointer('pointermove', mid.x, mid.y);
  pointer('pointerdown', mid.x, mid.y, { button: 2, buttons: 2 });
  await wait(1200);
  pointer('pointerup', mid.x, mid.y, { button: 2, buttons: 0 });
  await wait(2000);
  out.steps.push({ step: 'right-hold→cluster', state: snap() });

  // 3. Right-hold again: the reversed crossing, back to the hole.
  await wait(300);
  pointer('pointerdown', mid.x, mid.y, { button: 2, buttons: 2 });
  await wait(1200);
  pointer('pointerup', mid.x, mid.y, { button: 2, buttons: 0 });
  await wait(2000);
  out.steps.push({ step: 'right-hold→black-hole', state: snap() });

  window.__acceptanceReport = out;
  say(
    out.steps
      .map((s) => `${s.step}: mode ${s.state.mode} · expanded ${s.state.expanded || '—'} · progress ${s.state.progress}`)
      .join('\n'),
  );
  return out;
};
