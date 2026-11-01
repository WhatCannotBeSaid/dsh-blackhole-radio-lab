import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createPlaybackCore } from '../src/radio/playback.js';
import { activeFailures, FAILURE_COOLDOWN_MS } from '../src/radio/cache.js';
import { createRadioStore } from '../src/radio/store.js';
import { bindMediaSession } from '../src/radio/media-session.js';
import { pollMetadata } from '../src/radio/metadata-poll.js';
import { createHostWatch } from '../src/radio/host-watch.js';
function fixture(play = () => Promise.resolve()) {
  const timers = new Map(); let next = 0; const events = new Map();
  const audio = { play, pause() {}, addEventListener(k, fn) { events.set(k, fn); }, removeAttribute() {}, load() {} };
  const core = createPlaybackCore({ createAudio: () => audio, setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); } });
  return { core, audio, timers, emit: (name) => events.get(name)?.(), tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function runtime(fetch, extra = {}) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('    function createSharedState() {'), source.indexOf('    function useShared('));
  return vm.runInNewContext(`let libraryWriteInFlight = null; ${body}; createSharedState()`, {
    fetch, console, setTimeout, clearTimeout, AbortSignal, AbortController, LIBRARY_URL: '/test', LIBRARY_READ_MS: 8000, LIBRARY_WRITE_MS: 400, KEEPALIVE_MAX_CHARS: 49152, isBrokenStream: () => false,
    ...extra,
  });
}
test('real shared hydration keeps saved volume when playback is created mid-read', async () => {
  let resolve;
  const shared = runtime(() => new Promise(r => { resolve = r; }));
  const store = shared.ensureStore(createRadioStore); const pending = shared.hydrateLibrary(store);
  const f = fixture(); shared.ensurePlayback(() => f.core);
  resolve({ ok: true, json: async () => ({ playback: { volume: .2 } }) }); await pending;
  assert.equal(f.core.getVolume(), .2); shared.dispose();
});
test('real shared hydration preserves user volume, and ignores old lifetime response', async () => {
  let resolve; const shared = runtime(() => new Promise(r => { resolve = r; }));
  const store = shared.ensureStore(createRadioStore); const pending = shared.hydrateLibrary(store);
  const f = fixture(); shared.ensurePlayback(() => f.core); store.rememberVolume(.7); f.core.setVolume(.7);
  resolve({ ok: true, json: async () => ({ playback: { volume: .2 } }) }); await pending;
  assert.equal(f.core.getVolume(), .7); shared.dispose();
  const oldStore = shared.ensureStore(createRadioStore); const old = shared.hydrateLibrary(oldStore); shared.dispose();
  const nextStore = shared.ensureStore(createRadioStore); nextStore.rememberVolume(.6); const g = fixture(); shared.ensurePlayback(() => g.core); g.core.setVolume(.6);
  resolve({ ok: true, json: async () => ({ playback: { volume: .1 } }) }); await old;
  assert.equal(g.core.getVolume(), .6); assert.equal(shared.libraryHydrated, false); shared.dispose();
});
test('startup retries once, same station, then finite failure', () => {
  const f = fixture(); f.core.play('a', 'https://test/a'); f.tick();
  assert.equal(f.core.getState().stationId, 'a'); assert.equal(f.core.getState().status, 'loading');
  f.tick(); assert.equal(f.core.getState().error, 'startup-timeout'); assert.equal(f.timers.size, 0); f.core.dispose();
});
test('stall watchdog is bounded and cancelled by progress/pause', () => {
  const f = fixture(); f.core.play('a', 'https://test/a'); f.emit('playing'); f.emit('stalled');
  assert.equal(f.timers.size, 1); f.core.pause(); assert.equal(f.timers.size, 0);
  f.emit('playing'); assert.equal(f.core.getState().status, 'paused'); f.core.dispose();
});
test('old rejection cannot corrupt a new station; browser block does not retry', async () => {
  let reject; let calls = 0;
  const f = fixture(() => ++calls === 1 ? new Promise((_, r) => { reject = r; }) : Promise.resolve());
  f.core.play('a', 'https://test/a'); f.core.play('b', 'https://test/b');
  reject({ name: 'NotSupportedError' }); await flush(); assert.equal(f.core.getState().stationId, 'b'); assert.equal(f.core.getState().status, 'loading'); f.core.dispose();
  const g = fixture(() => Promise.reject({ name: 'NotAllowedError' })); g.core.play('a', 'https://test/a'); await flush();
  assert.equal(g.core.getState().error, 'blocked-by-browser'); assert.equal(g.timers.size, 0); g.core.dispose();
});
test('failed sources expire; legacy permanent ids are released', () => {
  const now = 1e9;
  assert.deepEqual(activeFailures({ ids: ['old'] }, now), []);
  assert.deepEqual(activeFailures({ failures: [{ id: 'a', at: now - 1 }, { id: 'b', at: now - FAILURE_COOLDOWN_MS }] }, now).map(x => x.id), ['a']);
});
test('volume and last successful station round trip even with no selection', () => {
  const a = { id: 'a', name: 'A', metadata: { source: 'radio-browser' } };
  const s = createRadioStore(); s.index([a]); s.rememberVolume(.2); s.rememberPlayed(a); s.select(null);
  const restored = createRadioStore(); restored.index([a]); restored.load(s.save());
  assert.equal(restored.playbackMemory().volume, .2); assert.equal(restored.getSelected().id, 'a');
  restored.rememberVolume(.7); restored.load(s.save()); assert.equal(restored.playbackMemory().volume, .7);
});
test('native controls bind on playback, not volume updates, and spare external metadata', () => {
  const f = fixture(); let calls = 0; const handlers = {};
  const session = { metadata: null, setActionHandler(k, fn) { calls++; handlers[k] = fn; } };
  const dispose = bindMediaSession(f.core, () => ({ name: 'A' }), session, class { constructor(v) { Object.assign(this, v); } });
  assert.equal(calls, 0); f.core.play('a', 'https://test/a'); f.emit('playing'); assert.equal(calls, 3);
  f.core.setVolume(.2); assert.equal(calls, 3); session.metadata = { title: 'Other player' };
  dispose(); assert.equal(calls, 3); assert.equal(session.metadata.title, 'Other player'); f.core.dispose();
});
test('hidden metadata polling aborts, visible refreshes, disposal ignores stale answer', async () => {
  let visibility; let resolve; let count = 0; let signal; const answers = [];
  const doc = { hidden: false, addEventListener(_, fn) { visibility = fn; }, removeEventListener() { visibility = null; } };
  const stop = pollMetadata({ url: '/test', intervalMs: 20, document: doc, fetch: (_, opts) => { count++; signal = opts.signal; return new Promise(r => { resolve = r; }); }, onResult: value => answers.push(value) });
  assert.equal(count, 1); doc.hidden = true; visibility(); assert.equal(signal.aborted, true);
  doc.hidden = false; visibility(); assert.equal(count, 2); stop(); resolve({ ok: true, json: async () => ({ title: 'stale' }) }); await flush();
  assert.equal(answers.length, 0); assert.equal(visibility, null);
});
function scheduler() {
  const jobs = new Set();
  return {
    setInterval(fn) { const job = { fn }; jobs.add(job); return job; },
    clearInterval(job) { jobs.delete(job); },
    async run() { for (const job of [...jobs]) await job.fn(); },
    get size() { return jobs.size; },
  };
}
test('a dead watch can be rearmed by the next audible attempt', async () => {
  const s = scheduler(); let dead = 0;
  const watch = createHostWatch({ probe: async () => false, onDead: () => { dead += 1; }, setInterval: s.setInterval, clearInterval: s.clearInterval });
  watch.start(); await s.run(); await s.run(); assert.equal(dead, 1);
  watch.start(); await s.run(); assert.equal(dead, 1); assert.equal(watch.isWatching(), false);
  watch.rearm(); assert.equal(watch.isDead(), false); watch.start(); assert.equal(watch.isWatching(), true);
  await s.run(); assert.equal(watch.stats().failures, 1);
});
test('host watch forgets a miss when the host answers', async () => {
  const answers = [false, true, false, false]; const s = scheduler(); let dead = 0;
  const watch = createHostWatch({ probe: async () => answers.shift(), onDead: () => { dead += 1; }, setInterval: s.setInterval, clearInterval: s.clearInterval });
  watch.start(); await s.run(); assert.equal(dead, 0);
  await s.run(); assert.equal(watch.stats().failures, 0); await s.run(); assert.equal(dead, 0);
  await s.run(); assert.equal(dead, 1);
});
test('host watch stops when nothing is audible or hidden any more', async () => {
  let audible = true; const s = scheduler(); let probes = 0;
  const watch = createHostWatch({ probe: async () => { probes += 1; return true; }, active: () => audible, setInterval: s.setInterval, clearInterval: s.clearInterval });
  watch.start(); assert.equal(watch.isWatching(), true); audible = false; await s.run();
  assert.equal(watch.isWatching(), false); assert.equal(probes, 0); assert.equal(s.size, 0);
});
test('a failure that lands after stop cannot kill the watch', async () => {
  const s = scheduler(); let dead = 0; let release = null;
  const watch = createHostWatch({ probe: () => new Promise((resolve) => { release = resolve; }), onDead: () => { dead += 1; }, setInterval: s.setInterval, clearInterval: s.clearInterval });
  watch.start(); const pending = s.run(); watch.stop(); release(false); await pending;
  assert.equal(watch.isDead(), false); assert.equal(dead, 0); assert.equal(watch.stats().failures, 0);
});
test('a probe still in flight is not started twice', async () => {
  const s = scheduler(); let calls = 0; let release = null;
  const watch = createHostWatch({ probe: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); }, setInterval: s.setInterval, clearInterval: s.clearInterval });
  watch.start(); const first = s.run(); const second = s.run(); assert.equal(calls, 1);
  release(true); await first; await second; assert.equal(calls, 1); assert.equal(watch.stats().failures, 0);
});
test('pagehide silences the audio, bfcache does not, and a dead host stops playback', async () => {
  const listeners = new Map();
  const page = { addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); } };
  const doc = { visibilityState: 'visible', addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); } };
  const s = scheduler(); let alive = true; let probeStatus = 200;
  const chunk = { createHostWatch: (opts) => createHostWatch({ ...opts, setInterval: s.setInterval, clearInterval: s.clearInterval }) };
  const shared = runtime(async () => {
    if (!alive) throw new Error('host gone');
    return { ok: probeStatus === 200, status: probeStatus };
  }, { window: page, document: doc });
  shared.watchUnload(); const f = fixture(); shared.ensurePlayback(() => f.core); shared.bindEnv(chunk);
  assert.equal(shared.hostWatch.isWatching(), false);
  f.core.play('a', 'https://test/a'); f.emit('playing'); doc.visibilityState = 'hidden'; listeners.get('visibilitychange')();
  assert.equal(shared.hostWatch.isWatching(), true);
  probeStatus = 500; await s.run(); assert.equal(shared.hostWatch.isDead(), false);
  doc.visibilityState = 'visible'; listeners.get('visibilitychange')(); assert.equal(shared.hostWatch.isWatching(), false);
  doc.visibilityState = 'hidden'; listeners.get('visibilitychange')(); assert.equal(shared.hostWatch.isWatching(), true);
  alive = false; await s.run(); await s.run();
  assert.equal(shared.hostWatch.isDead(), true); assert.equal(f.core.getState().status, 'idle');
  assert.equal(shared.hostWatch.isWatching(), false);
  f.core.play('a', 'https://test/a'); f.emit('playing'); assert.equal(shared.hostWatch.isDead(), false);
  alive = true; listeners.get('pagehide')({ persisted: true }); assert.equal(f.core.stats().alive, 1);
  listeners.get('pagehide')({ persisted: false }); assert.equal(shared.playback, null);
  assert.equal(f.core.getState().status, 'idle'); assert.equal(f.core.stats().alive, 0);
  assert.equal(s.size, 0); assert.equal(listeners.has('pagehide'), false);
});
