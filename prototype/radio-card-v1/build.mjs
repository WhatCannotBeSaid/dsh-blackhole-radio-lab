/**
 * Isolated build for the card prototype.
 *
 * Reads only this directory's `src/`, writes only this directory's `dist/`.
 * Reuses the esbuild already installed in the parent checkout — it never
 * installs, upgrades or touches the parent project's sources or artifacts.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, 'dist', 'client.js');

await mkdir(path.join(here, 'dist'), { recursive: true });

const result = await build({
  absWorkingDir: here,
  entryPoints: [path.join(here, 'src', 'plugin.js')],
  outfile,
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});

const inputs = Object.keys(result.metafile.inputs).sort();
const { size } = await stat(outfile);
await writeFile(
  path.join(here, 'dist', 'build-info.json'),
  `${JSON.stringify({ builtAt: new Date().toISOString(), outfile: 'dist/client.js', bytes: size, inputs }, null, 2)}\n`,
);

console.log(`built dist/client.js (${size} bytes) from ${inputs.length} input(s)`);
