/**
 * Black Hole Radio — Host half.
 *
 * Phase 1 keeps the server side deliberately thin: the page itself is a React
 * component in the browser half (client.js). The Host half exists for two
 * reasons, and both are load-bearing boundaries rather than ceremony:
 *
 *   1. It is the loader entry. A package only becomes a profile layer when its
 *      manifest declares `dsh.bundle.patch`, and the browser half is discovered
 *      from this entry's `dsh.client` declaration.
 *   2. It owns the authoritative configuration. The client half cannot read the
 *      loader entry's `config`, so the stage knobs are read here (validated by
 *      `Config` below) and published on one small route the page fetches once.
 *   3. It reads now-playing metadata out of a live stream, because a browser
 *      cannot: the stream is cross-origin, sends no CORS headers and never
 *      ends. `src/host/now-playing.js` owns that read; this file only routes it.
 *
 * Nothing here renders or streams audio: the now-playing route opens a stream
 * just long enough to take one metadata block and hangs up. The catalogue route
 * serves a local file, and the weekly refresh rebuilds that file from Radio
 * Browser in the background — it never proxies the API for a page request.
 */

import { createNowPlayingResolver, parseStreamUrl } from './src/host/now-playing.js';
import { CACHE_GZ, scheduleCatalogRefresh } from './src/host/catalog-refresh.js';
import { LIBRARY_MAX_BYTES, libraryFilePath, readLibrary, writeLibrary } from './src/host/library.js';
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Plugin identity for cordis.yml rows and diagnostics. */
export const name = 'blackhole-radio-lab';

/** The web server is required for the config route; the profile always has it. */
export const inject = ['webServer'];

/** Route prefix owned by this plugin. Nothing else may claim it. */
const PREFIX = '/blackhole-radio-lab';

/**
 * Station snapshots.
 *
 * The Host rebuilds the catalogue once a week into `~/.dsh/cache` so users do
 * not have to wait for a release; the packaged file is the fallback that makes
 * a fresh install work offline. Only the cache's gzip twin is written, which
 * keeps the swap to one atomic rename.
 */
const CATALOG_PATH = fileURLToPath(new URL('./data/catalog.v1.json', import.meta.url));
/** The gzip twin written by the same build, so the route never recompresses. */
const CATALOG_GZ_PATH = fileURLToPath(new URL('./data/catalog.v1.json.gz', import.meta.url));

/** Snapshots older than this are ignored in favour of the other source. */
const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Parsed snapshot cache, keyed by source paths and both files' mtime + size. */
const snapshotCache = new Map();

/**
 * Read one snapshot pair, re-gzipping only when a file changed.
 *
 * Both files take part in the cache key: a build that wrote the JSON but was
 * interrupted before the gzip twin (or a hand-edited JSON) must not keep
 * serving the previous gzip under a fresh etag. When only the gzip exists, the
 * JSON is inflated once and cached alongside it.
 *
 * @param jsonPath - plain JSON path, or '' when the source only has the gzip
 * @param gzPath - gzip path, or '' when the source only has the JSON
 * @returns {{json: string, gz: Buffer, builtAt: string}|null}
 */
function readSnapshotPair(jsonPath, gzPath) {
  let jsonStat = null;
  let gzStat = null;
  try {
    if (jsonPath) jsonStat = statSync(jsonPath);
  } catch {
    jsonStat = null;
  }
  try {
    if (gzPath) gzStat = statSync(gzPath);
  } catch {
    gzStat = null;
  }
  if (!jsonStat && !gzStat) return null;
  const key =
    `${jsonPath}|${gzPath}|` +
    `${jsonStat ? `${jsonStat.mtimeMs}:${jsonStat.size}` : '-'}|` +
    `${gzStat ? `${gzStat.mtimeMs}:${gzStat.size}` : '-'}`;
  const cached = snapshotCache.get(key);
  if (cached) return cached;
  try {
    let json = jsonStat ? readFileSync(jsonPath, 'utf8') : '';
    let gz = gzStat ? readFileSync(gzPath) : null;
    if (!json && gz) json = gunzipSync(gz).toString('utf8');
    if (!gz) gz = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const parsed = JSON.parse(json);
    // Old health-filtered snapshots must not override the repaired directory.
    if (parsed?.selectionPolicy !== 'no-health-filter') return null;
    const entry = {
      json,
      gz,
      builtAt: String((parsed && parsed.builtAt) || ''),
      stationCount: Array.isArray(parsed && parsed.stations) ? parsed.stations.length : 0,
    };
    // A rebuild changes the key, so the previous entry is dead weight. Keep a
    // few entries anyway: one request reads both sources (packaged + cache), and
    // a single-slot cache would evict one on every request and re-inflate two
    // multi-megabyte snapshots each time.
    snapshotCache.set(key, entry);
    while (snapshotCache.size > 8) {
      const oldest = snapshotCache.keys().next();
      if (oldest.done) break;
      snapshotCache.delete(oldest.value);
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Pick the freshest usable snapshot.
 *
 * The user cache wins when it exists and its `builtAt` is under 30 days old; an
 * ancient cache (a machine that has not run for months) is skipped rather than
 * served as if it were current, and the packaged snapshot answers instead. If
 * every source is stale, the newest one still answers — an old catalogue beats
 * an empty page.
 *
 * @returns {{json: string, gz: Buffer, builtAt: string}|null}
 */
function readCatalog() {
  const bundled = readSnapshotPair(CATALOG_PATH, CATALOG_GZ_PATH);
  const cached = readSnapshotPair('', CACHE_GZ);
  const fresh = (snapshot) => {
    if (!snapshot) return false;
    const builtAt = Date.parse(snapshot.builtAt);
    return Number.isFinite(builtAt) && Date.now() - builtAt <= SNAPSHOT_MAX_AGE_MS;
  };

  if (cached && fresh(cached)) {
    // A refresh on a bad network can produce far fewer healthy stations than
    // the packaged snapshot. A thin cache must not replace a fuller bundled
    // catalogue: the next weekly run gets another chance, and in the meantime
    // the page keeps the larger list.
    if (bundled && cached.stationCount < bundled.stationCount * 0.5) return bundled;
    return cached;
  }
  if (bundled && fresh(bundled)) return bundled;
  // Every source is stale: an old catalogue still beats an empty page.
  return cached || bundled;
}

/**
 * Defaults applied before the profile patch layer is consulted.
 * Kept in one object so the route and the schema cannot drift apart.
 */
const DEFAULTS = Object.freeze({
  antialias: true,
  pixelRatioCap: 2,
  reducedMotion: false,
  // The hold-to-fly wormhole between the hole and the nebula. On by default;
  // `false` restores the instant handover that predates it.
  wormhole: true,
  showHints: true,
  stationCount: 2400,
  seed: 20261022,
  featuredCount: 18,
  // Weekly self-refresh of the station catalogue into ~/.dsh/cache. The target
  // matches the packaged snapshot: a refresh must not hand the user a smaller
  // catalogue than the one they already have.
  catalogAutoRefresh: true,
  catalogRefreshDays: 7,
  catalogTarget: 30000,
  catalogFetch: 50000,
  catalogConcurrency: 48,
  catalogTimeoutMs: 2800,
});

/**
 * Configuration schema.
 *
 * Cordis validates a plugin's config through `Config['~standard'].validate`
 * (see `resolveConfig` in @deepseek-ai/cordis), so a plain standard-schema
 * object is enough. Deliberately no schemastery import: this package must stay
 * dependency-free so it can be linked into a profile without a build step.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'blackhole-radio-lab',
    validate(value) {
      const issues = [];
      if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        return { issues: [{ message: 'config must be an object', path: [] }] };
      }
      const input = value ?? {};
      const out = { ...DEFAULTS };

      const boolean = (key) => {
        if (input[key] === undefined) return;
        if (typeof input[key] !== 'boolean') {
          issues.push({ message: 'must be a boolean', path: [key] });
          return;
        }
        out[key] = input[key];
      };
      boolean('antialias');
      boolean('reducedMotion');
      boolean('wormhole');
      boolean('showHints');
      boolean('catalogAutoRefresh');

      if (input.pixelRatioCap !== undefined) {
        const cap = input.pixelRatioCap;
        if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > 4) {
          issues.push({ message: 'must be a number between 1 and 4', path: ['pixelRatioCap'] });
        } else {
          out.pixelRatioCap = cap;
        }
      }

      const integer = (key, min, max) => {
        if (input[key] === undefined) return;
        const n = input[key];
        if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
          issues.push({ message: `must be an integer between ${min} and ${max}`, path: [key] });
          return;
        }
        out[key] = n;
      };
      integer('stationCount', 200, 20000);
      integer('seed', 0, 4294967295);
      integer('featuredCount', 4, 40);
      integer('catalogRefreshDays', 1, 90);
      integer('catalogTarget', 1000, 60000);
      integer('catalogFetch', 1000, 60000);
      integer('catalogConcurrency', 1, 64);
      integer('catalogTimeoutMs', 500, 15000);

      // The builder silently raises `fetch` to `target`; rejecting the pair here
      // keeps the configured value equal to the work actually done.
      if (out.catalogFetch < out.catalogTarget) {
        issues.push({
          message: 'catalogFetch must be at least catalogTarget',
          path: ['catalogFetch'],
        });
      }

      return issues.length > 0 ? { issues } : { value: out };
    },
  },
};

/**
 * Write one JSON answer, tolerating a client that hung up first.
 * @param res - the server response
 * @param status - HTTP status
 * @param payload - JSON-serialisable body
 * @param head - true when the body must not be written (HEAD)
 */
function sendJson(res, status, payload, head) {
  const body = JSON.stringify(payload);
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(head ? undefined : body);
  } catch {
    /* the browser cancelled the poll while the read was still running */
  }
}

/**
 * Answer one now-playing poll.
 *
 * The route is a read of somebody else's stream, so every way it can fail is a
 * normal answer: a station without metadata, an unreachable host and a timeout
 * all come back as an empty title, which the card renders as station info. The
 * only 4xx is a URL this host refuses to fetch at all.
 *
 * @param resolver - the cached reader from {@link createNowPlayingResolver}
 * @param req - inbound request
 * @param res - outbound response
 */
async function answerNowPlaying(resolver, req, res) {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
    } catch {
      /* client already gone */
    }
    return;
  }

  // A poll makes the Host fetch a stream of somebody else's choosing, so only a
  // deliberate same-origin request may ask for one. Without this, any page in
  // the browser can point an <img> at this route and use the Host as a proxy —
  // and hold its six read slots while doing it.
  const fetchSite = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendJson(res, 403, { error: 'cross-site', title: '' }, method === 'HEAD');
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(String(req.url ?? ''), 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { error: 'bad request', title: '' }, method === 'HEAD');
    return;
  }

  const parsed = parseStreamUrl(requestUrl.searchParams.get('url'));
  if (parsed.error) {
    sendJson(res, 400, { error: parsed.error, title: '' }, method === 'HEAD');
    return;
  }

  const result = await resolver.resolve(parsed.url);
  sendJson(
    res,
    200,
    {
      title: result.title || '',
      metaint: result.metaint || 0,
      reason: result.reason || '',
      cached: Boolean(result.cached),
    },
    method === 'HEAD',
  );
}

/**
 * Mount the Host half.
 * @param ctx - Host cordis context.
 * @param config - Already validated against {@link Config}.
 */
export function apply(ctx, config) {
  const stage = { ...DEFAULTS, ...(config ?? {}) };
  const webServer = ctx.get('webServer');
  // A non-web profile (tui/headless) has no server: the client half simply
  // never runs there, and the loader entry still counts as activated.
  if (!webServer) return;

  const disposers = [];
  const dispose = webServer.register({
    kind: 'exact',
    path: `${PREFIX}/config`,
    handler: (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const body = JSON.stringify({ ...stage, phase: 5 });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(method === 'HEAD' ? undefined : body);
    },
  });
  if (typeof dispose === 'function') disposers.push(dispose);

  // Now playing: one exact route, one cached reader. The card polls this while
  // a music station plays; every other surface keeps showing station info.
  const nowPlaying = createNowPlayingResolver();
  const releaseNowPlaying = webServer.register({
    kind: 'exact',
    path: `${PREFIX}/now-playing`,
    handler: (req, res) => {
      // The handler itself never throws at the server: a failure inside the read
      // is already part of the JSON answer.
      answerNowPlaying(nowPlaying, req, res).catch(() => {
        sendJson(res, 502, { title: '', error: 'unavailable' }, false);
      });
    },
  });
  if (typeof releaseNowPlaying === 'function') disposers.push(releaseNowPlaying);

  // Catalogue snapshot: one exact route over a local file. It is served with a
  // short public cache because the file only changes on a rebuild, and gzipped
  // when the client accepts it — the raw JSON is a few megabytes.
  const releaseCatalog = webServer.register({
    kind: 'exact',
    path: `${PREFIX}/catalog`,
    handler: (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const catalog = readCatalog();
      if (!catalog) {
        sendJson(res, 404, { error: 'catalog-unavailable' }, method === 'HEAD');
        return;
      }
      const etag = `"${catalog.builtAt}"`;
      if (String(req.headers['if-none-match'] || '') === etag) {
        res.writeHead(304, { etag, 'cache-control': 'public, max-age=3600', vary: 'accept-encoding' });
        res.end();
        return;
      }
      const accept = String(req.headers['accept-encoding'] || '');
      const gzip = accept.split(',').some((part) => {
        const [name, ...params] = part.trim().split(';');
        if (name.trim().toLowerCase() !== 'gzip') return false;
        const q = params.find((param) => /^\s*q\s*=/i.test(param));
        if (!q) return true;
        return Number(q.split('=')[1]) > 0;
      });
      const body = gzip ? catalog.gz : Buffer.from(catalog.json, 'utf8');
      try {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'public, max-age=3600',
          etag,
          vary: 'accept-encoding',
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        });
        res.end(method === 'HEAD' ? undefined : body);
      } catch {
        /* the browser cancelled the request while the read was running */
      }
    },
  });
  if (typeof releaseCatalog === 'function') disposers.push(releaseCatalog);

  // The library: favourite stations and liked songs, one small file on this
  // machine. GET hands the record back so a fresh page can restore it; POST
  // replaces it after the user marks or unmarks something. Both directions are
  // bounded — the route is reachable from anything on the local origin, so the
  // body is capped before it is parsed and reshaped before it is written.
  const libraryFile = libraryFilePath();
  const releaseLibrary = webServer.register({
    kind: 'exact',
    path: `${PREFIX}/library`,
    handler: (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, readLibrary(libraryFile) || { version: 2 }, method === 'HEAD');
        return;
      }
      if (method !== 'POST') {
        try {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD, POST' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
        } catch {
          /* the client hung up; there is nobody left to answer */
        }
        return;
      }
      // A write has to be a deliberate JSON request. A cross-site form can only
      // send text/plain, urlencoded or multipart without a preflight, so asking
      // for the JSON type is what keeps a random page from replacing the
      // library. `sec-fetch-site` is the same check from the other side.
      const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        sendJson(res, 415, { error: 'unsupported-media-type' });
        return;
      }
      const fetchSite = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        sendJson(res, 403, { error: 'cross-site' });
        return;
      }
      const chunks = [];
      let size = 0;
      let overflow = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        // Over the cap the body is dropped, not buffered: an oversized writer
        // must not be able to make the process hold it in memory.
        if (size > LIBRARY_MAX_BYTES) {
          overflow = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => sendJson(res, 400, { error: 'read-failed' }));
      req.on('end', () => {
        if (overflow) {
          sendJson(res, 413, { error: 'too-large' });
          return;
        }
        let record = null;
        try {
          record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* a body that is not JSON is refused below, like any other bad record */
        }
        if (!writeLibrary(libraryFile, record)) {
          sendJson(res, 400, { error: 'bad-library' });
          return;
        }
        sendJson(res, 200, { ok: true });
      });
    },
  });
  if (typeof releaseLibrary === 'function') disposers.push(releaseLibrary);

  // Weekly self-refresh: the packaged snapshot goes stale as stations come and
  // go, and users should not have to wait for a release. The first check runs
  // two minutes after start so the page and playback get the machine first; the
  // schedule then re-checks every six hours and only builds when the cache is
  // older than `catalogRefreshDays`.
  if (stage.catalogAutoRefresh) {
    const refresher = scheduleCatalogRefresh({
      intervalDays: stage.catalogRefreshDays,
      target: stage.catalogTarget,
      fetch: stage.catalogFetch,
      concurrency: stage.catalogConcurrency,
      timeoutMs: stage.catalogTimeoutMs,
      logger: (level, message) => {
        if (level === 'warn') console.warn(`[blackhole-radio-lab] ${message}`);
        else console.info(`[blackhole-radio-lab] ${message}`);
      },
    });
    ctx.effect(() => () => refresher.stop(), 'blackhole-radio-lab: catalog refresh');
  }

  // Everything this half acquired is released with the plugin fiber, so
  // disabling or uninstalling the bundle leaves no route and no handler behind.
  ctx.effect(() => () => {
    for (const release of disposers.splice(0)) {
      try {
        release();
      } catch {
        /* already released by the server's own teardown */
      }
    }
  }, 'blackhole-radio-lab: host teardown');
}
