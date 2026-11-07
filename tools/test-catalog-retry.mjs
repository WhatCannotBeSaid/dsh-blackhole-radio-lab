import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../src/host/catalog-builder.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';

const rows = [
  { stationuuid: 'a', name: 'A', url_resolved: 'https://a.example/s', tags: 'jazz', countrycode: 'JP', clickcount: 10, lastcheckok: 1 },
  { stationuuid: 'b', name: 'B', url_resolved: 'https://b.example/s', tags: 'rock', countrycode: 'US', clickcount: 5, lastcheckok: 1 },
];

const reply = (body) => ({ ok: true, json: async () => body });

test('a page that fails on every mirror is retried once and kept', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // Two mirrors x one round = 2 failures, then the retry round succeeds.
    if (calls <= 2) throw new Error('ECONNRESET');
    return reply(rows);
  };

  const { snapshot } = await buildCatalog({ target: 200, fetch: 200, hosts: ['h1', 'h2'], fetchImpl });

  assert.equal(calls, 3, `expected one retry round, got ${calls} calls`);
  assert.equal(snapshot.candidates, 2);
  assert.equal(snapshot.stations.length, 2);
});

test('a page that fails both rounds still gives up instead of hanging', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  };

  await assert.rejects(
    buildCatalog({ target: 200, fetch: 200, hosts: ['h1', 'h2'], fetchImpl }),
    /failed to fetch 1\/1 pages/,
  );
  assert.equal(calls, 4, `expected 2 mirrors x 2 rounds, got ${calls} calls`);
});

test('a failed page cannot replace an existing host cache with a partial catalogue', async () => {
  const file = join('cache', 'catalog.v1.json.gz');
  const previous = Buffer.from('previous complete catalogue');
  const files = new Map([[file, previous]]);
  let writes = 0; let progress;
  const source = readFileSync(new URL('../src/host/catalog-refresh.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function refreshCatalogCache(');
  const refresh = vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)).replace('export ', '') + '; refreshCatalogCache', {
    buildCatalog, join, gzipSync, Buffer, process: { pid: 1 },
    mkdirSync() { writes++; }, clearStaleTmp() { writes++; },
    writeFileSync(path, data) { writes++; files.set(path, data); },
    renameSync(from, to) { writes++; files.set(to, files.get(from)); files.delete(from); },
  });
  await assert.rejects(refresh({
    cacheDir: 'cache', target: 1000, fetch: 1000, hosts: ['h1'],
    fetchImpl: async (url) => {
      if (new URL(url).searchParams.get('offset') === '500') throw new Error('ECONNRESET');
      return reply(rows);
    },
    onProgress(event) { if (event.phase === 'fetch') progress = event; },
  }), /failed to fetch 1\/2 pages/);
  assert.equal(progress.failedPages, 1);
  assert.equal(writes, 0);
  assert.equal(files.get(file), previous);
});

test('valid empty pages are not failures and available-station filtering stays enabled', async () => {
  let progress;
  const { snapshot } = await buildCatalog({
    target: 1000, fetch: 1000, hosts: ['h1'],
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams;
      assert.equal(query.get('hidebroken'), 'true');
      return reply(query.get('offset') === '0' ? rows : []);
    },
    onProgress(event) { if (event.phase === 'fetch') progress = event; },
  });
  assert.equal(progress.failedPages, 0);
  assert.equal(snapshot.stations.length, rows.length);
});

test('a malformed page is retried, not treated as a valid empty result', async () => {
  let calls = 0;
  const { snapshot } = await buildCatalog({
    target: 200, fetch: 200, hosts: ['h1', 'h2'],
    fetchImpl: async () => reply(++calls === 1 ? { error: 'upstream failure' } : rows),
  });
  assert.equal(calls, 2);
  assert.equal(snapshot.stations.length, rows.length);
});
