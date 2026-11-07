/**
 * Phase-5 data-intake checks: the Radio Browser source behind the station
 * repository.
 *
 * This file is a real test, not a fixture dump. It covers the three paths the
 * panel can take:
 *
 *   1. mapping      — a captured API row becomes the exact record the scene
 *                     consumes, and unusable rows are dropped, not repaired;
 *   2. fallback     — unreachable host, HTTP failure, timeout, non-array body
 *                     and zero usable rows all resolve to the mock repository,
 *                     never to a mixed catalogue and never to a thrown error;
 *   3. live         — one real request against Radio Browser, skipped with a
 *                     clear message when the environment has no network.
 *
 * Usage:
 *   node tools/validate-radio-data.mjs          # checks + summary
 *   node tools/validate-radio-data.mjs --json   # + machine-readable report
 *   node tools/validate-radio-data.mjs --offline-only  # skip the live request
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMockRadioRepository,
  createRadioRepository,
  createRepositoryFromRows,
  fetchRadioBrowserCatalog,
  RADIO_BROWSER_HOSTS,
} from '../src/radio/repository.js';
import {
  categoriesFor,
  isStreamUrl,
  mapStation,
  mapStations,
  streamUrlFor,
  MAPPING,
} from '../src/radio/radio-browser.js';
import { CATEGORIES } from '../src/radio/taxonomy.js';
import { DISK_INNER, DISK_OUTER } from '../src/scene/dimensions.js';
import { STATION_RADIUS } from '../src/radio/distribution.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const OFFLINE_ONLY = args.has('--offline-only');

const problems = [];
let checks = 0;
const sections = [];
let current = { name: 'mapping', checks: 0, passed: 0, failed: 0 };
sections.push(current);

function section(name) {
  const entry = { name, checks: 0, passed: 0, failed: 0 };
  sections.push(entry);
  current = entry;
  return entry;
}

function check(name, condition, detail) {
  checks += 1;
  current.checks += 1;
  if (condition) {
    current.passed += 1;
    return true;
  }
  current.failed += 1;
  problems.push(detail ? `${current.name}: ${name}: ${detail}` : `${current.name}: ${name}`);
  return false;
}

// --- 1. A captured API row ------------------------------------------------
//
// Captured from /json/stations/topclick/2 on 2026-10-23; fields trimmed to the
// ones the mapping reads, so this file stays a test rather than a fixture.

const CAPTURE = {
  changeuuid: '424b058f-32a8-4f45-9a12-1ad5a74da3a0',
  stationuuid: '042d3140-227c-4fac-9387-4903b692d5f2',
  name: 'RTL',
  url: 'https://live.m6radio.quortex.io/webM89Hc99XApzgfhXNX8ASN5/grouprtl/national/short/audio-64000/index.m3u8',
  url_resolved:
    'https://live.m6radio.quortex.io/webM89Hc99XApzgfhXNX8ASN5/grouprtl/national/short/audio-64000/index.m3u8',
  homepage: 'https://www.rtl.fr/',
  favicon: 'https://duckduckgo.com/i/035a5e15d396c67a.png',
  tags: 'généraliste',
  country: 'France',
  countrycode: 'FR',
  language: '',
  languagecodes: '',
  votes: 2757,
  codec: 'AAC',
  bitrate: 64,
  hls: 1,
  lastcheckok: 1,
  clickcount: 1552,
};

const station = mapStation(CAPTURE, () => 7);
check('maps a valid row', station !== null);
check('keeps stationuuid as the id', station && station.id === CAPTURE.stationuuid, station && station.id);
check('id is not the changeuuid', station && station.id !== CAPTURE.changeuuid);
check('uses url_resolved as streamUrl', station && station.streamUrl === CAPTURE.url_resolved);
check('records which field supplied the URL', station && station.metadata.streamSource === 'url_resolved');
check('carries the stable catalogue index', station && station.metadata.index === 7);
check('position is left for the layout', station && station.position === null);
check('is not marked as demo', station && station.metadata.demo === false);
check('source is named', station && station.metadata.source === 'radio-browser');
check('country is resolved to both languages', station && station.country.zh === '法国' && station.country.en === 'France');
check(
  'every category is a real taxonomy bucket',
  station && station.categories.every((id) => CATEGORIES.some((category) => category.id === id)),
  station && station.categories.join(','),
);
check('description is built from real fields', station && /64 kbps/.test(station.description.zh));
check('name, country, language are the panel contract', station && typeof station.name === 'string' && station.country && station.language && station.description);

// URL fallback: url_resolved empty → url.
const fallbackUrl = mapStation({ ...CAPTURE, url_resolved: '', url: 'http://direct.franceinfo.fr/live/franceinfo-midfi.mp3' });
check('falls back to url when url_resolved is empty', fallbackUrl && fallbackUrl.streamUrl === CAPTURE.url ? false : fallbackUrl && fallbackUrl.streamUrl === 'http://direct.franceinfo.fr/live/franceinfo-midfi.mp3');
check('records the url fallback', fallbackUrl && fallbackUrl.metadata.streamSource === 'url');

// Dropped rows.
const DROPS = [
  ['missing stationuuid', { ...CAPTURE, stationuuid: '' }],
  ['missing name', { ...CAPTURE, name: '   ' }],
  ['missing both addresses', { ...CAPTURE, url: '', url_resolved: '' }],
  ['non-http address', { ...CAPTURE, url: '', url_resolved: 'javascript:alert(1)' }],
  ['relative address', { ...CAPTURE, url: '', url_resolved: '/stream.mp3' }],

];
for (const [label, row] of DROPS) {
  check(`drops row: ${label}`, mapStation(row) === null);
}
check('drops null rows', mapStation(null) === null);
const failedCheck = mapStation({ ...CAPTURE, lastcheckok: 0 });
check('keeps a station after a failed upstream check', failedCheck !== null);
check('preserves the failed check as metadata only', failedCheck?.metadata.lastCheckOk === false);

const mixed = mapStations([CAPTURE, ...DROPS.map(([, row]) => row), CAPTURE]);
check('mapStations keeps the one valid row', mixed.stations.length === 1, `got ${mixed.stations.length}`);
check('mapStations counts the drops', mixed.dropped === DROPS.length, `got ${mixed.dropped} (expected ${DROPS.length})`);
check('mapStations counts the duplicate separately', mixed.duplicateIds === 1, `got ${mixed.duplicateIds}`);

check('isStreamUrl accepts https', isStreamUrl('https://example.org/a.mp3'));
check('isStreamUrl rejects whitespace', !isStreamUrl('https://example.org/a b.mp3'));
check('streamUrlFor prefers url_resolved', streamUrlFor({ url: 'http://a', url_resolved: 'https://b' }) === 'https://b');
check('streamUrlFor returns null without any address', streamUrlFor({ url: '', url_resolved: '' }) === null);

// Classification: tags win, name is the fallback, music the last resort.
check('tag \"jazz\" gives jazz', categoriesFor({ tags: 'jazz,smooth', name: 'X' }).categories[0] === 'jazz');
check('tag \"news\" gives news', categoriesFor({ tags: 'news,talk', name: 'X' }).categories[0] === 'news');
check('unknown tags fall back to music', categoriesFor({ tags: '', name: 'Radio Nowhere' }).categories[0] === 'music');
check('silent records are marked unmatched', categoriesFor({ tags: '', name: 'ZZZ' }).matched === false);
check('matching records are marked matched', categoriesFor({ tags: 'jazz', name: 'X' }).matched === true);
check(
  'classification never leaves the taxonomy',
  MAPPING.buckets.length === CATEGORIES.length && MAPPING.buckets.every((id) => CATEGORIES.some((c) => c.id === id)),
);

// --- 2. Same contract as the mock repository ------------------------------

section('contract');

const mock = createMockRadioRepository({ count: 400, seed: 7, featuredCount: 6 });
const methods = ['list', 'getById', 'search', 'categories', 'featured', 'anchors', 'stats'];
check('mock keeps its kind', mock.kind === 'mock');
check('mock exposes seed', mock.seed === 7);
for (const name of methods) check(`mock has ${name}()`, typeof mock[name] === 'function');

const rows = Array.from({ length: 60 }, (_, i) => ({
  ...CAPTURE,
  stationuuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  name: `Station ${i}`,
  tags: ['jazz', 'news', 'classical', 'talk', 'ambient', 'world', 'electronic', 'music'][i % 8],
  clickcount: 1000 - i,
}));
const real = createRepositoryFromRows(rows, { limit: 50, seed: 7, featuredCount: 6 });
check('repository is built from rows', real !== null);
check('real kind is radio-browser', real && real.kind === 'radio-browser');
check('real exposes the same methods', real && methods.every((name) => typeof real[name] === 'function'));
check('limit is honoured', real && real.list().length === 50, real && `${real.list().length}`);
check('stats name the source', real && real.stats().source === 'radio-browser' && real.stats().demo === false);
check('stats count the catalogue', real && real.stats().total === 50);
check('provenance records the drop rules', real && real.provenance && real.provenance.usable === 50);

// Every station gets the fields the scene consumes, and the layout came from
// the shared module, not from a second implementation.
const list = real ? real.list() : [];
check('list is stable between calls', real && real.list() === real.list());
check('ids are unique', new Set(list.map((item) => item.id)).size === list.length);
check('every id is a stationuuid', list.every((item) => /^[0-9a-f-]{36}$/i.test(item.id)));
check('every station has a streamUrl', list.every((item) => isStreamUrl(item.streamUrl)));
check('every station has a position triple', list.every((item) => item.position && Number.isFinite(item.position.x) && Number.isFinite(item.position.y) && Number.isFinite(item.position.z)));
check('every station has metadata.layout', list.every((item) => item.metadata.layout && Number.isFinite(item.metadata.layout.radius) && Number.isFinite(item.metadata.layout.angle) && Number.isFinite(item.metadata.layout.height)));
check('every station has metadata.clouds', list.every((item) => Array.isArray(item.metadata.clouds)));
check('every station has a primary category', list.every((item) => typeof item.metadata.primaryCategory === 'string' && item.metadata.primaryCategory.length > 0));

// Positions must sit inside the disk band the current scene uses — computed
// from dimensions.js, not from any README figure.
const radii = list.map((item) => Math.hypot(item.position.x, item.position.z));
const minRadius = Math.min(...radii);
const maxRadius = Math.max(...radii);
check(
  'positions sit inside the station band',
  minRadius >= STATION_RADIUS.inner - 1e-9 && maxRadius <= STATION_RADIUS.outer + 1e-9,
  `r ${minRadius.toFixed(3)}..${maxRadius.toFixed(3)} vs ${STATION_RADIUS.inner.toFixed(3)}..${STATION_RADIUS.outer.toFixed(3)}`,
);
check('positions stay outside the ISCO', minRadius >= DISK_INNER, `${minRadius} < ${DISK_INNER}`);
check('positions stay inside the visible disk', maxRadius <= DISK_OUTER, `${maxRadius} > ${DISK_OUTER}`);
check(
  'layout radius equals the position radius',
  list.every((item) => Math.abs(Math.hypot(item.position.x, item.position.z) - item.metadata.layout.radius) < 1e-9),
);
// The layout angle round-trips through cos/sin, so it agrees to ~1 ulp of 2π.
const wrapAngle = (value) => Math.atan2(Math.sin(value), Math.cos(value));
check(
  'layout angle equals the position angle',
  list.every((item) => Math.abs(wrapAngle(Math.atan2(item.position.z, item.position.x) - item.metadata.layout.angle)) < 1e-9),
);
check(
  'position height equals the layout height',
  list.every((item) => item.position.y === item.metadata.layout.height),
);
check(
  'clouds only name real taxonomy buckets',
  list.every((item) => item.metadata.clouds.every((cloud) => CATEGORIES.some((category) => category.id === cloud.categoryId))),
);
check(
  'clouds only cover categories the station carries',
  list.every((item) => item.metadata.clouds.every((cloud) => item.categories.includes(cloud.categoryId))),
);
check('presence and filterDelay are set for the renderer', list.every((item) => Number.isFinite(item.metadata.presence) && Number.isFinite(item.metadata.filterDelay)));

// anchors() — same shape as the mock anchors, counts agree with membership.
const anchors = real ? real.anchors() : [];
check('anchors cover every taxonomy bucket', anchors.length === CATEGORIES.length);
check(
  'anchors keep id/count/position',
  anchors.every((anchor) => typeof anchor.id === 'string' && Number.isInteger(anchor.count) && anchor.position && Number.isFinite(anchor.position.x)),
);
const expectedCounts = new Map(CATEGORIES.map((category) => [category.id, 0]));
for (const item of list) expectedCounts.set(item.metadata.primaryCategory, expectedCounts.get(item.metadata.primaryCategory) + 1);
check(
  'anchor counts match primary membership',
  anchors.every((anchor) => anchor.count === expectedCounts.get(anchor.id)),
);
check(
  'anchor positions are the primary centroid',
  anchors.every((anchor) => {
    if (anchor.count === 0) return true;
    const members = list.filter((item) => item.metadata.primaryCategory === anchor.id);
    const mean = members.reduce((sum, item) => sum + item.position.x, 0) / members.length;
    return Math.abs(mean - anchor.position.x) < 1e-9;
  }),
);
check(
  'empty buckets keep a finite anchor position',
  anchors.filter((anchor) => anchor.count === 0).every((anchor) => Number.isFinite(anchor.position.x) && Number.isFinite(anchor.position.y) && Number.isFinite(anchor.position.z)),
);

// featured(), categories(), getById(), search().
const ring = real ? real.featured() : [];
check('featured is a subset of list', ring.every((item) => list.includes(item)));
check('featured fills the photon ring', ring.length === 6, real && `${ring.length}`);
check(
  'featured picks the most-clicked stations',
  ring.every((item) => rows.slice(0, 6).some((row) => row.stationuuid === item.id)),
  ring.map((item) => item.id).join(','),
);
check('provenance agrees with featured()', real && real.provenance.featured === ring.length);
check('categories carry counts', real && real.categories().every((category) => Number.isInteger(category.count)));
check('getById finds a station', real && real.getById(list[3].id) === list[3]);
check('getById is case-insensitive for uuids', real && real.getById(list[3].id.toUpperCase()) === list[3]);
check('getById returns null for a stranger', real && real.getById('no-such-station') === null);
const hits = real ? real.search(list[49].name, 5) : [];
check('search finds an exact name', hits.length > 0 && hits[0].name === list[49].name);
check('search ranks the name prefix first', real ? real.search('Station 1', 3)[0].name === 'Station 1' : false);
check('search matches the country', real ? real.search('france', 5).length > 0 : false);
check('empty search returns nothing', mock.search('   ').length === 0);

// --- 3. Fallback paths ----------------------------------------------------

section('fallback');

function fakeFetch(behaviour) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return behaviour(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const FAST = { timeoutMs: 120, budgetMs: 800, maxHosts: 2, limit: 220 };

// a. every host refuses → mock, with a reason.
const refused = fakeFetch(async () => jsonResponse([], 503));
const refusedOutcome = await createRadioRepository({
  ...FAST,
  hosts: ['host-a.invalid', 'host-b.invalid'],
  fetch: refused,
});
check('unreachable falls back to mock', refusedOutcome.repository.kind === 'mock');
check('fallback carries a reason', refusedOutcome.fallback && refusedOutcome.fallback.reason === 'unreachable', refusedOutcome.fallback && refusedOutcome.fallback.reason);
check('fallback is never a blend', refusedOutcome.repository.list().every((item) => item.metadata.source === 'mock'));
check('fallback stats admit demo data', refusedOutcome.repository.stats().demo === true && refusedOutcome.repository.stats().source === 'mock');
check('every mirror was tried', refusedOutcome.attempts.length >= 2, `${refusedOutcome.attempts.length}`);
check('failed attempts carry the host', refusedOutcome.attempts.every((attempt) => attempt.host && attempt.ok === false));

// b. a network exception (DNS failure shape) → mock.
const thrown = fakeFetch(async () => {
  throw new TypeError('fetch failed');
});
const thrownOutcome = await createRadioRepository({ ...FAST, hosts: ['host-a.invalid'], fetch: thrown });
check('a thrown fetch falls back to mock', thrownOutcome.repository.kind === 'mock');
check('the exception is recorded', thrownOutcome.fallback && /fetch failed/.test(thrownOutcome.fallback.detail), thrownOutcome.fallback && thrownOutcome.fallback.detail);

// c. a hung host → timeout, then mock. The fake never resolves.
const hanging = fakeFetch(() => new Promise(() => {}));
const started = Date.now();
const hangingOutcome = await createRadioRepository({ ...FAST, hosts: ['host-a.invalid'], fetch: hanging });
const waited = Date.now() - started;
check('a hanging host falls back to mock', hangingOutcome.repository.kind === 'mock');
check('the timeout is bounded', waited < FAST.budgetMs + 3000, `${waited} ms`);
check('the failure names a timeout', hangingOutcome.attempts.some((attempt) => attempt.ok === false && attempt.timedOut === true), JSON.stringify(hangingOutcome.attempts));

// d. a non-array body (HTML error page, object) → mock.
const garbage = fakeFetch(async () => ({ ok: true, status: 200, text: async () => '<html>maintenance</html>' }));
const garbageOutcome = await createRadioRepository({ ...FAST, hosts: ['host-a.invalid'], fetch: garbage });
check('unparseable body falls back to mock', garbageOutcome.repository.kind === 'mock');
check('unparseable body is labelled', garbageOutcome.fallback && garbageOutcome.fallback.reason === 'unreachable');

// e. valid JSON, but every row is unusable → mock, not an empty scene.
const useless = fakeFetch(async () => jsonResponse([{ stationuuid: '', name: '' }, { stationuuid: 'x' }]));
const uselessOutcome = await createRadioRepository({ ...FAST, hosts: ['host-a.invalid'], fetch: useless });
check('rows without addresses fall back to mock', uselessOutcome.repository.kind === 'mock');
check('that failure is labelled separately', uselessOutcome.fallback && uselessOutcome.fallback.reason === 'no-usable-stations', uselessOutcome.fallback && uselessOutcome.fallback.reason);

// f. success after one dead mirror: the second host answers.
let call = 0;
const flaky = fakeFetch(async () => {
  call += 1;
  if (call === 1) return jsonResponse([], 500);
  return jsonResponse(rows);
});
const flakyOutcome = await createRadioRepository({ ...FAST, hosts: ['host-a.invalid', 'host-b.invalid'], fetch: flaky });
check('a dead mirror is skipped', flakyOutcome.repository.kind === 'radio-browser');
check('the retry is visible in the attempts', flakyOutcome.attempts.length === 2 && flakyOutcome.attempts[0].ok === false && flakyOutcome.attempts[1].ok === true);
check('no fallback is reported on success', flakyOutcome.fallback === null);

// g. mode: 'mock' never touches the network.
const untouched = fakeFetch(async () => jsonResponse(rows));
const forced = await createRadioRepository({ mode: 'mock', count: 400, fetch: untouched });
check("mode 'mock' skips the network", untouched.calls.length === 0);
check("mode 'mock' returns the mock repository", forced.repository.kind === 'mock');

// h. the raw fetch layer reports failure without throwing.
const catalogFail = await fetchRadioBrowserCatalog({ ...FAST, hosts: ['host-a.invalid'], fetch: thrown });
check('fetchRadioBrowserCatalog resolves on failure', catalogFail.ok === false && catalogFail.reason === 'unreachable');

// i. CORS / request shape: the request is a credential-free GET.
await createRadioRepository({ ...FAST, hosts: ['host-a.invalid'], fetch: untouched });
const probe = fakeFetch(async () => jsonResponse(rows));
await createRadioRepository({ ...FAST, hosts: ['host-a.invalid'], fetch: probe });
const init = probe.calls[0] && probe.calls[0].init;
check('requests are GET', init && init.method === 'GET');
const api = probe.calls[0] ? probe.calls[0].url : '';
check('requests use https', api.startsWith('https://'));
check('requests ask for json', /\/json\/stations\/search\?/.test(api), api);
check('requests ask only for working stations (hidebroken=true)', /hidebroken=true/.test(api));
check('requests send no credentials', init && init.credentials === 'omit');

// j. host list sanity: official mirrors only.
check('mirror list is non-empty', RADIO_BROWSER_HOSTS.length > 0);
check('mirror list uses radio-browser.info names', RADIO_BROWSER_HOSTS.every((host) => /^[a-z0-9]+\.api\.radio-browser\.info$/.test(host)));

// --- 4. Live request ------------------------------------------------------

section('live');

if (OFFLINE_ONLY || typeof fetch !== 'function') {
  check('live request skipped', true);
  current.skipped = true;
  console.log('live: skipped (offline-only or no fetch)');
} else {
  const liveStart = Date.now();
  const live = await fetchRadioBrowserCatalog({ limit: 220, timeoutMs: 6000, budgetMs: 20000 });
  const liveMs = Date.now() - liveStart;
  if (!live.ok) {
    check('live request answered', false, `${live.reason}: ${live.detail}`);
    console.log(`live: FAILED after ${liveMs} ms — ${live.reason}: ${live.detail}`);
  } else {
    const repo = live.repository;
    const items = repo.list();
    check('live request answered', true);
    check('live count reaches the brief minimum', items.length >= 200, `got ${items.length}`);
    check('live ids are unique', new Set(items.map((item) => item.id)).size === items.length);
    check('live ids are stationuuids', items.every((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)));
    check('live streamUrls are absolute http(s)', items.every((item) => isStreamUrl(item.streamUrl)));
    check('live positions are inside the disk band', items.every((item) => {
      const r = Math.hypot(item.position.x, item.position.z);
      return r >= STATION_RADIUS.inner - 1e-9 && r <= STATION_RADIUS.outer + 1e-9;
    }));
    check('live layout fields are present', items.every((item) => item.metadata.layout && Array.isArray(item.metadata.clouds)));
    check('live categories stay in the taxonomy', items.every((item) => item.categories.every((id) => CATEGORIES.some((c) => c.id === id))));
    check('live source is not demo', repo.stats().demo === false);
    const usedResolved = items.filter((item) => item.metadata.streamSource === 'url_resolved').length;
    const usedRaw = items.filter((item) => item.metadata.streamSource === 'url').length;
    console.log(
      `live: ${items.length} stations in ${liveMs} ms via ${(live.attempts.filter((a) => a.ok).map((a) => a.host))[0] || '?'}` +
        ` — url_resolved ${usedResolved}, url fallback ${usedRaw}, countries ${repo.stats().countries}, languages ${repo.stats().languages}`,
    );
    if (items.length < 200) {
      console.log(`live: SHORT — the upstream returned only ${items.length} usable stations`);
    }
  }
}

// --- 4. Shipped snapshot --------------------------------------------------
//
// The build-time catalogue is what a fresh install paints from, so its age is
// a release concern: a stale snapshot silently loses to the live API.

section('snapshot');

const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'catalog.v1.json');
let snapshot = null;
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
} catch {
  console.log('  (no data/catalog.v1.json — run npm run build:catalog)');
}
if (snapshot) {
  check('snapshot has version 1', snapshot.v === 1);
  check('snapshot carries stations', Array.isArray(snapshot.stations) && snapshot.stations.length > 0);
  const builtAt = Date.parse(snapshot.builtAt || '');
  check('snapshot has a build time', Number.isFinite(builtAt));
  const ageDays = Number.isFinite(builtAt) ? (Date.now() - builtAt) / 86400000 : Infinity;
  check('snapshot is younger than 30 days', ageDays < 30, `${ageDays.toFixed(1)} days`);
  check(
    'snapshot rows have an id and a url',
    snapshot.stations.every((row) => row.stationuuid && (row.url_resolved || row.url)),
  );
  console.log(`snapshot: ${snapshot.stations.length} stations, built ${snapshot.builtAt}`);
}

// --- report ---------------------------------------------------------------

const failed = problems.length > 0;
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ok: !failed,
        checks,
        failed: problems.length,
        sections,
        problems,
      },
      null,
      2,
    ),
  );
}

console.log('');
if (failed) {
  console.log(`RADIO DATA CHECKS FAILED — ${problems.length} of ${checks} checks`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('RADIO DATA CHECKS PASSED');
  console.log(`  checks:   ${checks}`);
  for (const entry of sections) {
    console.log(`  ${entry.name.padEnd(10)} ${entry.passed} passed${entry.failed ? `, ${entry.failed} failed` : ''}${entry.skipped ? ' (live skipped)' : ''}`);
  }
}
