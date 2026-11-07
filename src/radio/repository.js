/**
 * The data-access boundary for the station map.
 *
 * Everything above this line (scene, picking, labels, panel) talks to the same
 * small interface:
 *
 *   list()                    → all stations, stable order
 *   getById(id)               → one station or null
 *   search(query, limit)      → ranked matches, local only
 *   categories()              → taxonomy with per-category counts
 *   featured()                → the photon-ring subset
 *   anchors()                 → spatial cluster centres, for labels
 *   stats()                   → counts the rail reports
 *   kind                      → 'mock' | 'radio-browser'
 *   seed                      → the seed the layout was computed with
 *
 * Ids stay the stable key; three.js instance indices live in the renderer,
 * never here.
 *
 * Two sources, one contract:
 *
 *   createMockRadioRepository(options)
 *       Synchronous, deterministic, offline. Unchanged from earlier phases and
 *       still the fallback entry point.
 *
 *   createRadioBrowserRepository(options) / await createRadioRepository(options)
 *       Live data from Radio Browser, mapped through ./radio-browser.js and
 *       placed by the *same* `assignPositions` the mock catalogue uses, so a
 *       real station sits in the disk the scene already renders. Never throws:
 *       a failed fetch resolves to a mock repository whose `fallback.reason`
 *       says why, and `stats().source` stays honest about what is on screen.
 *
 * Search runs entirely against the loaded catalogue: no fetch, no index
 * library, no dependency. The haystack is precomputed once per station, and
 * every source builds `haystacks`/`byId` through the same assembly step so the
 * search behaves identically on mock and real data.
 *
 * A mixed catalogue is impossible by construction: `createRadioRepository`
 * either returns the real repository or the mock one, never a blend.
 */

import { generateCatalog, normalizeCatalogOptions, categoryText } from './station.js';
import { assignPositions } from './distribution.js';
import { CATEGORIES } from './taxonomy.js';
import { mapStations, streamUrlFor } from './radio-browser.js';
import { attachGenre, summarizeGenres, displayGenreId, genreLabel, GENRES, GENRE_IDS } from './genres.js';

/**
 * Radio Browser mirrors are round-robin DNS names, not fixed hosts: a mirror
 * can disappear without notice (two of the five official names did not answer
 * when this phase was written). The list is therefore ordered and tried in
 * sequence, and every request carries a timeout — a mirror that hangs must not
 * hold the panel open.
 *
 * `all.api.radio-browser.info` is first: it fans out across the healthy set
 * server-side, so a single dead mirror rarely costs a request.
 */
export const RADIO_BROWSER_HOSTS = Object.freeze([
  'all.api.radio-browser.info',
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'at1.api.radio-browser.info',
  'nl1.api.radio-browser.info',
]);

/** Defaults for the real source; every knob is overridable. */
export const RADIO_BROWSER_DEFAULTS = Object.freeze({
  /** How many usable stations to aim for (the brief asks for at least 200). */
  limit: 240,
  /** API page size; 500 keeps a whole station list in one request. */
  pageSize: 500,
  /** Per-request timeout, ms. */
  timeoutMs: 6000,
  /** Total time budget across mirrors and pages, ms. */
  budgetMs: 20000,
  /**
   * Pages fetched in parallel from one mirror. The directory answers each page
   * independently, so four in flight turn a ten-page load into roughly three
   * round trips instead of ten.
   */
  concurrency: 4,
  /** Hosts tried before giving up. */
  maxHosts: 3,
  seed: 20261022,
  featuredCount: 18,
  /**
   * The order the API is asked in. Click count is popularity in the last 28
   * days and carries real diversity (France/US/GB/ID/IT/ES …); raw vote count
   * is dominated by a few national broadcasters and a large tag-less block.
   */
  order: 'clickcount',
  /**
   * Ask Radio Browser for stations it still marks as working, matching the
   * prebuilt catalogue (`src/host/catalog-builder.js` sends hidebroken=true).
   * A caller can still opt out with `hidebroken: false`.
   */
  hidebroken: true,
  /**
   * `curl` / `https` — the API's own preference for identifiable clients.
   * The browser cannot set User-Agent, and the field is only advisory.
   */
  userAgent: 'dsh-blackhole-radio-lab/0.5 (phase 5 data intake)',
});

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeRealOptions(options) {
  const source = options || {};
  const hosts =
    Array.isArray(source.hosts) && source.hosts.length > 0
      ? source.hosts.map((host) => String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '')).filter(Boolean)
      : RADIO_BROWSER_HOSTS.slice();
  const limit = Math.round(clampNumber(source.limit, RADIO_BROWSER_DEFAULTS.limit, 50, 60000));
  const pageSize = Math.round(clampNumber(source.pageSize, RADIO_BROWSER_DEFAULTS.pageSize, 20, 2000));
  return {
    hosts,
    maxHosts: Math.round(clampNumber(source.maxHosts, RADIO_BROWSER_DEFAULTS.maxHosts, 1, hosts.length)),
    limit,
    pageSize,
    timeoutMs: Math.round(clampNumber(source.timeoutMs, RADIO_BROWSER_DEFAULTS.timeoutMs, 250, 60000)),
    budgetMs: Math.round(clampNumber(source.budgetMs, RADIO_BROWSER_DEFAULTS.budgetMs, 500, 120000)),
    seed: typeof source.seed === 'number' && Number.isFinite(source.seed)
      ? Math.abs(Math.round(source.seed)) >>> 0
      : typeof source.seed === 'string' && source.seed.length > 0
        ? Math.abs(hashText(source.seed)) >>> 0
        : RADIO_BROWSER_DEFAULTS.seed >>> 0,
    featuredCount: Math.round(
      clampNumber(source.featuredCount, RADIO_BROWSER_DEFAULTS.featuredCount, 4, Math.min(40, limit)),
    ),
    order: typeof source.order === 'string' && source.order.length > 0 ? source.order : RADIO_BROWSER_DEFAULTS.order,
    hidebroken: source.hidebroken !== false,
    concurrency: Math.round(clampNumber(source.concurrency, RADIO_BROWSER_DEFAULTS.concurrency, 1, 8)),
    userAgent: typeof source.userAgent === 'string' && source.userAgent.length > 0
      ? source.userAgent
      : RADIO_BROWSER_DEFAULTS.userAgent,
    fetchImpl: typeof source.fetch === 'function' ? source.fetch : defaultFetch(),
    // Carried through so a caller can cancel the in-flight batch; without it
    // `collectRows` checked a signal that never arrived and could not abort.
    signal: source.signal || null,
  };
}

function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function defaultFetch() {
  if (typeof fetch === 'function') return fetch.bind(globalThis);
  return null;
}

/**
 * One HTTP request with a hard timeout.
 *
 * Radio Browser answers `text/plain` without charset on some mirrors, and
 * `response.json()` then guesses; the body is decoded as UTF-8 explicitly so a
 * non-ASCII station name survives.
 *
 * A `fetch` that never settles — a proxy swallowing the connection, a host
 * that accepts and then says nothing — cannot be rescued by the abort signal
 * alone: the signal is only useful to an implementation that honours it. So the
 * request is also raced against its own timer, and the loser is discarded. The
 * abandoned request keeps running until the transport gives up, which costs one
 * idle socket; refusing to fall back costs the whole panel.
 */
async function fetchJson(fetchImpl, url, { signal, timeoutMs, headers }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  let timer = null;

  const onAbort = () => {
    if (controller) controller.abort();
  };
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const request = (async () => {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller ? controller.signal : signal,
      credentials: 'omit',
      // The API is third-party; no cookies, no caching of a moving catalogue.
      mode: 'cors',
      cache: 'no-store',
    });
    if (!response || !response.ok) {
      const status = response ? response.status : 0;
      const error = new Error(`HTTP ${status || 'no response'}`);
      error.status = status;
      throw error;
    }
    const text = await response.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      const error = new Error('response is not a station array');
      throw error;
    }
    return parsed;
  })();
  // A rejected loser must not surface as an unhandled rejection.
  request.catch(() => {});

  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      onAbort();
      const error = new Error(`no answer within ${timeoutMs} ms`);
      error.name = 'TimeoutError';
      error.timedOut = true;
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')))) {
      error.timedOut = timedOut || (signal ? signal.aborted !== true : true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  }
}

function stationQuery(opts, offset) {
  // Every parallel page starts inside `limit`, so this is normally pageSize.
  // The floor only guards a caller that asks for the exact end of the
  // catalogue; the API rejects a non-positive limit.
  const take = Math.max(1, Math.min(opts.pageSize, opts.limit - offset));
  const params = new URLSearchParams({
    limit: String(take),
    offset: String(offset),
    order: opts.order,
    reverse: 'true',
    hidebroken: opts.hidebroken ? 'true' : 'false',
  });
  return `/json/stations/search?${params.toString()}`;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving
 * the input order in the result. Small enough to keep inline; the project
 * deliberately carries no pool dependency.
 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(Math.round(concurrency) || 1, items.length));
  const runners = [];
  for (let slot = 0; slot < width; slot += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

/**
 * Collect stations across mirrors until `limit` usable rows are held or the
 * budget runs out. Every failure is recorded; a mirror that answered partial
 * data is not tried again.
 *
 * Pages are fetched in parallel ({@link RADIO_BROWSER_DEFAULTS.concurrency} at
 * a time) because the directory answers each offset independently. A page that
 * fails does not stop its siblings: the rows that did arrive are kept, and the
 * next mirror tops up the shortfall. A short page is simply the end of the
 * catalogue, so no second round trip is spent confirming it.
 *
 * @returns {{rows, attempts, hostsUsed, exhaustedBudget}}
 */
async function collectRows(opts, signal) {
  const attempts = [];
  const rows = [];
  const seen = new Set();
  const hostsUsed = [];
  const hosts = opts.hosts.slice(0, opts.maxHosts);
  const deadline = Date.now() + opts.budgetMs;
  const headers = { accept: 'application/json', 'user-agent': opts.userAgent };
  const fetchImpl = opts.fetchImpl;

  if (typeof fetchImpl !== 'function') {
    return {
      rows,
      attempts: [{ host: null, url: null, ok: false, error: 'fetch is unavailable in this environment' }],
      hostsUsed,
      exhaustedBudget: false,
    };
  }

  const pageCount = Math.max(1, Math.ceil(opts.limit / opts.pageSize));
  const offsets = [];
  for (let index = 0; index < pageCount; index += 1) offsets.push(index * opts.pageSize);

  for (const host of hosts) {
    if (rows.length >= opts.limit) break;
    if (signal && signal.aborted) break;
    if (Date.now() >= deadline) break;
    hostsUsed.push(host);

    const pages = await runPool(offsets, opts.concurrency, async (offset) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || (signal && signal.aborted)) return { skipped: true };
      const path = stationQuery(opts, offset);
      const url = `https://${host}${path}`;
      try {
        const page = await fetchJson(fetchImpl, url, {
          signal,
          timeoutMs: Math.min(opts.timeoutMs, remaining),
          headers,
        });
        return { path, page };
      } catch (error) {
        const timedOut = Boolean(error && (error.timedOut || error.name === 'TimeoutError' || error.name === 'AbortError'));
        return {
          path,
          error: {
            host,
            path,
            ok: false,
            status: error && error.status ? error.status : null,
            error: error && error.message ? error.message : String(error),
            timedOut,
          },
        };
      }
    });

    for (const result of pages) {
      if (!result || result.skipped) continue;
      if (result.error) {
        attempts.push(result.error);
        continue;
      }
      let added = 0;
      for (const row of result.page) {
        const id = row && row.stationuuid ? String(row.stationuuid) : '';
        if (id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        rows.push(row);
        added += 1;
        if (rows.length >= opts.limit) break;
      }
      attempts.push({ host, path: result.path, ok: true, received: result.page.length, added });
      if (rows.length >= opts.limit) break;
    }
  }

  return {
    rows,
    attempts,
    hostsUsed,
    exhaustedBudget: Date.now() >= deadline && rows.length < opts.limit,
  };
}

/** Assemble the shared repository surface over an already-placed catalogue. */
function buildRepository({ stations, catalog, layout, extra }) {
  const byId = new Map();
  const haystacks = new Array(stations.length);

  const countries = new Set();
  const languages = new Set();

  for (let index = 0; index < stations.length; index += 1) {
    const station = stations[index];
    byId.set(station.id, station);
    const genre = attachGenre(station);
    const categoryWords = (station.categories || [])
      .map((id) => `${categoryText(id, 'zh')} ${categoryText(id, 'en')}`)
      .join(' ');
    const genreWords = `${genreLabel(genre, 'zh')} ${genreLabel(genre, 'en')} ${genre}`;
    const tags = station.metadata && Array.isArray(station.metadata.tags) ? station.metadata.tags.join(' ') : '';
    haystacks[index] = [
      station.name,
      station.country.zh,
      station.country.en,
      station.language.zh,
      station.language.en,
      categoryWords,
      genreWords,
      tags,
    ]
      .join(' ')
      .toLowerCase();
    countries.add(station.country.en);
    languages.add(station.language.en);
  }

  // Genre counts and the display grouping are derived once, from the stations
  // that actually loaded. Every caller sees the same numbers.
  const genreSummary = summarizeGenres(stations);
  const groupOf = (id) => displayGenreId(id, genreSummary.merged);

  /**
   * Ranked local search. Substring matching, all query tokens must hit; name
   * hits rank above metadata hits. No network, no fuzzy-index dependency.
   */
  function search(query, limit = 24) {
    const text = String(query || '').trim().toLowerCase();
    if (text.length === 0) return [];
    const tokens = text.split(/\s+/).filter(Boolean).slice(0, 6);
    const max = Math.max(1, Math.min(60, limit));
    const hits = [];

    for (let index = 0; index < stations.length; index += 1) {
      const haystack = haystacks[index];
      let matched = true;
      for (const token of tokens) {
        if (!haystack.includes(token)) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const station = stations[index];
      const name = station.name.toLowerCase();
      let score = 0;
      if (name.startsWith(text)) score = 3;
      else if (name.includes(text)) score = 2;
      if (station.isFeatured) score += 0.25;
      hits.push({ station, score });
    }

    hits.sort((a, b) => b.score - a.score || a.station.name.localeCompare(b.station.name));
    return hits.slice(0, max).map((hit) => hit.station);
  }

  const base = {
    seed: extra.seed,
    list() {
      return stations;
    },
    getById(id) {
      const key = String(id);
      const direct = byId.get(key);
      if (direct) return direct;
      // Radio Browser ids are UUIDs; a panel that lowercased or uppercased one
      // must still resolve, so fall back to a case-insensitive lookup.
      const lowered = key.toLowerCase();
      for (const station of stations) {
        if (station.id.toLowerCase() === lowered) return station;
      }
      return null;
    },
    search,
    categories() {
      return catalog.categories;
    },
    featured() {
      return layout.featured;
    },
    anchors() {
      return layout.anchors;
    },
    /**
     * The genre layer, as it applies to this sample.
     *
     * `definitions` is the fixed thirteen and never changes with the data.
     * Everything else describes the stations that actually loaded: `raw` counts
     * per genre, `visible` the display groups that may become nebulae, `merged`
     * the genres too small to show on their own, `hidden` the empty ones.
     * It is a statement about this sample, not about the Radio Browser
     * database, and the panel says so.
     */
    genres() {
      return { definitions: GENRES, ...genreSummary };
    },
    /** Genres per display group, ready for a nebula's size. */
    visibleGenres() {
      return genreSummary.visible;
    },
    /** `{ genreId: count }` for the thirteen raw genres. */
    genreCounts() {
      return Object.fromEntries(genreSummary.raw.map((entry) => [entry.id, entry.count]));
    },
    /**
     * Stations of one genre, in catalogue order.
     *
     * `display` (default true) resolves the id the way the nebula space shows
     * it, so a genre folded into Other resolves to Other's group and Other
     * includes everything merged into it. `display: false` answers for the raw
     * genre, so a station that was merged stays reachable both ways.
     */
    listByGenre(id, options) {
      const key = String(id);
      if (!GENRE_IDS.includes(key)) return [];
      const display = !options || options.display !== false;
      if (!display) return stations.filter((station) => (station.genre || 'other') === key);
      return stations.filter((station) => groupOf(station.genre || 'other') === key);
    },
    stats() {
      return {
        total: stations.length,
        featured: layout.featured.length,
        countries: countries.size,
        languages: languages.size,
        categories: catalog.categories.length,
        genres: genreSummary.raw.length,
        genreVisible: genreSummary.visible.length,
        genreMerged: genreSummary.merged.length,
        seed: extra.seed,
        source: extra.source,
        demo: extra.source === 'mock',
      };
    },
  };

  if (extra.source === 'mock') {
    return Object.assign(base, { kind: 'mock' });
  }

  return Object.assign(base, {
    kind: 'radio-browser',
    /** Everything the panel needs to describe where the data came from. */
    provenance: extra.provenance,
  });
}

/** Category counts for a station list, in the taxonomy's order. */
function countCategories(stations) {
  const counts = new Map();
  for (const station of stations) {
    for (const id of station.categories || []) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function catalogFor(stations) {
  const counts = countCategories(stations);
  return {
    categories: CATEGORIES.map((category) => ({
      ...category,
      count: counts.get(category.id) || 0,
    })),
  };
}

/**
 * Deterministic mock repository — unchanged interface.
 * @param options.count - station count, 200–20,000.
 * @param options.seed - integer seed.
 * @param options.featuredCount - how many stations sit on the photon ring.
 */
export function createMockRadioRepository(options) {
  const opts = normalizeCatalogOptions(options);
  const catalog = generateCatalog(opts);
  const layout = assignPositions(catalog.stations, opts.seed);
  return buildRepository({
    stations: catalog.stations,
    catalog,
    layout,
    extra: { seed: opts.seed, source: 'mock' },
  });
}

/**
 * Build a repository from already-fetched rows (or already-mapped stations).
 *
 * Exported because it is the testable half: the network half is
 * {@link fetchRadioBrowserCatalog}, and the two meet here.
 *
 * @param rows - Radio Browser station objects.
 * @param options - { seed, featuredCount, limit }.
 */
export function createRepositoryFromRows(rows, options) {
  const opts = normalizeRealOptions(options);
  const source = Array.isArray(rows) ? rows : [];
  // Failure memory is session-only and applied at play time (see client.js);
  // filtering here would keep a station out for good, which is exactly what a
  // single bad moment must not do.
  const mapped = mapStations(source);
  let stations = mapped.stations.slice(0, opts.limit);

  if (stations.length === 0) return null;

  // `metadata.index` is assigned by the mapping before truncation; re-stamp it
  // so it is the station's index in the catalogue the layout walks.
  for (let index = 0; index < stations.length; index += 1) {
    stations[index].metadata.index = index;
  }

  // Real rows never carry `isFeatured`, so without this the photon-ring arcs
  // stay empty. Pick the most-clicked stations; ties break on the catalogue
  // index, which keeps the choice stable across reloads and snapshots.
  const ringCount = Math.min(opts.featuredCount, stations.length);
  if (ringCount > 0) {
    const ranked = stations
      .map((station, index) => ({ index, clicks: Number(station.metadata && station.metadata.clickcount) || 0 }))
      .sort((a, b) => b.clicks - a.clicks || a.index - b.index);
    for (let rank = 0; rank < ringCount; rank += 1) {
      stations[ranked[rank].index].isFeatured = true;
    }
  }

  const catalog = catalogFor(stations);
  const layout = assignPositions(stations, opts.seed);
  const featuredCount = layout.featured.length;

  return buildRepository({
    stations,
    catalog: { ...catalog, seed: opts.seed, count: stations.length },
    layout,
    extra: {
      seed: opts.seed,
      source: 'radio-browser',
      provenance: {
        hosts: opts.hosts.slice(0, opts.maxHosts),
        order: opts.order,
        received: source.length,
        usable: stations.length,
        dropped: mapped.dropped,
        duplicateIds: mapped.duplicateIds,
        featured: featuredCount,
        requested: opts.limit,
        short: stations.length < opts.limit,
        fetchedAt: new Date().toISOString(),
      },
    },
  });
}

/**
 * Fetch Radio Browser rows and map them into a repository.
 *
 * Resolves, never rejects, with one of:
 *   { ok: true,  repository, rows, attempts }
 *   { ok: false, reason, detail, rows: [], attempts }
 */
export async function fetchRadioBrowserCatalog(options) {
  const opts = normalizeRealOptions(options);
  const signal = opts.signal;
  const collected = await collectRows(opts, signal);

  if (signal && signal.aborted) {
    return { ok: false, reason: 'aborted', detail: 'request cancelled', rows: [], attempts: collected.attempts };
  }
  if (collected.rows.length === 0) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: collected.attempts.map(describeAttempt).filter(Boolean).join('; ') || 'no host answered',
      rows: [],
      attempts: collected.attempts,
    };
  }

  const repository = createRepositoryFromRows(collected.rows, opts);
  if (!repository) {
    return {
      ok: false,
      reason: 'no-usable-stations',
      detail: `${collected.rows.length} rows received, none had a stable id, a name and a valid stream URL`,
      // These rows mapped to nothing; handing them to a caller that caches
      // "the last successful catalogue" would poison that cache with rows the
      // next read has to fetch past.
      rows: [],
      attempts: collected.attempts,
    };
  }

  return {
    ok: true,
    repository,
    rows: collected.rows,
    attempts: collected.attempts,
    exhaustedBudget: collected.exhaustedBudget,
  };
}

function describeAttempt(attempt) {
  if (!attempt || attempt.ok) return '';
  const host = attempt.host || 'host';
  const status = attempt.status ? ` ${attempt.status}` : '';
  const timeout = attempt.timedOut ? ' (timeout)' : '';
  return `${host}:${status} ${attempt.error}${timeout}`.trim();
}

/**
 * The entry point the panel calls.
 *
 * Tries Radio Browser first, falls back to the deterministic mock repository on
 * any failure, and never throws — a broken network must not blank the scene.
 * The returned object always carries `fallback: null` (real data) or
 * `fallback: { reason, detail, attempts }` (mock data standing in).
 */
export async function createRadioRepository(options) {
  const source = options || {};
  const mockOptions = {
    count: source.mockCount !== undefined ? source.mockCount : source.count,
    seed: source.seed,
    featuredCount: source.featuredCount,
  };
  const mode = String(source.mode || 'auto').toLowerCase();
  const budgetMs = clampNumber(source.budgetMs, RADIO_BROWSER_DEFAULTS.budgetMs, 500, 120000);

  if (mode === 'mock') {
    const repository = createMockRadioRepository(mockOptions);
    return { repository, fallback: null, attempts: [], network: false, rows: [] };
  }

  let result;
  try {
    result = await Promise.race([
      fetchRadioBrowserCatalog({
        ...source,
        seed: source.seed,
        featuredCount: source.featuredCount,
        budgetMs,
      }),
      new Promise((resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              ok: false,
              reason: 'timeout',
              detail: `no complete answer within ${budgetMs} ms`,
              attempts: [{ host: null, ok: false, timedOut: true, error: `budget of ${budgetMs} ms exhausted` }],
            }),
          budgetMs + 500,
        );
        // Do not hold the process open for a race that was already won. The
        // browser has no `unref` on timer ids, so the call is guarded: there
        // the page owns the event loop anyway.
        if (typeof timer?.unref === 'function') timer.unref();
      }),
    ]);
  } catch (error) {
    result = { ok: false, reason: 'error', detail: error && error.message ? error.message : String(error), attempts: [] };
  }

  if (result && result.ok && result.repository && result.repository.list().length > 0) {
    return {
      repository: result.repository,
      fallback: null,
      attempts: result.attempts || [],
      network: true,
      // The raw rows are returned so the caller can cache them verbatim; the
      // mapped stations are a lossy view and a cache must be able to re-map.
      rows: Array.isArray(result.rows) ? result.rows : [],
    };
  }

  const repository = createMockRadioRepository(mockOptions);
  return {
    repository,
    fallback: {
      reason: (result && result.reason) || 'unknown',
      detail: (result && result.detail) || '',
      attempts: (result && result.attempts) || [],
    },
    attempts: (result && result.attempts) || [],
    network: true,
    rows: [],
  };
}

/** Re-exported so callers can describe a station without importing two modules. */
export { streamUrlFor };
