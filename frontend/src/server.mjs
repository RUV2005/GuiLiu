import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeFilePath } from './static-path.mjs';
import { createMarketHandler } from './market-service.mjs';
import { createLocalAuth } from './local-auth.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const host = '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8001';
const agent = process.env.AGENT_URL || 'http://127.0.0.1:8000';
const auth = await createLocalAuth({ root, host, port, backend, agent });
const market = createMarketHandler();
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' };
const hopHeaders = ['host', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'trailer', 'te', 'x-target-base'];
function reply(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function proxy(req, res, base, path) {
  // Always this deployment's own services: a stale browser-side address (x-target-base, stripped below)
  // can neither redirect writes to another site nor block the page; settings show the real addresses.
  const target = new URL(path, base);
  let headers;
  try { headers = auth.proxyHeaders(req, base, target); }
  catch { return reply(res, 403, { success: false, error: 'Unconfigured proxy destination' }); }
  for (const key of hopHeaders) delete headers[key];
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const response = await fetch(target, { method: req.method, headers, redirect: 'manual',
      signal: controller.signal,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req, duplex: 'half' });
    const output = Object.fromEntries(response.headers);
    delete output['set-cookie'];
    delete output['access-control-allow-origin'];
    for (const key of [...hopHeaders, 'content-encoding', 'content-length']) delete output[key];
    output['x-abk-proxy-target'] = target.origin;
    output['cache-control'] = 'no-store';
    res.writeHead(response.status, output);
    res.flushHeaders();
    if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (error) {
    if (res.headersSent || res.destroyed) { res.destroy(); return; }
    reply(res, 502, { success: false, result: null, error: 'Upstream service unavailable' });
  }
}
const server = createServer(async (req, res) => {
  try {
    if (await auth.handle(req, res)) return;
    const url = new URL(req.url, 'http://' + host + ':' + port);
    const p = url.pathname;
    if (p === '/healthz') return reply(res, 200, { success: true, service: 'guiliu-release', port });
    if (p === '/backend' || p.startsWith('/backend/')) return await proxy(req, res, backend, p.slice(8) + url.search);
    if (p === '/agent/prompts' || p.startsWith('/agent/prompts/')) return await proxy(req, res, agent, p.slice(6) + url.search);
    if (p === '/agent/openapi.json') return await proxy(req, res, agent, '/openapi.json');
    if (p.startsWith('/agent/')) return await proxy(req, res, agent, p + url.search);
    if (p.startsWith('/market/')) {
      if (process.env.GUILIU_SMOKE_TEST === '1') return reply(res, 503, { success: false, error: 'Market network disabled in smoke test' });
      return await market(req, res);
    }
    // Only public UI assets are served; no test tools, package metadata or server source.
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed', 'text/plain');
    const publicPath = ['/', '/index.html', '/initialization.html'].includes(p)
      || p.startsWith('/assets/') || p.startsWith('/src/');
    const blocked = /(?:server|service|local-auth)\.mjs$|\/test[^/]*|\/check\.mjs$|\.md$/i.test(p);
    const file = safeFilePath(root, p);
    if (!publicPath || blocked || !file || !types[extname(file)]) return reply(res, 404, 'Not found', 'text/plain');
    let stat;
    try { stat = statSync(file); } catch { return reply(res, 404, 'Not found', 'text/plain'); }
    if (!stat.isFile()) return reply(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'content-type': types[extname(file)], 'content-length': stat.size,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
    if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(file), res);
  } catch { if (!res.headersSent) reply(res, 500, 'Request failed', 'text/plain'); else res.destroy(); }
});
server.listen(port, host, () => {
  console.log('GUILIU: http://' + host + ':' + port);
  auth.announce();
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
