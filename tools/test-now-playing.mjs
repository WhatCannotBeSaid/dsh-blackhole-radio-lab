/**
 * Guards for the now-playing host route.
 *
 * The interesting cases are all about names: `isPrivateHost` reads a spelling,
 * so a public name that resolves to loopback only fails once the address is
 * looked up, and a redirect must be checked before its hop is requested.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, parseStreamUrl, readNowPlaying } from '../src/host/now-playing.js';
import { apply } from '../index.js';

const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];
const loopbackLookup = async () => [{ address: '127.0.0.1', family: 4 }];
const v6Lookup = async () => [{ address: '2001:db8::1', family: 6 }];

/** One audio byte, then the metadata block holding `title` (16 bytes each). */
function icyBody(title) {
  const meta = `StreamTitle='${title}';`;
  const blocks = Math.ceil(meta.length / 16);
  const padded = meta.padEnd(blocks * 16, '\u0000');
  const body = Buffer.alloc(1 + 1 + padded.length);
  body[0] = 0;
  body[1] = blocks;
  body.write(padded, 2, 'latin1');
  return body;
}

function icyResponse(title) {
  return new Response(icyBody(title), { status: 200, headers: { 'icy-metaint': '1' } });
}

test('literal private hosts are refused', () => {
  for (const host of ['127.0.0.1', 'localhost', '10.0.0.5', '169.254.169.254', '0x7f000001', '[::1]']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  // A trailing dot is the same name to the resolver.
  assert.equal(isPrivateHost('localhost.'), true);
  assert.equal(isPrivateHost('example.com'), false);
});

test('an IPv4-mapped IPv6 answer is refused in every spelling', async () => {
  for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a00:1']) {
    let calls = 0;
    const result = await readNowPlaying('http://radio.example.com/live', {
      lookupImpl: async () => [{ address, family: 6 }],
      fetchImpl: async () => {
        calls += 1;
        return icyResponse('unreachable');
      },
    });
    assert.equal(result.reason, 'host not allowed', address);
    assert.equal(calls, 0, address);
  }
});

test('one private answer among public ones refuses the name', async () => {
  let calls = 0;
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ],
    fetchImpl: async () => {
      calls += 1;
      return icyResponse('unreachable');
    },
  });
  assert.equal(result.reason, 'host not allowed');
  assert.equal(calls, 0);
});

test('a lookup that fails is refused rather than waved through', async () => {
  let calls = 0;
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: async () => {
      throw new Error('SERVFAIL');
    },
    fetchImpl: async () => {
      calls += 1;
      return icyResponse('unreachable');
    },
  });
  assert.equal(result.reason, 'host not allowed');
  assert.equal(calls, 0);
});

test('a hung lookup gives up at the read timeout', { timeout: 2000 }, async () => {
  const result = await readNowPlaying('http://radio.example.com/live', {
    timeoutMs: 40,
    lookupImpl: () => new Promise(() => {}),
    fetchImpl: async () => icyResponse('never'),
  });
  assert.equal(result.reason, 'timeout');
});

test('a public name that resolves to loopback is refused', async () => {
  let calls = 0;
  const result = await readNowPlaying('http://127.0.0.1.nip.io:24786/stream', {
    lookupImpl: loopbackLookup,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('must not be requested');
    },
  });
  assert.equal(result.reason, 'host not allowed');
  assert.equal(calls, 0);
});

test('a public name is allowed and its metadata is read', async () => {
  const url = 'http://radio.example.com/live';
  const result = await readNowPlaying(url, {
    lookupImpl: publicLookup,
    fetchImpl: async (target, init) => {
      assert.equal(target, url);
      assert.equal(init.redirect, 'manual');
      return icyResponse('Artist - Song');
    },
  });
  assert.equal(result.title, 'Artist - Song');
  assert.equal(result.reason, 'ok');
});

test('a public IPv6 answer is not treated as private', async () => {
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: v6Lookup,
    fetchImpl: async () => icyResponse('Six'),
  });
  assert.equal(result.title, 'Six');
});

test('a redirect into loopback is refused before its hop is requested', async () => {
  const targets = [];
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: publicLookup,
    fetchImpl: async (target) => {
      targets.push(target);
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:24786/x' } });
    },
  });
  assert.equal(result.reason, 'redirect-blocked');
  assert.deepEqual(targets, ['http://radio.example.com/live']);
});

test('a redirect to a public CDN is followed', async () => {
  const targets = [];
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: publicLookup,
    fetchImpl: async (target) => {
      targets.push(target);
      if (targets.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/s' } });
      }
      return icyResponse('Moved');
    },
  });
  assert.equal(result.title, 'Moved');
  assert.deepEqual(targets, ['http://radio.example.com/live', 'https://cdn.example.net/s']);
});

test('a redirect to a name that resolves privately is refused before the hop', async () => {
  const targets = [];
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: async (host) =>
      host === 'cdn.example.net'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '203.0.113.10', family: 4 }],
    fetchImpl: async (target) => {
      targets.push(target);
      return new Response(null, { status: 302, headers: { location: 'http://cdn.example.net/s' } });
    },
  });
  assert.equal(result.reason, 'host not allowed');
  assert.deepEqual(targets, ['http://radio.example.com/live']);
});

/** A chain of `hops` redirects, then a body. Returns what was requested. */
async function chain(hops) {
  const targets = [];
  const fetchImpl = async (target) => {
    targets.push(target);
    if (targets.length <= hops) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://cdn.example.net/hop${targets.length}` },
      });
    }
    return icyResponse('Deep');
  };
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: publicLookup,
    fetchImpl,
  });
  return { result, targets };
}

test('a five-hop CDN chain is followed', async () => {
  const { result, targets } = await chain(5);
  assert.equal(result.title, 'Deep');
  assert.equal(targets.length, 6);
});

test('a sixth redirect is refused as a loop', async () => {
  const { result } = await chain(6);
  assert.equal(result.reason, 'redirect-blocked');
});

test('a 304 ends the read instead of looping', async () => {
  const result = await readNowPlaying('http://radio.example.com/live', {
    lookupImpl: publicLookup,
    fetchImpl: async () => new Response(null, { status: 304 }),
  });
  assert.equal(result.reason, 'redirect-blocked');
});

test('parseStreamUrl keeps rejecting the literal forms', () => {
  assert.equal(parseStreamUrl('http://127.0.0.1/').error, 'host not allowed');
  assert.equal(parseStreamUrl('file:///etc/passwd').error, 'unsupported scheme');
  // The name form is accepted here and refused by the lookup inside the reader.
  assert.equal(parseStreamUrl('http://127.0.0.1.nip.io/').url, 'http://127.0.0.1.nip.io/');
});

/** Mount the plugin against a fake server and call one route. */
function mount() {
  const routes = new Map();
  apply(
    {
      get: (name) =>
        name === 'webServer'
          ? { register: (spec) => void routes.set(spec.path, spec.handler) }
          : null,
      effect: () => {},
    },
    { catalogAutoRefresh: false },
  );
  return (path, method, url, headers) =>
    new Promise((resolve) => {
      const res = {
        writeHead(status, extra) {
          this.status = status;
          this.extra = extra || {};
        },
        end(body) {
          resolve({ status: this.status, body: body ? JSON.parse(body) : null });
        },
      };
      routes.get(path)({ method, url, headers: headers || {} }, res);
    });
}

test('a cross-site poll is refused before any stream is read', async () => {
  const call = mount();
  const answer = await call(
    '/blackhole-radio-lab/now-playing',
    'GET',
    '/blackhole-radio-lab/now-playing?url=http://example.com/s',
    { 'sec-fetch-site': 'cross-site' },
  );
  assert.equal(answer.status, 403);
  assert.equal(answer.body.error, 'cross-site');
});

test('a same-origin poll still reaches the URL checks', async () => {
  const call = mount();
  const answer = await call(
    '/blackhole-radio-lab/now-playing',
    'GET',
    '/blackhole-radio-lab/now-playing?url=http://127.0.0.1:1/s',
    { 'sec-fetch-site': 'same-origin' },
  );
  assert.equal(answer.status, 400);
  assert.equal(answer.body.error, 'host not allowed');
});
