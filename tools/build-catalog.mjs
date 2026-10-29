/**
 * Build the station catalogue the plugin ships.
 *
 * The live repository fetches a few thousand stations at runtime and lets the
 * browser throw away the dead ones as they fail. This script does the same
 * filtering once, ahead of time, so a fresh install starts with a much larger
 * catalogue that is already known to answer:
 *
 *   1. fetch a candidate pool from Radio Browser (paged, parallel, mirrors);
 *   2. probe every candidate's stream URL with a one-byte ranged GET;
 *   3. keep the healthy ones, with a floor per country and per genre so small
 *      countries and niche genres survive a click-count ranking;
 *   4. write `data/catalog.v1.json` plus its gzip twin, and print the stats.
 *
 * The snapshot is deliberately NOT produced by `npm run build`: probing tens of
 * thousands of third-party streams takes minutes and belongs in a scheduled
 * job, not in every local build. Run it explicitly:
 *
 *   npm run build:catalog
 *
 * Every knob is an environment variable so CI can change the size without a
 * code edit:
 *
 *   CATALOG_TARGET=16000        stations kept in the snapshot
 *   CATALOG_FETCH=24000         candidates fetched before probing
 *   CATALOG_CHECK=1             0 skips probing (keeps every candidate)
 *   CATALOG_CHECK_CONCURRENCY=12
 *   CATALOG_CHECK_TIMEOUT=3500  ms per probe
 *   CATALOG_COUNTRY_FLOOR=6     guaranteed stations per country
 *   CATALOG_GENRE_FLOOR=40      guaranteed stations per genre
 */

import { mkdirSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGenre } from '../src/radio/genres.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data');
const OUT_JSON = join(OUT_DIR, 'catalog.v1.json');
const OUT_GZ = join(OUT_DIR, 'catalog.v1.json.gz');

const HOSTS = Object.freeze([
  'all.api.radio-browser.info',
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'at1.api.radio-browser.info',
]);

const USER_AGENT = 'dsh-blackhole-radio-lab/0.6 (catalog build)';
const PAGE_SIZE = 500;
const FETCH_CONCURRENCY = 4;

const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const TARGET = Math.max(200, envInt('CATALOG_TARGET', 12000));
const FETCH_LIMIT = Math.max(TARGET, envInt('CATALOG_FETCH', Math.round(TARGET * 1.35)));
const CHECK_ENABLED = envInt('CATALOG_CHECK', 1) !== 0;
const CHECK_CONCURRENCY = Math.max(1, envInt('CATALOG_CHECK_CONCURRENCY', 12));
const CHECK_TIMEOUT = Math.max(500, envInt('CATALOG_CHECK_TIMEOUT', 3500));
const COUNTRY_FLOOR = Math.max(0, envInt('CATALOG_COUNTRY_FLOOR', 6));
const GENRE_FLOOR = Math.max(0, envInt('CATALOG_GENRE_FLOOR', 40));

const clickCount = (row) => {
  const n = Number(row && row.clickcount);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const idOf = (row) => String((row && row.stationuuid) || '').trim();

const streamOf = (row) => {
  const resolved = String((row && row.url_resolved) || '').trim();
  if (resolved) return resolved;
  return String((row && row.url) || '').trim();
};

const countryOf = (row) => String((row && row.countrycode) || '').trim().toUpperCase();

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving
 * input order in the result array.
 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** One page of `/json/stations/search`, trying every mirror in order. */
async function fetchPage(offset, attemptHosts = HOSTS.length) {
  let lastError = null;
  for (let attempt = 0; attempt < attemptHosts; attempt += 1) {
    const host = HOSTS[attempt % HOSTS.length];
    const query =
      `https://${host}/json/stations/search?limit=${PAGE_SIZE}&offset=${offset}` +
      '&order=clickcount&reverse=true&hidebroken=true';
    try {
      const res = await fetch(query, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      return Array.isArray(body) ? body : [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('fetch failed');
}

/** Fetch the candidate pool, deduplicated by station uuid. */
async function fetchCandidates() {
  const pages = Math.ceil(FETCH_LIMIT / PAGE_SIZE);
  const offsets = Array.from({ length: pages }, (_, index) => index * PAGE_SIZE);
  const startedAt = Date.now();
  const batches = await runPool(offsets, FETCH_CONCURRENCY, async (offset) => {
    try {
      return await fetchPage(offset);
    } catch {
      return [];
    }
  });

  const seen = new Set();
  const rows = [];
  let failedPages = 0;
  for (const page of batches) {
    if (!Array.isArray(page) || page.length === 0) failedPages += 1;
    for (const row of page) {
      const id = idOf(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  console.log(
    `fetched ${rows.length} candidates in ${Date.now() - startedAt} ms ` +
      `(${pages - failedPages}/${pages} pages, ${failedPages} failed)`,
  );
  return rows;
}

/** True when the stream answers a one-byte ranged request. */
async function probe(row) {
  const url = streamOf(row);
  if (!/^https?:\/\//i.test(url)) return false;
  const attempt = async (headers) => {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...headers },
      signal: AbortSignal.timeout(CHECK_TIMEOUT),
      redirect: 'follow',
    });
    // A 200 that is an HTML page (captive portal, parked domain, Icecast error
    // page) is not a stream; a real one always declares audio somewhere.
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    const ok = (res.status === 200 || res.status === 206) && !type.includes('text/html');
    try {
      await res.body?.cancel();
    } catch {
      /* the body is already gone */
    }
    return { ok, status: res.status };
  };
  try {
    let result = await attempt({ range: 'bytes=0-0' });
    // Some servers reject Range outright (405/416) while serving the stream;
    // retry once without it before calling the station dead.
    if (!result.ok && (result.status === 405 || result.status === 416)) {
      result = await attempt({});
    }
    return result.ok;
  } catch {
    return false;
  }
}

/** Probe every candidate; failures are simply excluded. */
async function healthCheck(rows) {
  if (!CHECK_ENABLED) {
    console.log('health check disabled — keeping every candidate');
    return rows.map((row) => ({ row, healthy: true }));
  }
  const startedAt = Date.now();
  let done = 0;
  const checked = await runPool(rows, CHECK_CONCURRENCY, async (row) => {
    const healthy = await probe(row);
    done += 1;
    if (done % 200 === 0) {
      const elapsed = Date.now() - startedAt;
      const rate = done / Math.max(1, elapsed);
      const eta = Math.round((rows.length - done) / Math.max(0.001, rate) / 1000);
      process.stdout.write(`  probed ${done}/${rows.length} (${eta}s left)\r`);
    }
    return { row, healthy };
  });
  const healthy = checked.filter((entry) => entry.healthy).length;
  process.stdout.write('\n');
  console.log(
    `health check: ${healthy}/${rows.length} healthy ` +
      `(${((healthy / Math.max(1, rows.length)) * 100).toFixed(1)}%) ` +
      `in ${Date.now() - startedAt} ms`,
  );
  return checked;
}

/**
 * Pick the final set: country floors, then genre floors, then the rest by
 * click count. A floor never pushes the total past `target`.
 */
function pick(checked, target) {
  const healthy = checked
    .filter((entry) => entry.healthy)
    .map((entry) => entry.row)
    .sort((a, b) => clickCount(b) - clickCount(a));

  const chosen = new Map();
  const take = (row) => {
    const id = idOf(row);
    if (!id || chosen.has(id) || chosen.size >= target) return false;
    chosen.set(id, row);
    return true;
  };

  let countryHits = 0;
  if (COUNTRY_FLOOR > 0) {
    const counts = new Map();
    for (const row of healthy) {
      const code = countryOf(row);
      if (!code) continue;
      const seen = counts.get(code) ?? 0;
      if (seen >= COUNTRY_FLOOR) continue;
      if (take(row)) {
        counts.set(code, seen + 1);
        countryHits += 1;
      }
    }
  }

  let genreHits = 0;
  if (GENRE_FLOOR > 0) {
    const counts = new Map();
    for (const row of healthy) {
      const genre = classifyGenre(row).id;
      const seen = counts.get(genre) ?? 0;
      if (seen >= GENRE_FLOOR) continue;
      if (take(row)) {
        counts.set(genre, seen + 1);
        genreHits += 1;
      }
    }
  }

  for (const row of healthy) {
    if (chosen.size >= target) break;
    take(row);
  }

  console.log(
    `picked ${chosen.size} stations ` +
      `(country floors ${countryHits}, genre floors ${genreHits})`,
  );
  return [...chosen.values()];
}

/** Keep only the fields the client mapping reads, dropping empty ones. */
function compact(row) {
  const out = {};
  const put = (key, value) => {
    if (value === undefined || value === null) return;
    const text = typeof value === 'string' ? value.trim() : value;
    if (text === '' || text === 0) return;
    out[key] = text;
  };
  put('stationuuid', idOf(row));
  put('name', row.name);
  put('url_resolved', row.url_resolved);
  // `url` is only the fallback when the resolved URL is missing; keeping both
  // would duplicate the largest field in the snapshot.
  if (!out.url_resolved) put('url', row.url);
  put('countrycode', row.countrycode);
  put('country', row.country);
  put('language', row.language);
  put('languagecodes', row.languagecodes);
  put('tags', row.tags);
  put('codec', row.codec);
  put('bitrate', Number(row.bitrate) > 0 ? Number(row.bitrate) : 0);
  put('clickcount', Number(row.clickcount) > 0 ? Number(row.clickcount) : 0);
  // HLS is a real playback difference in the detail card; a missing flag reads
  // as `false` on the client, so only the truthy case is stored.
  if (Number(row.hls) === 1) out.hls = 1;
  return out;
}

async function main() {
  console.log(
    `catalog build: target ${TARGET}, fetch ${FETCH_LIMIT}, ` +
      `country floor ${COUNTRY_FLOOR}, genre floor ${GENRE_FLOOR}`,
  );
  const candidates = await fetchCandidates();
  if (candidates.length === 0) {
    throw new Error('Radio Browser returned no candidates; refusing to write an empty catalogue');
  }
  const checked = await healthCheck(candidates);
  const picked = pick(checked, TARGET);

  const stations = picked.map(compact);
  const countries = new Set(stations.map((row) => String(row.countrycode || '').toUpperCase()).filter(Boolean));
  const genres = new Map();
  for (const row of picked) {
    const id = classifyGenre(row).id;
    genres.set(id, (genres.get(id) ?? 0) + 1);
  }

  const snapshot = {
    v: 1,
    builtAt: new Date().toISOString(),
    source: 'radio-browser.info',
    requested: FETCH_LIMIT,
    candidates: candidates.length,
    healthy: checked.filter((entry) => entry.healthy).length,
    stations,
  };

  const json = JSON.stringify(snapshot);
  const gz = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  mkdirSync(OUT_DIR, { recursive: true });
  // Write through temp files and rename, so a reader never sees a half-written
  // twin: the host keys its cache on both files, but an interrupted build would
  // still leave the previous pair intact.
  const tmpJson = `${OUT_JSON}.tmp`;
  const tmpGz = `${OUT_GZ}.tmp`;
  writeFileSync(tmpJson, json, 'utf8');
  writeFileSync(tmpGz, gz);
  renameSync(tmpJson, OUT_JSON);
  renameSync(tmpGz, OUT_GZ);

  const genreText = [...genres.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => `${id}:${count}`)
    .join(' ');
  console.log(`countries ${countries.size} | genres ${genreText}`);
  console.log(
    `wrote ${OUT_JSON} (${statSync(OUT_JSON).size} B) ` +
      `and ${OUT_GZ} (${statSync(OUT_GZ).size} B)`,
  );
  console.log(
    `summary ${JSON.stringify({
      v: snapshot.v,
      builtAt: snapshot.builtAt,
      candidates: snapshot.candidates,
      healthy: snapshot.healthy,
      stations: stations.length,
      countries: countries.size,
      genres: Object.fromEntries(genres),
      bytes: { json: statSync(OUT_JSON).size, gzip: statSync(OUT_GZ).size },
    })}`,
  );
}

main().catch((error) => {
  console.error(`catalog build failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
