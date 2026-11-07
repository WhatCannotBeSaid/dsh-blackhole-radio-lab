/**
 * Build the station catalogue the plugin ships.
 *
 * Fetch a larger directory ahead of time without excluding failed streams:
 *
 *   1. fetch a candidate pool from Radio Browser (paged, parallel, mirrors);
 *   2. optionally probe streams for diagnostic statistics only;
 *   3. pick by click count with country and genre floors, regardless of health;
 *   4. write `data/catalog.v1.json` plus its gzip twin, and print the stats.
 *
 * The work itself lives in `src/host/catalog-builder.js`, because the Host half
 * runs the same build once a week into the user cache. This file is only the
 * CLI wrapper: environment knobs, progress output and the atomic write.
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
 *   CATALOG_TARGET=65000        stations kept in the snapshot
 *   CATALOG_FETCH=65000         candidates fetched before probing
 *   CATALOG_CHECK=0             1 enables diagnostic probes, never exclusion
 *   CATALOG_CHECK_CONCURRENCY=12
 *   CATALOG_CHECK_TIMEOUT=3500  ms per probe
 *   CATALOG_COUNTRY_FLOOR=6     guaranteed stations per country
 *   CATALOG_GENRE_FLOOR=40      guaranteed stations per genre
 */

import { mkdirSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../src/host/catalog-builder.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data');
const OUT_JSON = join(OUT_DIR, 'catalog.v1.json');
const OUT_GZ = join(OUT_DIR, 'catalog.v1.json.gz');

const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

const options = {
  target: envInt('CATALOG_TARGET', 65000),
  fetch: envInt('CATALOG_FETCH', 65000) || undefined,
  check: envInt('CATALOG_CHECK', 0) !== 0,
  concurrency: envInt('CATALOG_CHECK_CONCURRENCY', 12),
  timeoutMs: envInt('CATALOG_CHECK_TIMEOUT', 3500),
  countryFloor: envInt('CATALOG_COUNTRY_FLOOR', 6),
  genreFloor: envInt('CATALOG_GENRE_FLOOR', 40),
  onProgress(event) {
    if (event.phase === 'fetch') {
      console.log(
        `fetched ${event.done} candidates in ${event.elapsedMs} ms ` +
          `(${event.pages - event.failedPages}/${event.pages} pages, ${event.failedPages} failed)`,
      );
      return;
    }
    if (event.phase === 'probe') {
      const rate = event.done / Math.max(1, event.elapsedMs);
      const eta = Math.round((event.total - event.done) / Math.max(0.001, rate) / 1000);
      process.stdout.write(`  probed ${event.done}/${event.total} (${eta}s left)\r`);
      if (event.done === event.total) {
        process.stdout.write('\n');
        const percent = ((event.healthy / Math.max(1, event.total)) * 100).toFixed(1);
        console.log(
          `health check: ${event.healthy}/${event.total} healthy (${percent}%) ` +
            `in ${event.elapsedMs} ms`,
        );
      }
      return;
    }
    if (event.phase === 'pick') {
      console.log(
        `picked ${event.picked} stations ` +
          `(country floors ${event.countryHits}, genre floors ${event.genreHits})`,
      );
    }
  },
};

async function main() {
  if (options.fetch && options.fetch < options.target) {
    console.warn(
      `catalog build: CATALOG_FETCH ${options.fetch} is below CATALOG_TARGET ${options.target}; ` +
        `the builder raises it to ${options.target}, so that is how many candidates get fetched.`,
    );
  }
  console.log(
    `catalog build: target ${options.target}, fetch ${options.fetch ?? 'auto'}, ` +
      `country floor ${options.countryFloor}, genre floor ${options.genreFloor}`,
  );
  const { snapshot, stats } = await buildCatalog(options);

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

  const genreText = Object.entries(stats.genres)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => `${id}:${count}`)
    .join(' ');
  console.log(`countries ${stats.countries} | genres ${genreText}`);
  console.log(
    `wrote ${OUT_JSON} (${statSync(OUT_JSON).size} B) ` +
      `and ${OUT_GZ} (${statSync(OUT_GZ).size} B)`,
  );
  console.log(
    `summary ${JSON.stringify({
      v: snapshot.v,
      builtAt: snapshot.builtAt,
      candidates: stats.candidates,
      healthy: stats.healthy,
      stations: stats.picked,
      countries: stats.countries,
      genres: stats.genres,
      bytes: { json: statSync(OUT_JSON).size, gzip: statSync(OUT_GZ).size },
    })}`,
  );
}

main().catch((error) => {
  console.error(`catalog build failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
