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
 * Nothing here renders, streams audio, or proxies Radio Browser — the
 * now-playing route opens a stream just long enough to take one metadata block
 * and hangs up.
 */

import { createNowPlayingResolver, parseStreamUrl } from './src/host/now-playing.js';

/** Plugin identity for cordis.yml rows and diagnostics. */
export const name = 'blackhole-radio-lab';

/** The web server is required for the config route; the profile always has it. */
export const inject = ['webServer'];

/** Route prefix owned by this plugin. Nothing else may claim it. */
const PREFIX = '/blackhole-radio-lab';

/**
 * Defaults applied before the profile patch layer is consulted.
 * Kept in one object so the route and the schema cannot drift apart.
 */
const DEFAULTS = Object.freeze({
  antialias: true,
  pixelRatioCap: 2,
  reducedMotion: false,
  showHints: true,
  stationCount: 2400,
  seed: 20261022,
  featuredCount: 18,
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
      boolean('showHints');

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
