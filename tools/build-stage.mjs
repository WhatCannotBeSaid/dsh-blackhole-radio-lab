/**
 * Build the lazily loaded chunks this plugin ships.
 *
 *   src/stage.js        → client.stage.js   (three inlined; the only WebGL code)
 *   src/radio/index.js  → client.radio.js   (data only: no three, no DOM)
 *   src/hls.js          → client.hls.js     (hls.js inlined; DOM + MediaSource)
 *
 * The outputs are not plain ES modules. They are harness package-local dynamic
 * chunks, which register themselves through the same facade the package's own
 * client bundle uses, tagged with `chunk` so the loader files them under
 * `<package>/client.<name>.js`:
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-blackhole-radio-lab',      // the OWNER package
 *       chunk: 'client.stage.js',           // must match the require.async spec
 *       factory(require) { ... return exports },
 *     });
 *
 * That name is not free-form: the loader only accepts
 * `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` and resolves the file next to
 * `exports["./client"]` inside this package. `require.async('./client.stage.js')`
 * and `require.async('./client.radio.js')` from client.js are what fetch them,
 * on demand, at the current revision.
 *
 * Run: npm run build  (node tools/build-stage.mjs)
 *
 * Cache invalidation: the loader derives a chunk's URL from the *entry*
 * bundle's revision, not from the chunk's own bytes, and serves it immutable.
 * Overwriting a chunk alone would therefore keep handing out the previous bytes
 * under the same URL. The entry's mtime is bumped whenever either chunk's
 * content actually changes.
 */

import { build } from 'esbuild';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { readFileSync, writeFileSync, statSync, utimesSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Package name — the owner id each chunk registers against. */
const OWNER_ID = 'dsh-blackhole-radio-lab';
/** Read for the banner only: a shipped chunk must state its own licence. */
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
/** The entry bundle hosts both chunks, so its revision is their revision. */
const ENTRY_BUNDLE = join(ROOT, 'client.js');

const CHUNKS = [
  {
    chunk: 'client.stage.js',
    entry: join(ROOT, 'src', 'stage.js'),
    // No bare `three` may survive: the browser would try to resolve it against
    // the harness module table instead of the inlined copy beside it.
    forbidBareThree: true,
    bundled: 'Includes three.js (MIT); see THIRD-PARTY-NOTICES.md.',
  },
  {
    chunk: 'client.radio.js',
    entry: join(ROOT, 'src', 'radio', 'index.js'),
    // The data chunk must stay renderer-free; importing three would be a layer
    // violation that also doubles the chunk, so the build refuses it.
    forbidBareThree: true,
    bundled: 'No bundled third-party code; see THIRD-PARTY-NOTICES.md.',
  },
  {
    chunk: 'client.hls.js',
    entry: join(ROOT, 'src', 'hls.js'),
    // hls.js is bundled in rather than resolved at runtime: there is no module
    // table entry for it, and a bare specifier would surface as a load failure
    // only when a station first needs HLS. It may not pull in three either.
    forbidBareThree: true,
    bundled: 'Includes hls.js (Apache-2.0); see THIRD-PARTY-NOTICES.md.',
  },
];

const fmt = (n) => `${n} B (${(n / 1024).toFixed(1)} KiB)`;
const stats = (buffer) => ({
  raw: buffer.length,
  gzip: gzipSync(buffer, { level: 9 }).length,
  brotli: brotliCompressSync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});

async function buildChunk(spec) {
  const result = await build({
    entryPoints: [spec.entry],
    bundle: true,
    write: false,
    // CJS is the target shape because the loader's factory contract is
    // factory-form CJS: it returns the module's exports object.
    format: 'cjs',
    platform: 'browser',
    target: ['es2021'],
    minify: true,
    treeShaking: true,
    legalComments: 'none',
    // three's ESM build branches on NODE_ENV; pin it so the dev-only paths are
    // dropped instead of shipping an undefined-global check.
    define: { 'process.env.NODE_ENV': '"production"' },
    // No loader for these, and nothing here should ever need them. Failing the
    // build is the point: a silent stub would surface as a runtime crash.
    external: [],
  });

  // A sourceMappingURL trailer would make the browser request a map the chunk
  // route does not serve for this package, so it is stripped rather than shipped.
  const body = result.outputFiles[0].text.replace(
    /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/,
    '\n',
  );

  const banner = [
    `/*! ${OWNER_ID} v${PKG.version} — ${PKG.license} License, © 2026 ${PKG.author}`,
    ` * ${spec.bundled}`,
    ' *',
    ' * Portions copyright (c) 2020 Eric Bruneton, BSD-3-Clause.',
    ' * Geodesic ray tracing and precomputed ray tables derive from',
    ' * https://github.com/ebruneton/black_hole_shader',
    ' * (commit e72b3f293409893a6fa25528b29572c96fc57f57).',
    ' * Conditions: redistributions of source code must retain this notice and',
    ' * the disclaimer; redistributions in binary form must reproduce them in',
    ' * the documentation; the copyright holder\'s name may not endorse derived',
    ' * products without prior written permission.',
    ' * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,',
    ' * EXPRESS OR IMPLIED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR',
    ' * CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY',
    ' * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE.',
    ' * Full text: LICENSE-BLACK_HOLE_SHADER (shipped with this package).',
    ' *',
    ' * Generated by tools/build-stage.mjs — edit src/ and rebuild, never this file. */',
  ].join('\n');

  const artifact = `${banner}
window.__ModuleLoader__.load({
  id: ${JSON.stringify(OWNER_ID)},
  chunk: ${JSON.stringify(spec.chunk)},
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports) {
${body}
    })(module, exports);
    return module.exports;
  },
});
`;

  if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(spec.chunk)) {
    throw new Error(`chunk name ${spec.chunk} does not satisfy the loader's CLIENT_CHUNK pattern`);
  }
  if (spec.forbidBareThree && /\brequire\(\s*["']three["']\s*\)/.test(body)) {
    throw new Error(`${spec.chunk} still requires the bare specifier "three"`);
  }

  return { spec, artifact, bytes: stats(Buffer.from(artifact, 'utf8')) };
}

const built = [];
let changedAny = false;

for (const spec of CHUNKS.filter((spec) => !process.argv.includes('--radio-only') || spec.chunk === 'client.radio.js')) {
  const output = join(ROOT, spec.chunk);
  const { artifact, bytes } = await buildChunk(spec);
  const previous = existsSync(output) ? readFileSync(output, 'utf8') : null;
  writeFileSync(output, artifact, 'utf8');
  const changed = previous !== artifact;
  if (changed) changedAny = true;
  built.push({ spec, output, bytes, changed });
}

// Touch the entry only on a real change: an unconditional bump would defeat
// browser caching on every no-op build.
if (changedAny) {
  const stamp = new Date();
  utimesSync(ENTRY_BUNDLE, stamp, stamp);
}

for (const { spec, output, bytes, changed } of built) {
  console.log(`built ${spec.chunk}`);
  console.log(`  entry      ${spec.entry}`);
  console.log(`  raw        ${fmt(bytes.raw)}`);
  console.log(`  gzip -9    ${fmt(bytes.gzip)}   (${((bytes.gzip / bytes.raw) * 100).toFixed(1)}% of raw)`);
  console.log(`  brotli -11 ${fmt(bytes.brotli)}   (${((bytes.brotli / bytes.raw) * 100).toFixed(1)}% of raw)`);
  console.log(`  on disk    ${statSync(output).size} B`);
  console.log(`  changed    ${changed ? 'yes' : 'no'}`);
}
console.log(`entry bump   ${changedAny ? 'client.js mtime bumped' : 'none — both chunks unchanged'}`);
