/** Minimal static server for the demo. Serves the repo root so the import map resolves. */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8123);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/apps/canvas-demo/index.html';
  const resolved = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': TYPES[extname(resolved)] ?? 'application/octet-stream' });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => console.log(`serving ${ROOT} at http://localhost:${PORT}/`));
