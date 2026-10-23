/**
 * Static server for the phase-2 GPU harness.
 *
 * Read-only by construction: it resolves a URL path under the project root and
 * streams the file. No uploads, no caching headers that would mask an edit, no
 * directory listing, no path escape.
 *
 * Usage:
 *   node tools/harness-server.mjs [--port 8741]
 *   open http://127.0.0.1:8741/docs/radio-gpu-harness/
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glsl': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const port = Number(argValue('--port', '8741')) || 8741;
const host = argValue('--host', '127.0.0.1');

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const target = resolve(ROOT, `.${normalize(pathname)}`);
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('outside the project root');
    return;
  }
  let stat;
  try {
    stat = statSync(target);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  if (!stat.isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not a file');
    return;
  }
  response.writeHead(200, {
    'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(response);
});

server.listen(port, host, () => {
  console.log(`harness server: http://${host}:${port}/docs/radio-gpu-harness/`);
  console.log(`root: ${ROOT}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
