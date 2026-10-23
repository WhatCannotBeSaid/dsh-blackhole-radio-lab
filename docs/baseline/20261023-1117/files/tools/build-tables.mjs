/**
 * Turn Bruneton's published precomputed ray tables into a plugin-local ES module.
 *
 * Source of the two `.dat` files (pinned, do not re-fetch at build time):
 *   https://github.com/ebruneton/black_hole_shader
 *   commit e72b3f293409893a6fa25528b29572c96fc57f57 (2020-11-11), BSD-3-Clause.
 *   Published artefacts:
 *     https://ebruneton.github.io/black_hole_shader/demo/deflection.dat
 *     https://ebruneton.github.io/black_hole_shader/demo/inverse_radius.dat
 *
 * On-disk format (verified byte-exact against the published files):
 *   float32 little-endian NX
 *   float32 little-endian NY
 *   NX*NY texels, each 2 float32 little-endian (channel 0, channel 1)
 *   => 8 + NX*NY*8 bytes
 *
 * Why the data is quantised to uint16
 * ----------------------------------
 * The tables are RG32F in Bruneton's demo, which needs OES_texture_float_linear
 * to filter. Storing them as normalised uint16 instead halves the payload and
 * removes that extension requirement, at a cost measured to be an order of
 * magnitude below the table's own accuracy:
 *
 *   deflection      maxAbsErr angle 1.02e-4 rad, time 1.14e-3   (table's own error ~1e-3)
 *   inverse_radius  maxAbsErr u     7.06e-6,     time 1.37e-3
 *
 * Downsampling was measured and rejected: 256x256 already loses 9.7e-3 in the
 * deflection angle, ten times worse than the table itself. The published
 * resolution is kept whole.
 *
 * Run: node tools/build-tables.mjs <dir-with-dat-files>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'scene', 'ray-tables.data.js');

/** Pinned provenance. The build refuses to run if these do not match. */
const SOURCES = {
  deflection: {
    file: 'deflection.dat',
    sha256: '1080f45a12fba81321771c2071f4a31795444b110833f61384a9bdf7d057c19d',
    url: 'https://ebruneton.github.io/black_hole_shader/demo/deflection.dat',
    channels: ['ray deflection angle (rad)', 'time to apsis (geometric units)'],
    coordinates: ['e^2 = 1/b^2 (squared inverse impact parameter)', 'u = 1/r'],
  },
  inverse_radius: {
    file: 'inverse_radius.dat',
    sha256: '7fa22a9270e61f2842c97fb1a9398bcb13e1a965ad39b0f73169354a0d608b04',
    url: 'https://ebruneton.github.io/black_hole_shader/demo/inverse_radius.dat',
    channels: ['u = 1/r at the disc crossing', 'light propagation time (geometric units)'],
    coordinates: ['e^2 = 1/b^2', 'polar angle phi from the apsis'],
  },
};

function load(file) {
  const buf = readFileSync(file);
  const nx = buf.readFloatLE(0);
  const ny = buf.readFloatLE(4);
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx <= 0 || ny <= 0) {
    throw new Error(`${file}: bad NX/NY header (${nx}, ${ny})`);
  }
  const expected = 8 + nx * ny * 8;
  if (buf.length !== expected) {
    throw new Error(`${file}: size ${buf.length} != ${expected} for ${nx}x${ny}`);
  }
  const n = nx * ny;
  const f = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i += 1) f[i] = buf.readFloatLE(8 + i * 4);
  return { nx, ny, n, f };
}

function quantise({ nx, ny, n, f }, label) {
  let max0 = 0;
  let max1 = 0;
  for (let i = 0; i < n; i += 1) {
    const a = f[i * 2];
    const b = f[i * 2 + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`${label}: non-finite texel ${i}`);
    if (a < 0 || b < 0) throw new Error(`${label}: negative texel ${i} (${a}, ${b})`);
    if (a > max0) max0 = a;
    if (b > max1) max1 = b;
  }
  // A zero range would make the scale meaningless; neither table has one.
  if (max0 <= 0 || max1 <= 0) throw new Error(`${label}: degenerate channel range`);
  const q = new Uint16Array(n * 2);
  let err0 = 0;
  let err1 = 0;
  for (let i = 0; i < n * 2; i += 1) {
    const max = i % 2 === 0 ? max0 : max1;
    const v = Math.max(0, Math.min(65535, Math.round((f[i] / max) * 65535)));
    q[i] = v;
    const back = (v / 65535) * max;
    const e = Math.abs(back - f[i]);
    if (i % 2 === 0) err0 = Math.max(err0, e);
    else err1 = Math.max(err1, e);
  }
  return { nx, ny, q, max: [max0, max1], maxAbsError: [err0, err1] };
}

/**
 * Wrap a base64 string as adjacent string literals so the generated module stays
 * readable. esbuild folds the concatenation back into one literal at build time.
 */
function wrapBase64(b64) {
  const WIDTH = 120;
  const lines = [];
  for (let i = 0; i < b64.length; i += WIDTH) {
    lines.push(`      '${b64.slice(i, i + WIDTH)}'`);
  }
  return lines.join(' +\n');
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node tools/build-tables.mjs <dir-with-dat-files>');
    process.exit(1);
  }

  const entries = [];
  const report = [];
  for (const [key, spec] of Object.entries(SOURCES)) {
    const path = join(dir, spec.file);
    const raw = readFileSync(path);
    const sha = createHash('sha256').update(raw).digest('hex');
    if (sha !== spec.sha256) {
      throw new Error(`${spec.file}: sha256 ${sha} does not match the pinned ${spec.sha256}`);
    }
    const table = quantise(load(path), key);
    const b64 = Buffer.from(table.q.buffer, table.q.byteOffset, table.q.byteLength).toString('base64');
    entries.push({ key, spec, table, b64 });
    report.push(
      `${key}: ${table.nx}x${table.ny} uint16x2 = ${table.q.byteLength} B, base64 ${b64.length} chars\n` +
        `  channel scale [${table.max[0]}, ${table.max[1]}]\n` +
        `  quantisation max abs error [${table.maxAbsError[0].toExponential(3)}, ${table.maxAbsError[1].toExponential(3)}]`,
    );
  }

  const body = entries
    .map(
      ({ key, spec, table, b64 }) => `  ${key}: Object.freeze({
    width: ${table.nx},
    height: ${table.ny},
    /** Multiply the decoded uint16 channel by this to get the physical value. */
    scale: Object.freeze([${table.max[0]}, ${table.max[1]}]),
    /** Quantisation error bound per channel, for the numerical-validation report. */
    maxAbsError: Object.freeze([${table.maxAbsError[0]}, ${table.maxAbsError[1]}]),
    url: '${spec.url}',
    sha256: '${spec.sha256}',
    channels: Object.freeze([${spec.channels.map((c) => `'${c}'`).join(', ')}]),
    coordinates: Object.freeze([${spec.coordinates.map((c) => `'${c}'`).join(', ')}]),
    data:
${wrapBase64(b64)},
  }),`,
    )
    .join('\n');

  const out = `/**
 * GENERATED FILE - do not edit by hand. Rebuild with:
 *   node tools/build-tables.mjs <dir-with-dat-files>
 *
 * Precomputed null-geodesic tables from Eric Bruneton's black_hole_shader.
 *
 * Upstream: https://github.com/ebruneton/black_hole_shader
 * Pinned commit: e72b3f293409893a6fa25528b29572c96fc57f57 (2020-11-11)
 * Copyright (c) 2020 Eric Bruneton. BSD-3-Clause; see THIRD-PARTY-NOTICES.md.
 *
 * UNITS. These tables are expressed in geometric units where the Schwarzschild
 * radius Rs = 1, c = 1, and therefore M = Rs/2 = 1/2. Both are indexed by
 * e^2 = (Rs/b)^2, where b is the impact parameter. The plugin's world space uses
 * 1 world unit = 1 critical impact parameter = 3*sqrt(3)/2 Rs; see
 * src/scene/dimensions.js for the single conversion factor.
 *
 * FORMAT. Each \`data\` field is base64 of a little-endian Uint16Array of
 * width*height*2 samples, row-major, channel-interleaved (c0, c1, c0, c1, ...).
 * Decode with the helpers in src/scene/ray-tables.js.
 */
export const RAY_TABLES = Object.freeze({
${body}
});

/** The upstream revision these bytes came from, for the provenance report. */
export const RAY_TABLES_REVISION = 'e72b3f293409893a6fa25528b29572c96fc57f57';
`;

  writeFileSync(OUT, out);
  console.log(`wrote ${OUT}`);
  for (const line of report) console.log(line);
  console.log(`total base64 payload: ${entries.reduce((s, e) => s + e.b64.length, 0)} chars`);
}

main();
