// A tiny static server that serves the repo under /verd/, like GitHub Pages serves the site.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

export function serveSite(port){
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith('/verd/')) { res.writeHead(404); return res.end(); }
    p = p.slice('/verd'.length); if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep) || /[\\/](tests|\.git)[\\/]/.test(file)) { res.writeHead(404); return res.end(); }
    try { const body = readFileSync(file); res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  return new Promise(r => s.listen(port, () => r(s)));
}
