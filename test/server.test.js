'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { startApp, startUpstream, freePort } = require('./helpers');
const { spawn } = require('child_process');

let app, up;
before(async () => { up = await startUpstream(); app = await startApp(); });
after(async () => { await app.stop(); await up.close(); });
const U = (p) => up.url + p;

test('GET: body, status and timing phases add up', async () => {
  const r = await app.send({ method: 'GET', url: U('/echo?a=1') });
  assert.equal(r.ok, true); assert.equal(r.status, 200);
  const b = JSON.parse(r.body); assert.equal(b.url, '/echo?a=1'); assert.equal(b.method, 'GET');
  const t = r.timings;
  assert.ok(t.total > 0 && t.ttfb >= 0 && t.download >= 0 && t.tcp >= 0, JSON.stringify(t));
  assert.equal(t.tls, null, 'plain http has no TLS phase');
  assert.equal(t.dns, null, 'IP literal has no DNS phase');
  assert.ok(Math.abs(t.total - (t.tcp + t.ttfb + t.download)) < 15, 'phases should add up: ' + JSON.stringify(t));
});

test('URL without a scheme defaults to http://', async () => {
  const r = await app.send({ method: 'GET', url: '127.0.0.1:' + up.port + '/echo' });
  assert.equal(r.status, 200);
});

test('hostname lookups report a DNS phase', async () => {
  const r = await app.send({ method: 'GET', url: 'http://localhost:' + up.port + '/echo' });
  if (r.ok) assert.ok(r.timings.dns != null);
  else assert.ok(/refused|ECONNREFUSED/.test(r.error + r.code), r.error); // localhost may resolve to ::1 only
});

test('POST: json body, custom headers, exact content-length for UTF-8', async () => {
  const body = '{"a":"é"}';
  const r = await app.send({ method: 'POST', url: U('/echo'), headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Test', value: 'héllo' }], body });
  const b = JSON.parse(r.body);
  assert.equal(b.body, body); assert.equal(b.headers['content-type'], 'application/json');
  assert.equal(b.headers['content-length'], String(Buffer.byteLength(body)));
});

test('base64 bodies are sent as raw bytes', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
  await app.send({ method: 'POST', url: U('/echo'), body: bytes.toString('base64'), bodyEncoding: 'base64' });
  assert.deepEqual([...up.hits[up.hits.length - 1].body], [...bytes]);
});

test('disabled headers are skipped and duplicate names resolve last-wins', async () => {
  const r = await app.send({ method: 'GET', url: U('/echo'), headers: [{ key: 'X-A', value: '1', enabled: false }, { key: 'X-B', value: '1' }, { key: 'x-b', value: '2' }] });
  const b = JSON.parse(r.body); assert.equal(b.headers['x-a'], undefined); assert.equal(b.headers['x-b'], '2');
});

test('gzip and brotli responses are decoded; wire size is the compressed size', async () => {
  const expected = JSON.stringify({ hello: 'gzip', n: [1, 2, 3] });
  const g = await app.send({ method: 'GET', url: U('/gzip') });
  assert.equal(g.body, expected); assert.equal(g.size, Buffer.byteLength(expected));
  assert.equal(g.wireSize, zlib.gzipSync(expected).length);
  const b = await app.send({ method: 'GET', url: U('/br') });
  assert.deepEqual(JSON.parse(b.body), { hello: 'brotli' });
});

test('redirects: followed with chain, can be disabled, 303 turns POST into GET, loops stop', async () => {
  const f = await app.send({ method: 'GET', url: U('/r1'), followRedirects: true });
  assert.equal(f.status, 200); assert.equal(f.redirects, 2); assert.equal(f.chain.length, 3); assert.ok(f.url.endsWith('/echo?final=1'));
  assert.ok(f.timings.total >= f.timings.hop);
  const n = await app.send({ method: 'GET', url: U('/r1'), followRedirects: false });
  assert.equal(n.status, 302); assert.equal(n.redirects, 0);
  const p = await app.send({ method: 'POST', url: U('/post303'), body: 'x=1', headers: [{ key: 'Content-Type', value: 'text/plain' }], followRedirects: true });
  const pb = JSON.parse(p.body); assert.equal(pb.method, 'GET'); assert.equal(pb.body, '');
  const l = await app.send({ method: 'GET', url: U('/loop'), followRedirects: true });
  assert.equal(l.ok, false); assert.equal(l.code, 'EREDIRECTS');
});

test('errors are friendly: 5xx is a result, refused/DNS/timeout are errors', async () => {
  assert.equal((await app.send({ method: 'GET', url: U('/status?c=503') })).status, 503);
  const refused = await app.send({ method: 'GET', url: 'http://127.0.0.1:1/' });
  assert.equal(refused.ok, false); assert.equal(refused.code, 'ECONNREFUSED'); assert.match(refused.error, /refused/i);
  const dns = await app.send({ method: 'GET', url: 'http://definitely-not-a-real-host.invalid/' });
  assert.equal(dns.ok, false); assert.ok(['ENOTFOUND', 'EAI_AGAIN'].includes(dns.code), dns.code);
  const to = await app.send({ method: 'GET', url: U('/slow?ms=1500'), timeout: 300 });
  assert.equal(to.ok, false); assert.equal(to.code, 'ETIMEDOUT');
});

test('slow responses are measured (TTFB carries the wait)', async () => {
  const r = await app.send({ method: 'GET', url: U('/slow?ms=250') });
  assert.ok(r.timings.total >= 240 && r.timings.total < 700, r.timings.total); assert.ok(r.timings.ttfb >= 240);
});

test('binary, html, 204, HEAD and repeated Set-Cookie headers', async () => {
  const bin = await app.send({ method: 'GET', url: U('/bin') });
  assert.equal(bin.isText, false); assert.deepEqual([...Buffer.from(bin.body, 'base64')], [0, 1, 2, 255, 254, 0]);
  assert.equal((await app.send({ method: 'GET', url: U('/html') })).body, '<h1>hi</h1>');
  const e = await app.send({ method: 'GET', url: U('/empty') }); assert.equal(e.status, 204); assert.equal(e.size, 0);
  const c = await app.send({ method: 'GET', url: U('/cookie') }); assert.equal(c.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').length, 2);
  const h = await app.send({ method: 'HEAD', url: U('/echo') }); assert.equal(h.status, 200); assert.equal(h.size, 0);
});

test('invalid input is rejected cleanly (and header injection is refused)', async () => {
  assert.equal((await app.send({ method: 'GET', url: '' })).code, 'EBADURL');
  assert.equal((await app.send({ method: 'GET', url: 'ftp://x.com/' })).code, 'EBADURL');
  assert.equal((await app.send({ method: 'GE T', url: U('/echo') })).code, 'EBADMETHOD');
  assert.equal((await app.send({ method: 'GET', url: U('/echo'), headers: [{ key: 'bad header', value: 'x' }] })).code, 'EBADHEADER');
  assert.equal((await app.send({ method: 'GET', url: U('/echo'), headers: [{ key: 'X-Evil', value: 'a\r\nInjected: 1' }] })).ok, false);
});

// ---------- security ----------
test('foreign Host and Origin headers are rejected on every route family', async () => {
  const curlLike = (p, headers, method, body) => new Promise((resolve) => {
    const req = require('http').request({ host: '127.0.0.1', port: app.port, path: p, method: method || 'GET', headers }, (r) => { r.resume(); resolve(r.statusCode); });
    if (body) req.write(body); req.end();
  });
  assert.equal(await curlLike('/api/tools', { Host: 'evil.com:' + app.port }), 403);
  for (const p of ['/mcp', '/api/send', '/api/state', '/api/load/start', '/api/tools/delete_request']) {
    assert.equal(await curlLike(p, { Origin: 'http://evil.com', 'Content-Type': 'application/json' }, 'POST', '{}'), 403, p);
  }
  assert.equal(await curlLike('/api/tools', {}), 200, 'no Origin (CLI tools) is allowed');
  assert.equal(await curlLike('/api/tools', { Origin: app.base }), 200, 'same Origin is allowed');
});

test('static files: no path traversal, bad escapes give 400', async () => {
  const get = (p) => new Promise((resolve) => require('http').get({ host: '127.0.0.1', port: app.port, path: p }, (r) => { r.resume(); resolve(r.statusCode); }));
  assert.equal(await get('/'), 200);
  assert.equal(await get('/style.css'), 200);
  assert.equal(await get('/../server.js'), 404);
  assert.equal(await get('/%2e%2e/server.js'), 404);
  assert.equal(await get('/%E0%A4%A'), 400);
  assert.equal(await get('/nope.js'), 404);
});

// ---------- state safety ----------
test('state: round-trips, refuses non-state bodies, stays intact', async () => {
  const good = { tabs: [{ id: 'x', name: 'é' }], hello: 'é' };
  assert.equal((await app.putState(good)).status, 200);
  assert.equal((await app.state()).hello, 'é');
  for (const bad of [{}, [], null, 'str', 5, { tabs: 'nope' }]) assert.equal((await app.putState(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await app.state()).hello, 'é', 'state must survive refused writes');
});

test('state file is private (0600) where the OS supports it', { skip: process.platform === 'win32' }, async () => {
  await app.putState({ tabs: [] });
  assert.equal((fs.statSync(app.stateFile).mode & 0o777).toString(8), '600');
});

test('oversized request bodies get a real 413 reply, and the server survives', async () => {
  const big = Buffer.alloc(21 * 1024 * 1024, 97);
  const r = await fetch(app.base + '/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(r.status, 413); assert.match((await r.json()).error, /too large/i);
  assert.equal((await fetch(app.base + '/api/health')).status, 200);
});

test('a corrupt state file is moved aside, not silently overwritten', async () => {
  const a2 = await startApp({ state: '{this is not json' });
  try {
    const st = await a2.state(); assert.equal(st.empty, true);
    const kept = fs.readdirSync(a2.dir).filter((f) => f.includes('.corrupt-')); assert.equal(kept.length, 1, fs.readdirSync(a2.dir).join(','));
    assert.equal(fs.readFileSync(path.join(a2.dir, kept[0]), 'utf8'), '{this is not json');
  } finally { await a2.stop(); }
});

test('a backup of the last good state is written at startup', async () => {
  const a2 = await startApp({ state: { tabs: [{ id: 'keep', name: 'keep me' }] } });
  try { assert.ok(fs.readFileSync(a2.stateFile + '.bak', 'utf8').includes('keep me')); } finally { await a2.stop(); }
});

// ---------- startup ----------
test('starting a second copy on the same port says "already running" and exits 0', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(app.port), STATE_FILE: path.join(app.dir, 'other.json') }) });
  let out = ''; child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0); assert.match(out, /already running/i);
});

test('a port held by another program gives a clear message and exit code 1', async () => {
  const blocker = require('http').createServer((q, r) => r.end('x')).listen(0, '127.0.0.1');
  await new Promise((r) => blocker.on('listening', r));
  const port = blocker.address().port;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port), STATE_FILE: path.join(app.dir, 'other2.json') }) });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  blocker.close();
  assert.equal(code, 1); assert.match(err, /in use by another program/i);
});

test('--open launches the system opener with the app URL (Linux path, checked with a stand-in xdg-open)', { skip: process.platform !== 'linux' }, async () => {
  const bin = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pw-opener-'));
  const log = path.join(bin, 'called.txt');
  fs.writeFileSync(path.join(bin, 'xdg-open'), '#!/bin/sh\necho "$@" > ' + JSON.stringify(log) + '\n', { mode: 0o755 });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--open'], { env: Object.assign({}, process.env, { PORT: String(port), STATE_FILE: path.join(bin, 'd.json'), PATH: bin + path.delimiter + process.env.PATH }), stdio: 'ignore' });
  try {
    const t0 = Date.now();
    while (!fs.existsSync(log) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 80));
    assert.ok(fs.existsSync(log), 'the opener was never called');
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'http://localhost:' + port);
  } finally { child.kill(); fs.rmSync(bin, { recursive: true, force: true }); }
});
