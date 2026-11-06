/**
 * Catalogue builder shared by the CLI and the Host refresh job.
 *
 * The two callers differ only in where the result goes: `npm run build:catalog`
 * writes the snapshot that ships inside the package, the Host writes the user
 * cache the `/catalog` route prefers. Everything slow or subtle — paging over
 * mirrors, probing streams, keeping country and genre floors — lives here, so a
 * fix cannot land in one path and miss the other.
 *
 * The builder is pure with respect to the filesystem: it returns the snapshot
 * and its statistics and lets each caller decide how to persist them.
 */

import { classifyGenre } from '../radio/genres.js';

export const RADIO_BROWSER_HOSTS = Object.freeze([
  'all.api.radio-browser.info',
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'at1.api.radio-browser.info',
]);

export const BUILDER_USER_AGENT =
  'dsh-blackhole-radio-lab/1.0 (catalog build; +https://github.com/WhatCannotBeSaid/dsh-blackhole-radio-lab)';

/** Radio Browser caps a search page at 500 rows. */
const PAGE_SIZE = 500;
/** Candidate pages are cheap; four in flight keeps the mirrors happy. */
const FETCH_CONCURRENCY = 4;

export const BUILDER_DEFAULTS = Object.freeze({
  target: 12000,
  fetch: 16200,
  check: true,
  concurrency: 12,
  timeoutMs: 3500,
  countryFloor: 6,
  genreFloor: 40,
  hosts: RADIO_BROWSER_HOSTS,
  onProgress: null,
  signal: null,
  fetchImpl: null,
});

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
 * Clamp the caller's knobs into ranges the builder can actually honour.
 * @param options - partial {@link BUILDER_DEFAULTS}
 */
function normalize(options) {
  const input = options || {};
  const integer = (value, fallback, min, max) => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  const target = integer(input.target, BUILDER_DEFAULTS.target, 200, 60000);
  return {
    target,
    fetch: Math.max(target, integer(input.fetch, Math.round(target * 1.35), 200, 60000)),
    check: input.check !== false,
    concurrency: integer(input.concurrency, BUILDER_DEFAULTS.concurrency, 1, 64),
    timeoutMs: integer(input.timeoutMs, BUILDER_DEFAULTS.timeoutMs, 500, 30000),
    countryFloor: integer(input.countryFloor, BUILDER_DEFAULTS.countryFloor, 0, 200),
    genreFloor: integer(input.genreFloor, BUILDER_DEFAULTS.genreFloor, 0, 5000),
    hosts:
      Array.isArray(input.hosts) && input.hosts.length > 0
        ? input.hosts.map((host) => String(host))
        : RADIO_BROWSER_HOSTS,
    onProgress: typeof input.onProgress === 'function' ? input.onProgress : null,
    signal: input.signal || null,
    fetchImpl:
      typeof input.fetchImpl === 'function'
        ? input.fetchImpl
        : typeof globalThis.fetch === 'function'
          ? globalThis.fetch.bind(globalThis)
          : null,
  };
}

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

/**
 * A request signal that aborts on timeout or when the caller aborts.
 * @param ms - timeout in milliseconds
 * @param external - optional caller signal
 */
function createAbort(ms, external) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (typeof timer.unref === 'function') timer.unref();
  const onAbort = () => controller.abort(external.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    },
  };
}

/** One page of `/json/stations/search`, trying every mirror in order. */
async function fetchPage(offset, o) {
  let lastError = null;
  for (let attempt = 0; attempt < o.hosts.length; attempt += 1) {
    const host = o.hosts[attempt % o.hosts.length];
    const query =
      `https://${host}/json/stations/search?limit=${PAGE_SIZE}&offset=${offset}` +
      '&order=clickcount&reverse=true&hidebroken=false';
    const abort = createAbort(20000, o.signal);
    try {
      const res = await o.fetchImpl(query, {
        headers: { 'user-agent': BUILDER_USER_AGENT, accept: 'application/json' },
        signal: abort.signal,
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      return Array.isArray(body) ? body : [];
    } catch (error) {
      if (o.signal && o.signal.aborted) throw error;
      lastError = error;
    } finally {
      abort.dispose();
    }
  }
  throw lastError ?? new Error('fetch failed');
}

/** Fetch the candidate pool, deduplicated by station uuid. */
async function fetchCandidates(o) {
  const pages = Math.ceil(o.fetch / PAGE_SIZE);
  const offsets = Array.from({ length: pages }, (_, index) => index * PAGE_SIZE);
  const startedAt = Date.now();
  const batches = await runPool(offsets, FETCH_CONCURRENCY, async (offset) => {
    try {
      return await fetchPage(offset, o);
    } catch (error) {
      if (o.signal && o.signal.aborted) throw error;
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
  o.onProgress?.({
    phase: 'fetch',
    done: rows.length,
    total: o.fetch,
    pages,
    failedPages,
    elapsedMs: Date.now() - startedAt,
  });
  return rows;
}

/** True when the stream answers a one-byte ranged request. */
async function probe(row, o) {
  const url = streamOf(row);
  if (!/^https?:\/\//i.test(url)) return false;
  const attempt = async (headers) => {
    const abort = createAbort(o.timeoutMs, o.signal);
    try {
      const res = await o.fetchImpl(url, {
        method: 'GET',
        headers: { 'user-agent': BUILDER_USER_AGENT, accept: '*/*', ...headers },
        signal: abort.signal,
        redirect: 'follow',
      });
      // A 200 that is an HTML page (captive portal, parked domain, Icecast
      // error page) is not a stream; a real one always declares audio somewhere.
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      const ok = (res.status === 200 || res.status === 206) && !type.includes('text/html');
      try {
        await res.body?.cancel();
      } catch {
        /* the body is already gone */
      }
      return { ok, status: res.status };
    } catch (error) {
      if (o.signal && o.signal.aborted) throw error;
      return { ok: false, status: 0 };
    } finally {
      abort.dispose();
    }
  };
  try {
    let result = await attempt({ range: 'bytes=0-0' });
    // Some servers reject Range outright (405/416) while serving the stream;
    // retry once without it before calling the station dead.
    if (!result.ok && (result.status === 405 || result.status === 416)) {
      result = await attempt({});
    }
    return result.ok;
  } catch (error) {
    if (o.signal && o.signal.aborted) throw error;
    return false;
  }
}

/** Probe every candidate; failures are simply excluded. */
async function healthCheck(rows, o) {
  if (!o.check) return rows.map((row) => ({ row, healthy: true }));
  const startedAt = Date.now();
  let done = 0;
  let healthy = 0;
  const checked = await runPool(rows, o.concurrency, async (row) => {
    const ok = await probe(row, o);
    done += 1;
    if (ok) healthy += 1;
    if (done % 200 === 0 || done === rows.length) {
      o.onProgress?.({
        phase: 'probe',
        done,
        total: rows.length,
        healthy,
        elapsedMs: Date.now() - startedAt,
      });
    }
    return { row, healthy: ok };
  });
  return checked;
}

/**
 * Stop a build that the caller has cancelled.
 *
 * Aborting only interrupts network awaits; a build that was already past its
 * probes would otherwise finish picking and hand a stale result to the caller.
 * Checking between phases keeps a disabled plugin from writing a cache it was
 * told to abandon.
 */
function assertNotAborted(o) {
  if (o.signal && o.signal.aborted) {
    throw o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted');
  }
}

/**
 * Pick the final set: country floors, then genre floors, then the rest by
 * click count. A floor never pushes the total past `target`.
 */
function pick(checked, o) {
  const healthy = checked
    .filter((entry) => entry.healthy)
    .map((entry) => entry.row)
    .sort((a, b) => clickCount(b) - clickCount(a));

  const chosen = new Map();
  const take = (row) => {
    const id = idOf(row);
    if (!id || chosen.has(id) || chosen.size >= o.target) return false;
    chosen.set(id, row);
    return true;
  };

  let countryHits = 0;
  if (o.countryFloor > 0) {
    const counts = new Map();
    for (const row of healthy) {
      const code = countryOf(row);
      if (!code) continue;
      const seen = counts.get(code) ?? 0;
      if (seen >= o.countryFloor) continue;
      if (take(row)) {
        counts.set(code, seen + 1);
        countryHits += 1;
      }
    }
  }

  let genreHits = 0;
  if (o.genreFloor > 0) {
    const counts = new Map();
    for (const row of healthy) {
      const genre = classifyGenre(row).id;
      const seen = counts.get(genre) ?? 0;
      if (seen >= o.genreFloor) continue;
      if (take(row)) {
        counts.set(genre, seen + 1);
        genreHits += 1;
      }
    }
  }

  for (const row of healthy) {
    if (chosen.size >= o.target) break;
    take(row);
  }

  o.onProgress?.({ phase: 'pick', picked: chosen.size, countryHits, genreHits });
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

/**
 * Fetch, probe and pick one catalogue.
 *
 * @param options - overrides for {@link BUILDER_DEFAULTS}
 * @returns {Promise<{snapshot: object, stats: object}>}
 */
export async function buildCatalog(options = {}) {
  const o = normalize(options);
  if (!o.fetchImpl) throw new Error('fetch is not available in this runtime');

  // A caller that already holds candidates (re-checking a shipped snapshot,
  // for instance) skips the network fetch and only pays for the probes. The
  // fetch count is then the pool size, so the snapshot still reports how many
  // stations were considered.
  const supplied = Array.isArray(options.candidates) && options.candidates.length > 0
    ? options.candidates
    : null;
  const candidates = supplied ?? (await fetchCandidates(o));
  const requested = supplied ? supplied.length : o.fetch;
  assertNotAborted(o);
  if (candidates.length === 0) {
    throw new Error('Radio Browser returned no candidates; refusing to build an empty catalogue');
  }

  const checked = await healthCheck(candidates, o);
  assertNotAborted(o);
  const picked = pick(checked, o);
  const stations = picked.map(compact);
  const healthy = checked.filter((entry) => entry.healthy).length;

  const countries = new Set(
    stations.map((row) => String(row.countrycode || '').toUpperCase()).filter(Boolean),
  );
  const genres = new Map();
  for (const row of picked) {
    const id = classifyGenre(row).id;
    genres.set(id, (genres.get(id) ?? 0) + 1);
  }

  const snapshot = {
    v: 1,
    builtAt: new Date().toISOString(),
    source: 'radio-browser.info',
    requested,
    candidates: candidates.length,
    healthy,
    stations,
  };
  const stats = {
    requested,
    candidates: candidates.length,
    healthy,
    picked: stations.length,
    countries: countries.size,
    genres: Object.fromEntries(genres),
    target: o.target,
  };
  o.onProgress?.({ phase: 'done', ...stats });
  return { snapshot, stats };
}
