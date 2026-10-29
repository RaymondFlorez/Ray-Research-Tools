/** Minimal static server for the demo. Serves the repo root so the import map resolves. */
import { createServer, request } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './security-headers.mjs';

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
  // Required for `instantiateStreaming`, which refuses any other type.
  '.wasm': 'application/wasm',
};

/**
 * Where `/v1/` goes: the Go data plane (services/dataplane), when one is
 * running; and `/gw/`, the model gateway (services/gateway), with the prefix
 * removed. Proxied rather than called cross-origin so the pages keep
 * `connect-src 'self'`, and streamed through unbuffered so a Server-Sent Event
 * reaches the page when it is sent, not when a buffer fills.
 */
const DATAPLANE = process.env.DATAPLANE_URL;
const GATEWAY = process.env.GATEWAY_URL;
/** `/collab/`: the collaboration server (services/collab), its HTTP API and its WebSocket. */
const COLLAB = process.env.COLLAB_URL;

function proxy(req, res, base, name, path) {
  if (!base) {
    res.writeHead(502, { 'content-type': 'text/plain' }).end(`no ${name} configured\n`);
    return;
  }
  const target = new URL(path, base);
  const upstream = request(
    target,
    { method: req.method, headers: { ...req.headers, host: target.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, { ...up.headers, ...securityHeaders() });
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`${name} unreachable: ${err.message}\n`);
  });
  // The response's close, not the request's: a request emits `close` as soon
  // as its body is read, which for a GET is at once, and tearing the upstream
  // down then kills every stream before its first event.
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/v1/')) {
    proxy(req, res, DATAPLANE, 'data plane', req.url ?? '/');
    return;
  }
  if (url.pathname.startsWith('/gw/')) {
    proxy(req, res, GATEWAY, 'model gateway', (req.url ?? '/').slice('/gw'.length));
    return;
  }
  if (url.pathname.startsWith('/collab/')) {
    proxy(req, res, COLLAB, 'collaboration server', (req.url ?? '/').slice('/collab'.length));
    return;
  }
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
    const type = TYPES[extname(resolved)] ?? 'application/octet-stream';
    // PRD 7.2's CSP and COOP/COEP on every response, so the demo runs under the
    // policy the product would and a violation shows up here first.
    if (extname(resolved) === '.html') {
      const html = await readFile(resolved, 'utf8');
      res.writeHead(200, { 'content-type': type, ...securityHeaders(html) });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'content-type': type, ...securityHeaders() });
    createReadStream(resolved).pipe(res);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// The collaboration server's WebSocket, passed through byte for byte once the
// upstream has accepted the upgrade.
server.on('upgrade', (req, socket, head) => {
  if (!COLLAB || !(req.url ?? '').startsWith('/collab')) {
    socket.destroy();
    return;
  }
  const target = new URL((req.url ?? '/').slice('/collab'.length) || '/', COLLAB);
  const upstream = request(target, { method: 'GET', headers: { ...req.headers, host: target.host } });
  upstream.on('upgrade', (res, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead.length > 0) socket.write(upHead);
    if (head.length > 0) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const close = () => {
      upSocket.destroy();
      socket.destroy();
    };
    upSocket.on('error', close);
    socket.on('error', close);
    upSocket.on('close', close);
    socket.on('close', close);
  });
  upstream.on('response', (res) => {
    socket.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.listen(PORT, () => console.log(`serving ${ROOT} at http://localhost:${PORT}/`));
