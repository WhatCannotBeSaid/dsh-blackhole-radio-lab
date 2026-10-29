/**
 * Weekly catalogue refresh on the user's own machine.
 *
 * The snapshot shipped in the package is only as fresh as the author's last
 * `npm run build:catalog`. Users should not have to wait for a release to get
 * working stations, so the Host half rebuilds the same snapshot in the
 * background and writes it under `~/.dsh/cache/blackhole-radio-lab/`. The
 * `/catalog` route prefers that file and falls back to the packaged one.
 *
 * Only the gzip twin is written: it is the smaller file, the route already
 * serves it to every modern browser, and a single `rename` keeps the swap
 * atomic. The packaged snapshot still ships both twins because the CLI build is
 * also used by CI, where a human may want to diff the plain JSON.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog } from './catalog-builder.js';

/** Where the Host keeps its own snapshot. */
export const CACHE_DIR = join(homedir(), '.dsh', 'cache', 'blackhole-radio-lab');
export const CACHE_GZ = join(CACHE_DIR, 'catalog.v1.json.gz');

/** How long to wait after start before touching the network. */
const DEFAULT_START_DELAY_MS = 2 * 60 * 1000;
/** How often a running Host re-checks whether the snapshot went stale. */
const DEFAULT_RECHECK_MS = 6 * 60 * 60 * 1000;
/** Hard ceiling for one background build; a stalled network must not run for hours. */
const DEFAULT_DEADLINE_MS = 120 * 60 * 1000;

/**
 * True when a cached snapshot can actually be served.
 *
 * A truncated or corrupt file (power loss mid-write, a half-copied backup) has a
 * fresh mtime but no usable stations. Treating it as stale lets the next tick
 * rebuild instead of falling back to the packaged snapshot for a whole week.
 */
function isCacheReadable(file) {
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    return Array.isArray(parsed.stations) && parsed.stations.length > 0;
  } catch {
    return false;
  }
}

/**
 * True when there is no cached snapshot, its file is older than
 * `intervalDays`, or the file no longer parses. The file mtime is the write
 * time, which is what the schedule cares about; `builtAt` inside the JSON is for
 * the route's etag.
 *
 * @param intervalDays - refresh period in days
 * @param now - injectable clock for tests
 * @param file - cache file to inspect, defaults to {@link CACHE_GZ}
 */
export function isCacheStale(intervalDays, now = Date.now(), file = CACHE_GZ) {
  let stat = null;
  try {
    stat = statSync(file);
  } catch {
    return true;
  }
  const age = now - stat.mtimeMs;
  if (age > Math.max(1, intervalDays) * 24 * 60 * 60 * 1000) return true;
  // Only pay for the inflate when the file looks fresh; an old file is already
  // stale for the cheap reason.
  return !isCacheReadable(file);
}

/** Remove temporary files left behind by a build that died mid-write. */
function clearStaleTmp(dir, keep) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.includes('.tmp-') || name === keep) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* another process may still own it */
    }
  }
}

/**
 * Rebuild the catalogue and replace the cache file atomically.
 *
 * @param options - forwarded to {@link buildCatalog}; `cacheDir` overrides the
 *   destination for tests
 * @returns {Promise<{builtAt: string, stations: number, bytes: number, stats: object}>}
 */
export async function refreshCatalogCache(options = {}) {
  const dir = options.cacheDir || CACHE_DIR;
  const file = join(dir, 'catalog.v1.json.gz');
  const { snapshot, stats } = await buildCatalog(options);
  const json = JSON.stringify(snapshot);
  const gz = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  clearStaleTmp(dir, `${file}.tmp-${process.pid}`);
  writeFileSync(tmp, gz);
  renameSync(tmp, file);
  return { builtAt: snapshot.builtAt, stations: snapshot.stations.length, bytes: gz.length, stats };
}

/**
 * Start the background schedule.
 *
 * The first check runs after `startDelayMs` so the page, the config route and
 * playback get the machine first. After that the Host re-checks every
 * `recheckMs`; a refresh only starts when the cache is older than
 * `intervalDays`, so a laptop that sleeps for a week still refreshes on the next
 * tick rather than on a strict calendar.
 *
 * @param options - `intervalDays`, `startDelayMs`, `recheckMs`, `logger`, plus
 *   the {@link buildCatalog} knobs (`target`, `fetch`, `concurrency`, `timeoutMs`)
 * @returns {{stop: () => void}}
 */
export function scheduleCatalogRefresh(options = {}) {
  const intervalDays = Number.isFinite(Number(options.intervalDays))
    ? Math.max(1, Math.floor(Number(options.intervalDays)))
    : 7;
  const startDelayMs = Number.isFinite(Number(options.startDelayMs))
    ? Math.max(0, Math.floor(Number(options.startDelayMs)))
    : DEFAULT_START_DELAY_MS;
  const recheckMs = Number.isFinite(Number(options.recheckMs))
    ? Math.max(60 * 1000, Math.floor(Number(options.recheckMs)))
    : DEFAULT_RECHECK_MS;
  const deadlineMs = Number.isFinite(Number(options.deadlineMs))
    ? Math.max(60 * 1000, Math.floor(Number(options.deadlineMs)))
    : DEFAULT_DEADLINE_MS;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const cacheFile = () => join(options.cacheDir || CACHE_DIR, 'catalog.v1.json.gz');

  let timer = null;
  let deadlineTimer = null;
  let controller = null;
  let inFlight = false;
  let stopped = false;

  const scheduleNext = (ms) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const tick = async () => {
    timer = null;
    if (stopped) return;
    if (inFlight) {
      scheduleNext(recheckMs);
      return;
    }
    if (!isCacheStale(intervalDays, Date.now(), cacheFile())) {
      scheduleNext(recheckMs);
      return;
    }
    inFlight = true;
    controller = new AbortController();
    deadlineTimer = setTimeout(
      () => controller?.abort(new Error('refresh deadline exceeded')),
      deadlineMs,
    );
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    const startedAt = Date.now();
    logger('info', `catalog refresh started (cache older than ${intervalDays}d)`);
    try {
      const result = await refreshCatalogCache({
        cacheDir: options.cacheDir,
        target: options.target,
        fetch: options.fetch,
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        countryFloor: options.countryFloor,
        genreFloor: options.genreFloor,
        fetchImpl: options.fetchImpl,
        signal: controller.signal,
        onProgress: options.onProgress,
      });
      if (!stopped) {
        logger(
          'info',
          `catalog refresh wrote ${result.stations} stations in ` +
            `${Date.now() - startedAt} ms (${result.bytes} B gzip, builtAt ${result.builtAt})`,
        );
      }
    } catch (error) {
      if (!stopped) {
        logger(
          'warn',
          `catalog refresh failed: ${error && error.message ? error.message : error}`,
        );
      }
    } finally {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      inFlight = false;
      controller = null;
      scheduleNext(recheckMs);
    }
  };

  scheduleNext(startDelayMs);
  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      if (controller) controller.abort(new Error('stopped'));
    },
  };
}
