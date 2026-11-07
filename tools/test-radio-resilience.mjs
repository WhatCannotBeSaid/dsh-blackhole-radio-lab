import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createPlaybackCore } from '../src/radio/playback.js';
import { createStationHealth } from '../src/radio/health.js';
import { openRadioCache } from '../src/radio/cache.js';
import { createRadioStore } from '../src/radio/store.js';
import { bindMediaSession } from '../src/radio/media-session.js';
import { pollMetadata } from '../src/radio/metadata-poll.js';
import { createHostWatch } from '../src/radio/host-watch.js';
import { buildCatalog } from '../src/host/catalog-builder.js';
import { createRepositoryFromRows } from '../src/radio/repository.js';
function fixture(play = () => Promise.resolve(), options = {}) {
  const timers = new Map(); let next = 0; const events = new Map(); const delays = [];
  const audio = { currentTime: 0, play, pause() {}, addEventListener(k, fn) { events.set(k, fn); }, removeAttribute() {}, load() {} };
  const core = createPlaybackCore({ ...options, createAudio: () => audio, setTimeout(fn, delay) { delays.push(delay); timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); } });
  return { core, audio, timers, delays, emit: (name) => events.get(name)?.(), tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function hlsAttacher(shared, requireAsync) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = source.indexOf('    const HLS_CHUNK =');
  const body = source.slice(start, source.indexOf('    const DICT =', start));
  return vm.runInNewContext(`${body}; makeAttachStream`)(shared, requireAsync);
}
function runtime(fetch, extra = {}) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('    function createSharedState() {'), source.indexOf('    function useShared('));
  return vm.runInNewContext(`let libraryWriteInFlight = null; ${body}; createSharedState()`, {
    fetch, console, setTimeout, clearTimeout, AbortSignal, AbortController, LIBRARY_URL: '/test', LIBRARY_READ_MS: 8000, LIBRARY_WRITE_MS: 400, KEEPALIVE_MAX_CHARS: 49152,
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
test('startup makes three total attempts with 1s/2s backoff, then surfaces the failure', () => {
  const f = fixture(); f.core.play('a', 'https://test/a');
  let ticks = 0;
  while (f.timers.size > 0 && ticks < 20) { f.tick(); ticks += 1; }
  assert.equal(f.core.getState().stationId, 'a');
  assert.equal(f.core.getState().status, 'error');
  assert.equal(f.core.getState().error, 'startup-timeout');
  assert.equal(f.timers.size, 0);
  assert.equal(f.delays.filter((d) => d === 15000).length, 3);
  assert.deepEqual(f.delays.filter((d) => d !== 15000), [1000, 2000]);
  f.core.dispose();
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
test('attached browser blocks and aborted loads never retry, penalize or switch stations', () => {
  for (const reason of ['blocked-by-browser', 'play-failed:NotAllowedError', 'load-aborted', 'play-failed:AbortError']) {
    let report; let failures = 0; let hops = 0;
    const f = fixture(undefined, {
      attachStream(_audio, _url, onError) { report = onError; return { detach() {} }; },
      onFailure() { failures++; }, nextStation() { hops++; },
    });
    f.core.play('a', 'https://test/a.m3u8'); report(reason);
    assert.equal(f.core.getState().status, 'error');
    assert.equal(f.core.getState().error, reason.includes('Abort') || reason === 'load-aborted' ? 'load-aborted' : 'blocked-by-browser');
    assert.equal(f.timers.size, 0); assert.equal(failures, 0); assert.equal(hops, 0);
    f.core.dispose();
  }
});

test('the first HLS attempt waits for its chunk, then gets a full startup window without retrying', async () => {
  let resolve; let loads = 0; let plays = 0; let attaches = 0; let detached = 0;
  const shared = {};
  const attachStream = hlsAttacher(shared, () => { loads++; return new Promise(r => { resolve = r; }); });
  const f = fixture(() => { plays++; return Promise.resolve(); }, { attachStream });
  f.core.play('a', 'https://test/a.m3u8'); await flush();
  assert.equal(f.audio.src, undefined); assert.equal(plays, 0); assert.equal(attaches, 0);
  resolve({ attachHls() { attaches++; return { detach() { detached++; } }; } }); await flush();
  assert.equal(loads, 1); assert.equal(attaches, 1); assert.equal(plays, 0);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.delays, [15000, 15000]);
  f.emit('playing'); assert.equal(f.core.getState().status, 'playing');
  f.core.dispose(); assert.equal(detached, 1); assert.equal(f.timers.size, 0);
});

test('late HLS loading cannot play after pause, stop, dispose or a station switch', async () => {
  for (const action of ['pause', 'stop', 'dispose', 'switch']) {
    let resolve; let attaches = 0;
    const attachStream = hlsAttacher({}, () => new Promise(r => { resolve = r; }));
    const f = fixture(undefined, { attachStream });
    f.core.play('a', 'https://test/a.m3u8'); await flush();
    if (action === 'switch') f.core.play('b', 'https://test/b.mp3');
    else f.core[action]();
    resolve({ attachHls() { attaches++; return { detach() {} }; } }); await flush();
    assert.equal(attaches, 0, action);
    if (action === 'switch') assert.equal(f.audio.src, 'https://test/b.mp3');
    else assert.equal(f.timers.size, 0, action);
    if (action === 'pause') {
      f.core.resume(); assert.equal(attaches, 1); assert.equal(f.core.getState().status, 'loading');
    }
    f.core.dispose();
  }
});

test('switching between HLS stations shares one load and attaches only the current station', async () => {
  let resolve; let loads = 0; const attached = [];
  const attachStream = hlsAttacher({}, () => { loads++; return new Promise(r => { resolve = r; }); });
  const f = fixture(undefined, { attachStream });
  f.core.play('a', 'https://test/a.m3u8'); await flush();
  f.core.play('b', 'https://test/b.m3u8');
  resolve({ attachHls(_audio, url) { attached.push(url); return { detach() {} }; } }); await flush();
  assert.equal(loads, 1); assert.deepEqual(attached, ['https://test/b.m3u8']);
  assert.equal(f.core.getState().stationId, 'b'); assert.deepEqual(f.delays, [15000, 15000, 15000]);
  f.core.dispose();
});

test('missing HLS support or a failed chunk load falls back natively in the same attempt', async () => {
  for (const fails of [false, true]) {
    let plays = 0;
    const attachStream = hlsAttacher({}, async () => {
      if (fails) throw new Error('chunk unavailable');
      return { attachHls: () => null };
    });
    const f = fixture(() => { plays++; return Promise.resolve(); }, { attachStream });
    f.core.play('a', 'https://test/a.m3u8'); await flush();
    assert.equal(f.audio.src, 'https://test/a.m3u8'); assert.equal(plays, 1);
    assert.deepEqual(f.delays, [15000, 15000]); f.core.dispose();
  }
});

test('a hanging HLS chunk is bounded without station penalties and cannot attach late', async () => {
  let resolve; let attaches = 0; let failures = 0; let hops = 0;
  const attachStream = hlsAttacher({}, () => new Promise(r => { resolve = r; }));
  const f = fixture(undefined, { attachStream, onFailure() { failures++; }, nextStation() { hops++; } });
  f.core.play('a', 'https://test/a.m3u8'); await flush(); f.tick();
  assert.equal(f.core.getState().error, 'hls-load-timeout');
  assert.equal(f.timers.size, 0); assert.equal(failures, 0); assert.equal(hops, 0);
  resolve({ attachHls() { attaches++; return { detach() {} }; } }); await flush();
  assert.equal(attaches, 0); f.core.resume(); assert.equal(attaches, 1); f.core.dispose();
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
test('an attached source is not written to audio.src and is detached on stop', () => {
  const attached = []; let detached = 0; let srcWrites = 0;
  const audio = { play: () => Promise.resolve(), pause() {}, addEventListener() {}, removeAttribute() {}, load() {} };
  Object.defineProperty(audio, 'src', { get: () => '', set() { srcWrites += 1; } });
  const core = createPlaybackCore({
    createAudio: () => audio,
    setTimeout: () => 1, clearTimeout() {},
    attachStream: (_element, url) => { attached.push(url); return { detach() { detached += 1; } }; },
  });
  core.play('a', 'https://test/a.m3u8');
  assert.deepEqual(attached, ['https://test/a.m3u8']);
  // The attacher owns the element now: setting src would fight MediaSource.
  assert.equal(srcWrites, 0);
  core.stop();
  assert.equal(detached, 1);
  core.dispose();
});
test('decode and network errors in attached sources both use bounded retries', () => {
  const audio = { play: () => Promise.resolve(), pause() {}, addEventListener() {}, removeAttribute() {}, load() {} };
  let report; let attaches = 0;
  const core = createPlaybackCore({
    createAudio: () => audio,
    setTimeout: () => 1, clearTimeout() {},
    attachStream: (_element, _url, onError) => { attaches += 1; report = onError; return { detach() {} }; },
  });
  core.play('a', 'https://test/a.m3u8');
  report('decode');
  assert.equal(core.getState().status, 'loading');
  assert.equal(core.getState().error, null);
  core.dispose();
  const again = createPlaybackCore({
    createAudio: () => ({ ...audio }),
    setTimeout: () => 1, clearTimeout() {},
    attachStream: (_element, _url, onError) => { attaches += 1; report = onError; return { detach() {} }; },
  });
  again.play('b', 'https://test/b.m3u8');
  report('network');
  // A network drop is retried, but after a backoff delay rather than
  // synchronously: the element is not re-attached inside this turn.
  assert.equal(again.getState().status, 'loading');
  assert.equal(attaches, 2);
  again.dispose();
});
test('failed stream cools only automatic selection; index, favourites and manual retry survive', () => {
  const stations = [{ id: 'a' }, { id: 'b' }];
  const shared = runtime(async () => ({ ok: false }), {
    playablePool: () => stations, streamOf: (station) => `https://test/${station.id}`,
  });
  shared.bindEnv({ createStationHealth });
  const store = shared.ensureStore(createRadioStore); store.index(stations); store.select('a'); store.toggleFavorite('a');
  shared.autoCandidates = () => [stations[0]];
  let f; shared.ensurePlayback((options) => (f = fixture(undefined, options)).core);
  try {
    f.core.play('a', 'https://test/a');
    for (let n = 0; n < 5; n++) f.tick();
    assert.equal(f.core.getState().status, 'error');
    assert.equal(store.getSelected().id, 'a');
    assert.equal(store.getStation('a').id, 'a');
    assert.equal(store.isFavorite('a'), true);
    assert.equal('blacklist' in shared, false);
    assert.equal(shared.health.save()[0].failures, 1);
    assert.equal(f.timers.size, 0);
    f.core.play('a', 'https://test/a'); f.emit('playing');
    assert.equal(f.core.getState().status, 'playing');
    assert.equal(f.core.getState().stationId, 'a');
  } finally { shared.dispose(); }
});
test('catalogue checks never exclude a station, even with probing explicitly enabled', async () => {
  const candidates = [
    { stationuuid: 'original', name: 'Gotanno FM 89.2', url_resolved: 'https://example.test/stream', lastcheckok: 0 },
    { stationuuid: 'alias', name: 'Gotanno Radio micro FM station', url_resolved: 'https://example.test/stream' },
  ];
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return new Response('', { status: 503 }); };
  const normal = await buildCatalog({ candidates, fetchImpl });
  assert.equal(requests, 0, 'ordinary builds must not probe streams');
  assert.equal(normal.snapshot.healthy, null, 'unchecked stations are not reported as healthy');
  assert.equal(normal.snapshot.selectionPolicy, 'no-health-filter');
  const checked = await buildCatalog({ candidates, fetchImpl, check: true });
  assert.equal(requests, 2);
  assert.equal(checked.stats.healthy, 0);
  assert.deepEqual(checked.snapshot.stations.map(row => row.stationuuid), ['original', 'alias']);
  const repository = createRepositoryFromRows(candidates);
  assert.equal(repository.search('Gotanno FM 89.2')[0]?.id, 'original');
});

test('snapshot fetch bypasses old HTTP cache and rejects the legacy selection policy', async () => {
  const body = { builtAt: new Date().toISOString(), stations: [{ name: 'Gotanno FM 89.2' }] };
  let requests = 0;
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const fetchSnapshot = vm.runInNewContext(source.slice(source.indexOf('    async function fetchCatalogSnapshot('), source.indexOf('    const HLS_CHUNK')) + '; fetchCatalogSnapshot', {
    AbortSignal, SNAPSHOT_MAX_AGE_MS: 30 * 86400000,
    fetch: async (url, options) => { requests += 1; assert.equal(url, '/blackhole-radio-lab/catalog'); assert.equal(options.cache, 'reload'); return { ok: true, json: async () => body }; },
  });
  assert.equal(await fetchSnapshot({}), null);
  body.selectionPolicy = 'no-health-filter';
  assert.equal((await fetchSnapshot({})).rows, body.stations);
  assert.equal(requests, 2);
});

test('fresh legacy host cache is rejected and refreshed rather than shadowing the repaired bundle', () => {
  const repaired = { selectionPolicy: 'no-health-filter', builtAt: new Date().toISOString(), stations: [{ name: 'Gotanno FM 89.2' }] };
  const legacy = { ...repaired, stations: [{ name: 'Old filtered directory' }] }; delete legacy.selectionPolicy;
  const files = { bundle: JSON.stringify(repaired), cache: gzipSync(JSON.stringify(legacy)) };
  const snapshotCache = new Map();
  const sandbox = {
    Buffer, gzipSync, gunzipSync, snapshotCache, CATALOG_PATH: 'bundle', CATALOG_GZ_PATH: '', CACHE_GZ: 'cache', SNAPSHOT_MAX_AGE_MS: 30 * 86400000,
    readFileSync: (file) => files[file], statSync: (file) => ({ mtimeMs: Date.now(), size: Buffer.byteLength(files[file]) }),
  };
  const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const choose = vm.runInNewContext(host.slice(host.indexOf('function readSnapshotPair('), host.indexOf('const DEFAULTS =')) + '; readCatalog', sandbox);
  const refresh = readFileSync(new URL('../src/host/catalog-refresh.js', import.meta.url), 'utf8');
  const stale = vm.runInNewContext(refresh.slice(refresh.indexOf('function isCacheReadable('), refresh.indexOf('/** Remove temporary files')).replace('export function isCacheStale', 'function isCacheStale') + '; isCacheStale', sandbox);
  assert.equal(JSON.parse(choose().json).stations[0].name, 'Gotanno FM 89.2');
  assert.equal(stale(7), true);
  const current = { ...repaired, stations: [...repaired.stations, { name: 'New station' }] };
  files.cache = gzipSync(JSON.stringify(current)); snapshotCache.clear();
  assert.equal(JSON.parse(choose().json).stations.length, 2, 'new unfiltered cache still wins');
  assert.equal(stale(7), false);
});

test('resuming an attached source asks the element to play again', () => {
  // The attacher plays from its own manifest handler, so play() leaves the
  // element alone. A resume reuses that attachment and must not rely on a
  // manifest event that already happened — it would sit silent until the
  // startup timeout.
  let plays = 0;
  const audio = { play() { plays += 1; return Promise.resolve(); }, pause() {}, addEventListener() {}, removeAttribute() {}, load() {} };
  const core = createPlaybackCore({
    createAudio: () => audio,
    setTimeout: () => 1, clearTimeout() {},
    attachStream: () => ({ detach() {} }),
  });
  core.play('a', 'https://test/a.m3u8');
  assert.equal(plays, 0);
  core.pause();
  core.resume();
  assert.equal(plays, 1);
  assert.equal(core.getState().status, 'loading');
  core.dispose();
});

test('health round-trips locally, expires after seven days and caps its cooldown ladder', () => {
  let now = 1000000;
  const stations = [{ id: 'b' }, { id: 'a' }];
  const make = () => createStationHealth({ now: () => now, random: () => 0 });
  let health = make(); health.success('a');
  assert.equal(health.pick(stations).id, 'a');
  const restored = make(); restored.load(health.save()); health = restored;
  for (const delay of [600000, 3600000, 21600000, 86400000, 86400000]) {
    health.failure('a');
    const row = health.save().find(row => row.id === 'a');
    assert.equal(row.cooldownUntil - now, delay);
    assert.equal(health.pick(stations).id, 'b');
    assert.equal(health.pick([stations[1]]), null);
    now += delay;
  }
  health.success('a'); assert.equal(health.save()[0].failures, 0);
  now += 7 * 86400000;
  assert.equal(health.pick(stations).id, 'b');
  assert.equal(health.save().length, 0);
  health.load([{ id: 'bad', successAt: now + 1, failedAt: 0, failures: 0, cooldownUntil: 0 }]);
  assert.equal(health.save().length, 0);
});

test('automatic recovery stops at three exhausted stations and manual play opens a new round', () => {
  const stations = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const shared = runtime(async () => ({ ok: false }), {
    playablePool: () => stations, streamOf: station => `https://test/${station.id}`,
  });
  shared.bindEnv({ createStationHealth: () => createStationHealth({ random: () => 0 }) });
  const store = shared.ensureStore(createRadioStore); store.index(stations); store.select('a');
  let f; shared.ensurePlayback(options => (f = fixture(undefined, options)).core);
  f.core.play('a', 'https://test/a');
  let ticks = 0; while (f.timers.size && ticks++ < 30) f.tick();
  assert.equal(f.core.getState().stationId, 'c');
  // Out of stations: the failure stays visible instead of masquerading as a pause.
  assert.equal(f.core.getState().status, 'error');
  assert.equal(f.core.getState().error, 'startup-timeout');
  assert.equal(store.getSelected().id, 'c');
  assert.equal(f.delays.filter(delay => delay === 15000).length, 9);
  assert.deepEqual(shared.health.save().map(row => row.id), ['a', 'b', 'c']);
  assert.equal(store.stations().length, 4);
  f.core.resume(); assert.equal(f.core.getState().status, 'loading');
  for (let n = 0; n < 5; n++) f.tick();
  assert.equal(f.core.getState().stationId, 'd');
  shared.dispose(); assert.equal(f.timers.size, 0);
});

test('stable success needs ten seconds of advancing media, not merely a playing event', () => {
  let now = 100000; let successes = 0;
  const f = fixture(undefined, { now: () => now, onStable() { successes++; } });
  f.core.play('a', 'https://test/a'); f.emit('playing');
  now += 10000; f.emit('timeupdate'); assert.equal(successes, 0);
  f.audio.currentTime = 9; f.emit('timeupdate'); assert.equal(successes, 0);
  f.emit('waiting');
  f.audio.currentTime = 10; f.emit('timeupdate');
  now += 9000; f.audio.currentTime = 19; f.emit('timeupdate'); assert.equal(successes, 0);
  now += 1000; f.audio.currentTime = 20; f.emit('timeupdate'); assert.equal(successes, 1);
  now += 10000; f.audio.currentTime = 30; f.emit('timeupdate'); assert.equal(successes, 1);
  f.core.dispose();
});

test('offline: short blips stay failed, real outages resume on return', () => {
  let online = true; let failures = 0; let clock = 0; const events = new Map();
  const target = { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  const f = fixture(undefined, { isOnline: () => online, eventTarget: target, now: () => clock, onFailure() { failures++; } });
  f.core.play('a', 'https://test/a'); f.tick();
  // A sub-second blip: shown as a failure, never charged to the station, not auto-resumed.
  online = false; events.get('offline')();
  assert.equal(f.core.getState().status, 'error'); assert.equal(f.core.getState().error, 'offline');
  assert.equal(f.timers.size, 0); assert.equal(failures, 0);
  clock += 400; online = true; events.get('online')();
  assert.equal(f.core.getState().status, 'error'); assert.equal(f.timers.size, 0);
  // A real outage: the link was gone past the 1500 ms threshold, so it resumes on return.
  online = false; events.get('offline')();
  clock += 5000; online = true; events.get('online')();
  assert.equal(f.core.getState().status, 'loading');
  assert.equal(f.core.getState().stationId, 'a');
  assert.equal(f.timers.size, 1);
  f.core.play('b', 'https://test/b'); f.core.pause();
  assert.equal(failures, 0); assert.equal(f.timers.size, 0);
  f.core.dispose(); assert.equal(events.size, 0);
});

test('duplicate errors cannot consume retry slots or let a late playing event cancel backoff', () => {
  const f = fixture(); f.core.play('a', 'https://test/a');
  f.audio.error = { code: 3 }; f.emit('error'); f.emit('error'); f.emit('playing'); f.emit('timeupdate');
  assert.equal(f.delays.filter(delay => delay === 1000).length, 1);
  assert.equal(f.timers.size, 1); assert.equal(f.core.getState().status, 'loading');
  f.tick(); assert.equal(f.delays.filter(delay => delay === 15000).length, 2);
  f.core.play('b', 'https://test/b');
  assert.equal(f.core.getState().stationId, 'b'); f.core.dispose(); assert.equal(f.timers.size, 0);
});

test('a playing subscriber can pause or dispose without leaving a watchdog behind', () => {
  for (const action of ['pause', 'dispose']) {
    const f = fixture();
    f.core.subscribe(state => { if (state.status === 'playing') f.core[action](); });
    f.core.play('a', 'https://test/a'); f.emit('playing');
    assert.equal(f.timers.size, 0);
    assert.equal(f.core.getState().status, action === 'pause' ? 'paused' : 'idle');
    f.core.dispose();
  }
});

test('real panel scope intersects category, full search results and favourites without widening', () => {
  const stations = [{ id: 'outside', genre: 'rock' }, { id: 'a', genre: 'jazz' }, { id: 'b', genre: 'jazz' }];
  const shared = {}; let cleanup;
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const effect = source.slice(source.indexOf('      // Automatic recovery stays'), source.indexOf('      /** The one-line place a result'));
  const scope = { shared, store: { isFavorite: station => station.id === 'a' }, playablePool: () => stations,
    modeState: { categoryId: 'jazz' }, favMenu: {}, searchOpen: true, searchText: 'match', streamOf: () => 'stream',
    repository: { search(query, limit) { assert.equal(query, 'match'); assert.equal(limit, 3); return stations.slice(0, limit); } },
    useEffect(fn) { cleanup = fn(); },
  };
  vm.runInNewContext(effect, scope);
  assert.deepEqual(Array.from(shared.autoCandidates(), station => station.id), ['a']);
  scope.modeState.categoryId = 'missing'; assert.equal(shared.autoCandidates().length, 0);
  cleanup(); assert.equal(shared.autoCandidates, null);
});

test('IndexedDB health survives reopening without changing catalogue rows', async () => {
  const values = new Map();
  const db = { transaction() {
    const tx = { objectStore: () => ({
      get(key) { const request = {}; queueMicrotask(() => { request.result = values.get(key); request.onsuccess(); }); return request; },
      put(value, key) { values.set(key, structuredClone(value)); queueMicrotask(() => tx.oncomplete()); },
    }) };
    return tx;
  } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() {
    const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess(); }); return request;
  } } });
  try {
    const cache = await openRadioCache();
    await cache.writeCatalog([{ id: 'a' }], 123);
    const health = createStationHealth(); health.failure('a');
    assert.equal(await cache.writeHealth(health.save()), true);
    const reopened = await openRadioCache();
    const restored = createStationHealth(); restored.load(await reopened.readHealth());
    assert.equal(restored.save()[0].failures, 1);
    assert.deepEqual((await reopened.readCatalog()).rows, [{ id: 'a' }]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
