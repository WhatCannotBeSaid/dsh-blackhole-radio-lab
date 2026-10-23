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
 *
 * Nothing here renders, streams audio, or proxies Radio Browser — those belong
 * to phase 2 and would put an unverified network surface in the boot path.
 */

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
