/**
 * Now-playing reader — the one place a live stream is asked what it is playing.
 *
 * ## Why this is host-side
 *
 * Internet radio announces the current track inside the audio stream itself:
 * the response carries `icy-metaint: N`, and every N bytes of audio are followed
 * by a length-prefixed block of `StreamTitle='Artist - Title';`. There is no
 * second request to make — the answer only exists in the bytes of the stream.
 *
 * A browser tab cannot read those bytes. The stream is cross-origin, sends no
 * CORS headers, and never ends, so `fetch` would be blocked before the first
 * metadata block and a full read would never settle. The Host can make the same
 * request with `Icy-MetaData: 1`, read exactly enough bytes for one block, and
 * hang up. That is the whole job of this module, and it is why it lives beside
 * `index.js` rather than in the browser chunk.
 *
 * ## What it deliberately does not do
 *
 * It does not decide whether a title is a *song*. A music stream publishes
 * `Marion Meadows - My Cherie Amour`; a news stream publishes its own programme
 * name (`BBC World Service Online`). Both are honest `StreamTitle` values, and
 * the difference is the station's genre, which the browser already knows. This
 * module answers "what does the stream say", never "is that a song".
 */

/** Give up on a stream that has not produced a metadata block by then. */
export const NOW_PLAYING_TIMEOUT_MS = 6000;

/** One URL is not re-read more often than this, however many cards ask. */
export const NOW_PLAYING_TTL_MS = 15000;

/** Hard cap on a single read: the audio before one metadata block is bounded. */
const MAX_READ_BYTES = 96 * 1024;

/** The metadata block itself is length-prefixed in 16-byte units. */
const MAX_METADATA_BYTES = 4080;

const MAX_URL_LENGTH = 2048;
const MAX_CACHE_ENTRIES = 64;

/** How many stream reads may be open at once across the whole Host. */
const MAX_PENDING_READS = 6;

const USER_AGENT = 'blackhole-radio-lab/0.4 (+now-playing)';

/**
 * Hosts a public stream may not live on. Every station URL comes from the
 * Radio Browser catalogue, which never points at the local machine, so a
 * loopback or private address here is either a mistake or an attempt to make
 * the Host fetch something it should not.
 */
const PRIVATE_HOST =
  /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?)$/i;

/** One IPv4 address in the ranges that never belong to a public stream. */
function isPrivateIPv4(octets) {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Is this hostname the local machine, a private network, or a spelling of one?
 *
 * The plain regex above only sees dotted quads, so a decimal (`2130706433`),
 * hex (`0x7f000001`), octal (`0177.0.0.1`) or IPv6 literal would walk straight
 * past it. Resolving the name here would add a second network call the caller
 * cannot audit, so the shapes are recognised syntactically instead.
 */
export function isPrivateHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return true;
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOST.test(host)) return true;
  // IPv6 literals: loopback, unique-local (fc00::/7), link-local (fe80::/10),
  // and v4-mapped forms of the ranges below.
  const v6 = /^([0-9a-f]{0,4}:){1,7}[0-9a-f]{0,4}$/.test(host) || host.includes('::ffff:');
  if (v6) {
    const bare = host.replace(/^::ffff:/, '');
    if (host === '::' || /^fe[89ab]/.test(bare) || /^f[cd]/.test(bare)) return true;
    if (bare.includes('.')) {
      const parts = bare.split('.').map((part) => Number(part));
      return parts.length === 4 && parts.every((part) => Number.isInteger(part)) ? isPrivateIPv4(parts) : true;
    }
    return true;
  }
  // A lone number is a whole address in one field: `2130706433` is 127.0.0.1.
  if (/^(?:0x[0-9a-f]+|0[0-7]*|[0-9]+)$/.test(host)) {
    const value = numberPart(host);
    if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return true;
    return isPrivateIPv4([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
  }
  // Dotted forms, where a part may itself be decimal, hex or octal. Anything
  // that is not four such parts is a name, not an address.
  const NUMBER_PART = /^(?:0x[0-9a-f]+|0[0-7]*|[0-9]+)$/;
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => NUMBER_PART.test(part))) return false;
  return isPrivateIPv4(parts.map(numberPart));
}

/** One dotted part as a byte: `0x7f`, `0177` and `127` all mean 127. */
function numberPart(part) {
  if (part.startsWith('0x')) return Number.parseInt(part.slice(2), 16);
  if (part.length > 1 && part.startsWith('0')) return Number.parseInt(part, 8);
  return Number.parseInt(part, 10);
}

/**
 * Validate the `url` query parameter.
 *
 * @param value the raw query value
 * @returns `{ url }` (a normalised href) or `{ error }`
 */
export function parseStreamUrl(value) {
  if (typeof value !== 'string') return { error: 'missing url' };
  const text = value.trim();
  if (!text || text.length > MAX_URL_LENGTH) return { error: 'bad url' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'bad url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'unsupported scheme' };
  if (url.username || url.password) return { error: 'credentials not allowed' };
  if (!url.hostname || isPrivateHost(url.hostname)) return { error: 'host not allowed' };
  return { url: url.href };
}

/**
 * Decode an ICY metadata block.
 *
 * The spec says ISO-8859-1; in practice most servers send UTF-8 and a handful
 * still send Latin-1. UTF-8 with `fatal` is the honest test: if the bytes are
 * valid UTF-8 they are almost certainly UTF-8, otherwise fall back rather than
 * render replacement characters in a song title.
 */
function decodeMetadata(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/**
 * Pull `StreamTitle='…'` out of a metadata block.
 * @returns the title, or `''` when the block carries none.
 */
export function extractStreamTitle(bytes) {
  const text = decodeMetadata(bytes);
  const match = /StreamTitle\s*=\s*'([^']*)'/.exec(text);
  return match ? match[1].trim() : '';
}

function cancelledBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') return response.body.cancel();
  } catch {
    /* the body may already be unusable */
  }
  return undefined;
}

/**
 * Read one metadata block from a live stream.
 *
 * The request is aborted the moment the block is in hand: an icecast stream is
 * endless, so waiting for the response to finish would hang until the timeout.
 *
 * @returns `{ title, metaint, reason }` — `title` is empty whenever the stream
 *          does not publish one, which is a normal answer, not an error.
 */
export async function readNowPlaying(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : NOW_PLAYING_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader = null;

  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        // Some icecast servers only send metadata when this header is present,
        // and a few are case-sensitive about it.
        'Icy-MetaData': '1',
        'user-agent': USER_AGENT,
        accept: 'audio/*,application/ogg,*/*',
      },
      signal: controller.signal,
    });
    if (!response) return { title: '', metaint: 0, reason: 'no-response' };
    // A redirect is followed, because plenty of streams move to their CDN, but
    // where it landed is checked again: a public URL may not bounce the Host
    // into its own network.
    if (response.url && response.url !== url) {
      let host = '';
      try {
        host = new URL(response.url).hostname;
      } catch {
        host = '';
      }
      if (!host || isPrivateHost(host)) {
        await cancelledBody(response);
        return { title: '', metaint: 0, reason: 'redirect-blocked' };
      }
    }
    if (!response.ok) {
      await cancelledBody(response);
      return { title: '', metaint: 0, reason: `status ${response.status}` };
    }

    const metaint = Number(response.headers.get('icy-metaint'));
    if (!Number.isFinite(metaint) || metaint <= 0) {
      await cancelledBody(response);
      return { title: '', metaint: 0, reason: 'no-metadata' };
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      await cancelledBody(response);
      return { title: '', metaint, reason: 'no-body' };
    }

    reader = response.body.getReader();
    // One metadata block plus its 1-byte length prefix, after `metaint` audio
    // bytes. A server that sends a shorter metaint still fits well inside the
    // hard cap; the cap only matters when metaint itself is absurd.
    const target = Math.min(metaint + 1 + MAX_METADATA_BYTES, MAX_READ_BYTES);
    const chunks = [];
    let total = 0;
    while (total < target) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }

    if (total <= metaint) return { title: '', metaint, reason: 'short-read' };
    const buffer = Buffer.concat(chunks, total);
    const length = buffer[metaint] * 16;
    if (length === 0) return { title: '', metaint, reason: 'empty' };
    const end = metaint + 1 + length;
    if (buffer.length < end) return { title: '', metaint, reason: 'partial' };
    return { title: extractStreamTitle(buffer.subarray(metaint + 1, end)), metaint, reason: 'ok' };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      title: '',
      metaint: 0,
      reason: aborted ? 'timeout' : `error: ${String((error && error.message) || error)}`,
    };
  } finally {
    clearTimeout(timer);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* the stream may already be gone */
      }
    }
  }
}

/**
 * A small cache in front of {@link readNowPlaying}.
 *
 * Cards poll, the same station is asked for by whichever surface is visible,
 * and a 15-second title is still the current title. Coalescing by URL keeps a
 * single hung request from being multiplied by every subscriber.
 *
 * @param options.fetchImpl - injectable fetch, for tests
 * @param options.ttlMs - how long a result stays fresh
 * @param options.maxEntries - LRU bound
 */
export function createNowPlayingResolver(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : NOW_PLAYING_TTL_MS;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : MAX_CACHE_ENTRIES;
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const cache = new Map();
  const pending = new Map();

  function remember(url, value) {
    cache.delete(url);
    cache.set(url, { at: clock(), value });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  return {
    /** Number of URLs currently cached — diagnostics and tests only. */
    size() {
      return cache.size;
    },

    /**
     * @param url a validated, absolute stream URL
     * @returns `{ title, metaint, reason, cached }`
     */
    async resolve(url) {
      const hit = cache.get(url);
      if (hit && clock() - hit.at < ttlMs) return { ...hit.value, cached: true };
      const inFlight = pending.get(url);
      if (inFlight) return inFlight;
      // Streams that never answer are held until the read timeout, so the number
      // of them at once is bounded: the Host is not a proxy for an open-ended
      // fan-out, and a caller that is over the bound is told to come back.
      if (pending.size >= MAX_PENDING_READS) return { title: '', metaint: 0, reason: 'busy', cached: false };

      const task = readNowPlaying(url, { fetchImpl })
        .then((value) => {
          remember(url, value);
          return { ...value, cached: false };
        })
        .catch((error) => ({
          title: '',
          metaint: 0,
          reason: `error: ${String((error && error.message) || error)}`,
          cached: false,
        }))
        .finally(() => pending.delete(url));

      pending.set(url, task);
      return task;
    },
  };
}
