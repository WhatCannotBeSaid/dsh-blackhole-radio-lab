/**
 * Real-engine gesture probe for the two-phase element.
 *
 * The CPU harness can only prove arithmetic. This drives the actual stage in
 * headless chromium (SwiftShader) with real pointer events, so a gesture that
 * disagrees with the machine shows up here instead of in the user's hand.
 *
 * Usage:
 *   node tools/harness-server.mjs --port 8741 &
 *   chrome --headless=new --remote-debugging-port=9333 \
 *     --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
 *     --window-size=1200,800 --user-data-dir=$TMP/chrome-probe \
 *     http://127.0.0.1:8741/docs/radio-gpu-harness/
 *   node tools/probe-gestures.mjs
 *
 * Read-only: it mounts the page's own stage, dispatches input, reads the debug
 * snapshot back and prints one line per gesture. Exit code 1 on a mismatch.
 */

import assert from 'node:assert/strict';

const PORT = Number(process.env.PROBE_PORT || 9333);
const SETTLE_MS = Number(process.env.PROBE_SETTLE || 1200);

async function findPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* the browser is still coming up */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no debuggable page on ${PORT}`);
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = (seq += 1);
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const details = r.result?.exceptionDetails;
  if (details) throw new Error(details.exception?.description || details.text);
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOUNT = `(async () => {
  window.__ERR = [];
  addEventListener('error', (e) => window.__ERR.push(String(e.message)));

  const { mountStage } = await import('/src/stage.js?probe=' + Date.now());
  const { GENRE_IDS } = await import('/src/radio/genres.js');
  const stations = GENRE_IDS.flatMap((genre, group) => Array.from({ length: 8 }, (_, k) => {
    const angle = (group * 8 + k) * 0.23;
    const radius = 1.5 + k * 0.32;
    return {
      id: genre + '-' + k, name: genre + ' ' + k, categories: [genre], genre, genres: [genre],
      position: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius },
      metadata: { primaryCategory: genre, presence: 1, layout: { radius, angle, height: 0 } },
    };
  }));
  window.__S = mountStage(window.HARNESS.stageNode, {
    antialias: false, pixelRatioCap: 1, reducedMotion: false,
    stations, categories: [], seed: 1, language: 'en', radio: 'all',
    // The library lives in the panel, not the stage. Recording the ask here is
    // how a probe proves a short right press reaches the host with its point.
    onFavourites(x, y) { window.__FAV = { x, y }; },
  });
  await new Promise((r) => setTimeout(r, 900));
  return document.querySelector('canvas[data-bhrl-canvas-el]') ? true : false;
})()`;

const snapshot = () => evaluate(`(() => {
  const w = window.__BHRL_DEBUG__.wormhole();

  const s = window.__S.state;
  const disk = window.__BHRL_DEBUG__.handles().parts.disk;
  const u = disk && disk.object.material.uniforms;
  return { kind: w.kind, locked: w.locked, progress: s.progress, mode: s.mode,
    disc: u ? Math.round(u.uOpacity.value * 1000) / 1000 : -1,
    xfer: u ? u.uDiscTransfer.value : -9 };
})()`);

const mouse = (type, button, buttons, x, y) =>
  send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });

async function hold(button, mask, ms, x, y) {
  await mouse('mousePressed', button, mask, x, y);
  await sleep(ms);
  await mouse('mouseReleased', button, 0, x, y);
}

async function fresh() {
  await evaluate('window.__S && window.__S.dispose && window.__S.dispose()');
  await sleep(250);
  assert.equal(await evaluate(MOUNT), true, 'the stage did not mount');
  return evaluate(`(() => {
    const h = window.__S.holeScreen();
    const r = document.querySelector('canvas[data-bhrl-canvas-el]').getBoundingClientRect();
    return { x: r.left + h.x, y: r.top + h.y, w: h.w, h: h.h };
  })()`);
}

/** Enter from the hole and wait until the leg is over, not just over the ring. */
async function enterSettled(hole) {
  // Press, then wait for the leg to publish itself: a hard-coded delay races a
  // cold mount and says nothing about the gesture.
  await mouse('mousePressed', 'left', 1, hole.x, hole.y);
  for (let i = 0; i < 120; i += 1) {
    const s = await snapshot();
    if (s.mode === 'cluster') break;
    if (i === 5) assert.equal(s.kind, 'enter', 'the press did not start the crossing');
    await sleep(100);
  }
  await mouse('mouseReleased', 'left', 0, hole.x, hole.y);
  await sleep(SETTLE_MS);
  const s = await snapshot();
  assert.equal(s.mode, 'cluster', 'the long left hold did not reach the cluster');
  return s;
}

let cases = 0;
await send('Page.navigate', { url: process.argv[2] || 'http://127.0.0.1:8741/docs/radio-gpu-harness/' });
await sleep(4000);

// 1. A right hold on empty space must bring the hole back, whichever side of
//    the disc it is pressed on.
{
  const hole = await fresh();
  await enterSettled(hole);
  for (const at of [{ x: hole.w * 0.7, y: hole.h * 0.25 }, { x: hole.w * 0.25, y: hole.h * 0.7 }]) {
    await enterSettled(hole);
    const pre = await snapshot();
    const cnt = await evaluate(`(() => { const c = document.querySelector('canvas'); return ['data-bhrl-crossing', 'data-bhrl-mode', 'data-bhrl-state'].map(k => k + '=' + c.getAttribute(k)).join(' '); })()`);
    await mouse('mousePressed', 'right', 2, at.x, at.y);
    await sleep(300);
    await evaluate(`(() => {
      window.__FLOW = [];
      const raf = () => requestAnimationFrame(() => {
        const s = window.__S.state;
        window.__FLOW.push(Math.round(performance.now()) + ':' + s.progress.toFixed(3));
        if (window.__FLOW.length < 90) raf();
      });
      raf();
    })()`);
    for (let i = 0; i < 60; i += 1) {
      const s = await snapshot();
      await sleep(100);
    }
    await sleep(200);
    await sleep(1200);
    await mouse('mouseReleased', 'right', 0, at.x, at.y);
    await sleep(1200);
    const s = await snapshot();
    assert.equal(s.progress, 0, `right hold at ${Math.round(at.x)},${Math.round(at.y)} did not land on the hole ${JSON.stringify(s)}`);
    assert.equal(s.kind, null, 'the exit never closed after it landed');
    cases += 1;
  }
  await evaluate('window.__S.dispose()');
  console.log('PASS right hold on empty space gathers the disc back from the cluster.');
}

// 2. Released before the leg is locked home, it has to give the cluster back
//    instead of stranding a half-formed hole.
{
  const hole = await fresh();
  await enterSettled(hole);
  await mouse('mousePressed', 'right', 2, hole.w * 0.7, hole.h * 0.25);
  await sleep(400);
  await mouse('mouseReleased', 'right', 0, hole.w * 0.7, hole.h * 0.25);
  await sleep(900);
  const s = await snapshot();
  assert.notEqual(s.progress, 0, 'an early release committed the exit');
  assert.equal(s.kind === null || s.kind === 'recoil', true, `an early release left ${s.kind} running`);
  await evaluate('window.__S.dispose()');
  console.log('PASS a right hold released halfway gives the cluster back.');
}

// 3. A short right press in the cluster does nothing — and above all it must
//    not draw the hold's ring, which is what a press used to flash on its way
//    to being cancelled.
{
  const hole = await fresh();
  await enterSettled(hole);
  const ringOpacity = () => evaluate(`(() => {
    const node = document.querySelector('[data-bhrl-hold-ring]');
    return node ? node.style.opacity : 'missing';
  })()`);
  assert.equal(await ringOpacity(), '0', 'the ring was already up before any press');
  await evaluate('delete window.__FAV');
  await mouse('mousePressed', 'right', 2, hole.x, hole.y);
  // Still inside the click window: the press is not a hold yet, so no ring.
  await sleep(60);
  assert.equal(await ringOpacity(), '0', 'a right press drew the ring before it was a hold');
  await mouse('mouseReleased', 'right', 0, hole.x, hole.y);
  await sleep(400);
  const s = await snapshot();
  assert.equal(s.mode, 'cluster', 'a short right press left the cluster');
  assert.equal(await ringOpacity(), '0', 'the ring outlived a short right press');
  const fav = await evaluate('window.__FAV || null');
  assert.ok(fav, 'a short right press never asked the host for the library');
  assert.ok(
    Math.abs(fav.x - hole.x) <= 2 && Math.abs(fav.y - hole.y) <= 2,
    `the library opened somewhere else: ${JSON.stringify(fav)} vs ${JSON.stringify(hole)}`,
  );
  await mouse('mousePressed', 'left', 1, hole.x, hole.y);
  await mouse('mouseReleased', 'left', 0, hole.x, hole.y);
  await evaluate('window.__S.dispose()');
  console.log('PASS a short right press draws no ring, stays in the cluster, and asks for the library at the press.');
}

console.log(`PASS ${cases + 2} real-engine gestures; headless chromium, no GPU assertions.`);
ws.close();
