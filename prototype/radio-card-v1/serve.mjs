/**
 * Minimal read-only static server for the isolated preview.
 *
 * Serves only files inside this directory; no upload, no write, no directory
 * listing. Prints the URL it actually bound (port 0 = OS-assigned).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let filePath = path.join(here, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(here)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`preview: http://127.0.0.1:${port}/preview.html`);
  console.log('press Ctrl+C to stop');
});
