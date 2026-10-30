// Test helpers: start a throwaway Postwoman server + a fixture upstream on free ports. No dependencies.
'use strict';
const http = require('http');
const zlib = require('zlib');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

// A small fake API with the behaviours the tests need (compression, redirects, slow, errors, binary, ...).
function startUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, obj, h) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, h)); res.end(JSON.stringify(obj)); };
      switch (u.pathname) {
        case '/echo': return json(200, { method: req.method, url: req.url, headers: req.headers, body: body.toString() });
        case '/gzip': { const z = zlib.gzipSync(JSON.stringify({ hello: 'gzip', n: [1, 2, 3] })); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); return res.end(z); }
        case '/br': { const z = zlib.brotliCompressSync(JSON.stringify({ hello: 'brotli' })); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' }); return res.end(z); }
        case '/r1': res.writeHead(302, { Location: '/r2' }); return res.end();
        case '/r2': res.writeHead(301, { Location: '/echo?final=1' }); return res.end();
        case '/post303': res.writeHead(303, { Location: '/echo' }); return res.end();
        case '/loop': res.writeHead(302, { Location: '/loop' }); return res.end();
        case '/slow': return setTimeout(() => json(200, { slow: true }), Number(u.searchParams.get('ms') || 300));
        case '/status': return json(Number(u.searchParams.get('c') || 500), { error: 'nope' });
        case '/bin': res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.from([0, 1, 2, 255, 254, 0]));
        case '/html': res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>hi</h1>');
        case '/empty': res.writeHead(204); return res.end();
        case '/cookie': res.writeHead(200, { 'Set-Cookie': ['a=1', 'b=2'], 'Content-Type': 'text/plain' }); return res.end('ok');
        case '/text': res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('hello-world-marker');
        case '/token': return json(200, { data: { access_token: 'tok-' + (u.searchParams.get('n') || '1'), user: { id: 7 } } });
        case '/needs-token': return json(req.headers.authorization === 'Bearer tok-1' ? 200 : 401, { ok: req.headers.authorization === 'Bearer tok-1' });
        case '/big': { // ?mb=N  => about N MB of JSON
          const n = Math.max(1, Number(u.searchParams.get('mb') || 1));
          const row = JSON.stringify({ id: 1, name: 'x'.repeat(40), tags: ['a', 'b', 'c'], nested: { k: 'v', n: 1.5 } });
          const count = Math.ceil((n * 1048576) / (row.length + 1));
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[' + Array(count).fill(row).join(',') + ']');
        }
        case '/jitter': { const d = 15 + Math.floor(Math.pow(Math.random(), 3) * 220); return setTimeout(() => json(Math.random() < 0.04 ? 503 : 200, { id: 'u_' + Math.floor(Math.random() * 1e6), items: Array.from({ length: 30 }, (_, i) => ({ sku: 'SKU-' + i, qty: i % 5 })), delay: d }), d); }
        default: return json(404, { error: 'not found', path: u.pathname });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ server, port, hits, url: 'http://127.0.0.1:' + port, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) });
  }));
}

// Starts server.js as a child process with its own port and state file.
async function startApp(opts) {
  opts = opts || {};
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postwoman-test-'));
  const stateFile = path.join(dir, 'data.json');
  if (opts.state !== undefined) fs.writeFileSync(stateFile, typeof opts.state === 'string' ? opts.state : JSON.stringify(opts.state));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), STATE_FILE: stateFile }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch { /* not up yet */ }
    if (child.exitCode != null) throw new Error('server exited early:\n' + log);
    if (Date.now() - t0 > 8000) { child.kill(); throw new Error('server did not start:\n' + log); }
    await new Promise((r) => setTimeout(r, 60));
  }
  const api = {
    base, port, dir, stateFile, child, log: () => log,
    json: async (p, o) => (await fetch(base + p, o)).json(),
    post: (p, body, headers) => fetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) }),
    send: async (spec) => (await api.post('/api/send', spec)).json(),
    tool: async (name, args) => (await api.post('/api/tools/' + name, args || {})).json(),
    putState: (st) => fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) }),
    state: async () => (await fetch(base + '/api/state')).json(),
    stop: async () => { child.kill(); await new Promise((r) => { if (child.exitCode != null) return r(); child.once('exit', r); setTimeout(r, 1500); }); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { startApp, startUpstream, freePort, sleep, ROOT };
