// Deterministic e2e server: serves the built viewer (dist/) for app routes and
// the committed fixtures (e2e/fixture/) under /reports/* — same origin, so the
// viewer fetches a report's assets without any CORS setup (Allow-Origin: * is
// sent anyway, mirroring the real Worker). Node built-ins only (no new deps).

import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(here, '..', 'dist');
const FIXTURE = join(here, 'fixture');
const PORT = Number(process.env.PORT ?? 4373);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

const send = async (res, file, status = 200) => {
  const body = await readFile(file);
  res.writeHead(status, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
  });
  res.end(body);
};

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (path.includes('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    // Report assets come from the committed fixtures.
    if (path.startsWith('/reports/')) {
      const file = join(FIXTURE, path);
      if (existsSync(file) && statSync(file).isFile()) return await send(res, file);
      res.writeHead(404, { 'access-control-allow-origin': '*' }).end('not found');
      return;
    }
    // Everything else is the built SPA.
    const candidate = path === '/' ? join(DIST, 'index.html') : join(DIST, path);
    const file = existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(DIST, 'index.html');
    await send(res, file);
  } catch {
    res.writeHead(500, { 'access-control-allow-origin': '*' }).end('error');
  }
});

server.listen(PORT, () => console.log(`e2e server on http://localhost:${PORT}`));
