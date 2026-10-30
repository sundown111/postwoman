#!/usr/bin/env node
// Zero-dependency local server: serves the UI, sends requests (no CORS limits),
// measures real timings (DNS / TCP / TLS / TTFB / download) and persists state.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');
const Sync = require('./public/sync.js');
const Kit = require('./public/loadkit.js');

const PORT = Number(process.env.PORT) || 7777;
const HOST = '127.0.0.1'; // local only, on purpose
const PUBLIC = path.join(__dirname, 'public');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data.json');
const MAX_BODY_IN = 20 * 1024 * 1024;   // request body we accept from the UI
const MAX_BODY_OUT = 50 * 1024 * 1024;  // response body we keep
const MAX_REDIRECTS = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

// ---------- helpers ----------
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, failed = false;
    req.on('data', (c) => {
      if (failed) return; // keep draining (so the client can read our 413), but store nothing
      size += c.length;
      if (size > limit) { failed = true; chunks.length = 0; reject(Object.assign(new Error('Payload too large (limit ' + Math.round(limit / 1048576) + ' MB)'), { status: 413, close: true })); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj, extraHeaders) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length, 'Cache-Control': 'no-store' }, extraHeaders || {}));
  res.end(data);
}

// Block DNS-rebinding / cross-site calls: only accept our own host + same-origin.
function allowedRequest(req) {
  const host = (req.headers.host || '').toLowerCase();
  const okHost = host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}` || host === `[::1]:${PORT}`;
  if (!okHost) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  return true;
}

function isTextual(contentType, buf) {
  const ct = (contentType || '').toLowerCase();
  if (/(json|text|xml|html|javascript|x-www-form-urlencoded|yaml|csv|svg|graphql)/.test(ct)) return true;
  if (ct && !/octet-stream/.test(ct)) return false;
  // no/unknown content type: sniff for NUL bytes
  const n = Math.min(buf.length, 2048);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function decompress(buf, encoding) {
  const enc = (encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch { /* fall through: return raw */ }
  return buf;
}

// ---------- one HTTP hop with timings ----------
// agents: false (fresh connection per request) or { http, https } keep-alive agents (load tests).
// discard: count response bytes without keeping them.
function doHop({ method, urlObj, headers, body, timeoutMs, insecure, agents, signal, discard }) {
  return new Promise((resolve, reject) => {
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const t = { dns: null, tcp: null, tls: null, ttfb: null, download: null, total: null };
    let tLookup = 0, tConnect = 0, tSecure = 0;

    const opts = {
      method,
      hostname: urlObj.hostname.replace(/^\[|\]$/g, ''),
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      headers,
      agent: agents ? agents[isHttps ? 'https' : 'http'] : false, // false => fresh connection => honest DNS/TCP/TLS numbers
      timeout: timeoutMs,
    };
    if (signal) opts.signal = signal;
    if (isHttps && insecure) opts.rejectUnauthorized = false;

    const req = lib.request(opts, (res) => {
      const tHeaders = ms();
      t.ttfb = tHeaders - (isHttps ? tSecure || tConnect : tConnect || tLookup);
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (!discard && size <= MAX_BODY_OUT) chunks.push(c);
      });
      res.on('end', () => {
        const tEnd = ms();
        t.download = tEnd - tHeaders;
        t.total = tEnd;
        resolve({ res, raw: Buffer.concat(chunks), wireSize: size, timings: t, truncated: size > MAX_BODY_OUT });
      });
      res.on('error', reject);
    });

    req.on('socket', (sock) => {
      const connecting = sock.connecting;
      if (!connecting) { // reused keep-alive socket: no DNS/TCP/TLS cost
        tLookup = tConnect = tSecure = ms();
        t.dns = 0; t.tcp = 0; t.tls = isHttps ? 0 : null;
        return;
      }
      sock.once('lookup', () => { tLookup = ms(); t.dns = tLookup; });
      sock.once('connect', () => { tConnect = ms(); t.tcp = tConnect - (tLookup || 0); if (!isHttps) t.tls = null; });
      sock.once('secureConnect', () => { tSecure = ms(); t.tls = tSecure - tConnect; });
    });

    req.on('timeout', () => req.destroy(Object.assign(new Error(`Timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body && body.length && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

// ---------- full request: redirects, decompression, shaping ----------
// Validates and normalises a request spec once, so load tests can reuse it for every iteration.
function prepare(spec) {
  const method = String(spec.method || 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw Object.assign(new Error('Invalid HTTP method'), { code: 'EBADMETHOD' });

  let urlStr = String(spec.url || '').trim();
  if (!urlStr) throw Object.assign(new Error('URL is empty'), { code: 'EBADURL' });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlStr)) urlStr = 'http://' + urlStr;
  let urlObj;
  try { urlObj = new URL(urlStr); } catch { throw Object.assign(new Error('Invalid URL: ' + urlStr), { code: 'EBADURL' }); }
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    throw Object.assign(new Error('Only http:// and https:// are supported'), { code: 'EBADURL' });
  }

  // headers: keep order and duplicates out; last one wins, case-insensitive
  const headers = {};
  for (const h of spec.headers || []) {
    if (!h || !h.key || h.enabled === false) continue;
    const k = String(h.key).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw Object.assign(new Error('Invalid header name: ' + k), { code: 'EBADHEADER' });
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === k.toLowerCase()) delete headers[existing];
    headers[k] = String(h.value ?? '');
  }
  const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  if (!has('user-agent')) headers['User-Agent'] = 'Postwoman/1.0';
  if (!has('accept')) headers['Accept'] = '*/*';
  if (!has('accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate, br';

  let body = null;
  if (spec.body != null && spec.body !== '' && !['GET', 'HEAD'].includes(method)) {
    body = spec.bodyEncoding === 'base64' ? Buffer.from(String(spec.body), 'base64') : Buffer.from(String(spec.body), 'utf8');
    if (!has('content-length')) headers['Content-Length'] = String(body.length);
  }

  let sentBytes = method.length + urlObj.pathname.length + urlObj.search.length + 13 + urlObj.host.length + 8;
  for (const [k, v] of Object.entries(headers)) sentBytes += k.length + String(v).length + 4;
  sentBytes += 2 + (body ? body.length : 0);

  return {
    method, urlObj, headers, body, sentBytes,
    timeoutMs: Math.min(Math.max(Number(spec.timeout) || 30000, 100), 300000),
    follow: spec.followRedirects !== false,
    insecure: !!spec.insecure,
  };
}

// Sends a prepared request, following redirects. o: { agents, signal, discard }
async function runHops(p, o = {}) {
  const chain = [];
  const wallStart = process.hrtime.bigint();
  let hop, urlObj = p.urlObj, curMethod = p.method, curBody = p.body, curHeaders = { ...p.headers };

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    hop = await doHop({ method: curMethod, urlObj, headers: curHeaders, body: curBody, timeoutMs: p.timeoutMs, insecure: p.insecure, agents: o.agents, signal: o.signal, discard: o.discard });
    const status = hop.res.statusCode;
    const loc = hop.res.headers.location;
    chain.push({ url: urlObj.href, status });
    if (!p.follow || !loc || ![301, 302, 303, 307, 308].includes(status)) break;
    if (i === MAX_REDIRECTS) throw Object.assign(new Error(`Too many redirects (>${MAX_REDIRECTS})`), { code: 'EREDIRECTS' });
    const next = new URL(loc, urlObj);
    const crossOrigin = next.origin !== urlObj.origin;
    if (status === 303 || ((status === 301 || status === 302) && curMethod === 'POST')) {
      curMethod = curMethod === 'HEAD' ? 'HEAD' : 'GET';
      curBody = null;
      curHeaders = Object.fromEntries(Object.entries(curHeaders).filter(([k]) => !/^content-(length|type)$/i.test(k)));
    }
    if (crossOrigin) curHeaders = Object.fromEntries(Object.entries(curHeaders).filter(([k]) => !/^(authorization|cookie)$/i.test(k)));
    urlObj = next;
  }
  return { hop, chain, urlObj, totalWall: Number(process.hrtime.bigint() - wallStart) / 1e6 };
}

async function sendRequest(spec) {
  const { hop, chain, urlObj, totalWall } = await runHops(prepare(spec));
  const { res, raw, wireSize, timings, truncated } = hop;
  const encoding = res.headers['content-encoding'];
  const bodyBuf = truncated ? raw : decompress(raw, encoding);
  const ct = res.headers['content-type'] || '';
  const textual = isTextual(ct, bodyBuf);

  const outHeaders = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) outHeaders.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);

  const r = (n) => (n == null ? null : Math.round(n * 100) / 100);
  return {
    ok: true,
    status: res.statusCode,
    statusText: res.statusMessage || '',
    httpVersion: res.httpVersion,
    url: urlObj.href,
    redirects: chain.length - 1,
    chain,
    headers: outHeaders,
    contentType: ct,
    size: bodyBuf.length,
    wireSize,
    truncated,
    isText: textual,
    body: textual ? bodyBuf.toString('utf8') : bodyBuf.toString('base64'),
    timings: {
      dns: r(timings.dns), tcp: r(timings.tcp), tls: r(timings.tls),
      ttfb: r(timings.ttfb), download: r(timings.download),
      hop: r(timings.total), // final hop only (phases above belong to it)
      total: r(totalWall), // whole wall-clock incl. redirects
    },
  };
}

function friendlyError(e) {
  const map = {
    ENOTFOUND: 'DNS lookup failed: host not found',
    ECONNREFUSED: 'Connection refused: nothing is listening there',
    ECONNRESET: 'Connection reset by the server',
    ETIMEDOUT: 'Request timed out',
    EHOSTUNREACH: 'Host unreachable',
    CERT_HAS_EXPIRED: 'TLS certificate has expired (enable "Ignore TLS errors" to bypass)',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS certificate (enable "Ignore TLS errors" to bypass)',
    SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed certificate in chain (enable "Ignore TLS errors" to bypass)',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Cannot verify TLS certificate (enable "Ignore TLS errors" to bypass)',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the hostname (enable "Ignore TLS errors" to bypass)',
  };
  return { ok: false, code: e.code || 'ERROR', error: map[e.code] || e.message || String(e) };
}

// ---------- state persistence (atomic write) ----------
function loadState() {
  let text;
  try { text = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return null; } // no file yet
  try { return JSON.parse(text); } catch {
    // Unreadable file: keep it aside instead of silently overwriting it with an empty state on the next save.
    try {
      const keep = STATE_FILE + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(STATE_FILE, keep);
      console.error('  ! ' + STATE_FILE + ' was not valid JSON. Moved to ' + keep + ' and starting fresh.');
    } catch { /* ignore */ }
    return null;
  }
}
function saveState(obj) {
  const tmp = STATE_FILE + '.tmp';
  // 0o600: the file holds tokens and passwords. (Windows ignores the mode bits; the file stays in your user profile.)
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
// One backup of the last good state per launch, so a bad save or a bug can be undone.
function backupState() {
  try {
    const text = fs.readFileSync(STATE_FILE, 'utf8');
    JSON.parse(text);
    fs.writeFileSync(STATE_FILE + '.bak', text, { mode: 0o600 });
  } catch { /* nothing to back up */ }
}
const looksLikeState = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && Array.isArray(o.tabs);

// ---------- live sync between AI agents and open browser pages ----------
// Agent changes go through mutate(): written to disk, logged with a revision number and pushed to pages over SSE.
// When a page saves, it sends the last revision it has seen; newer agent changes are merged in so neither side loses work.
const BOOT = crypto.randomUUID();
const MAX_LOG = 2000;
let rev = 0, trimmedRev = 0;
const changeLog = [];
const sseClients = new Set();

function emptyState() {
  return { v: 1, groups: [], tabs: [], envs: [{ id: 'globals', name: 'Globals', vars: [] }], activeEnvId: null, activeTabId: null, ui: { side: true, theme: 'dark', reqh: 42 } };
}

function broadcast(msg) {
  const line = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const c of sseClients) c.write(line);
}

// fn(state, touch) runs synchronously; touch(kind, id, { fields, deleted }) records what changed.
function mutate(fn) {
  const st = loadState() || emptyState();
  if (!Array.isArray(st.tabs)) st.tabs = [];
  if (!Array.isArray(st.groups)) st.groups = [];
  if (!Array.isArray(st.envs)) st.envs = [];
  if (!st.envs.some((e) => e.id === 'globals')) st.envs.unshift({ id: 'globals', name: 'Globals', vars: [] });
  const touched = [];
  const touch = (kind, id, o) => touched.push({ kind, id, deleted: !!(o && o.deleted), fields: (o && o.fields) || null });
  const out = fn(st, touch);
  if (touched.length) {
    saveState(st);
    rev++;
    for (const t of touched) changeLog.push(Object.assign({ rev }, t));
    if (changeLog.length > MAX_LOG) trimmedRev = changeLog.splice(0, changeLog.length - MAX_LOG).pop().rev;
    broadcast({ type: 'state', rev });
  }
  return out;
}

// Collapses the change log since `since` into one item per entity, with its current data.
function itemsSince(since, st) {
  const map = new Map();
  for (const c of changeLog) {
    if (c.rev <= since) continue;
    const k = c.kind + ':' + c.id;
    const prev = map.get(k);
    if (c.deleted) map.set(k, { kind: c.kind, id: c.id, deleted: true, fields: null });
    else if (!c.fields || !prev || prev.deleted) map.set(k, { kind: c.kind, id: c.id, deleted: false, fields: c.fields ? [...c.fields] : null });
    else if (prev.fields) prev.fields = [...new Set(prev.fields.concat(c.fields))];
  }
  const items = [];
  for (const it of map.values()) {
    if (!it.deleted) {
      const ent = ((st && st[Sync.LISTS[it.kind]]) || []).find((x) => x && x.id === it.id);
      if (!ent) continue;
      it.data = ent;
    }
    items.push(it);
  }
  return items;
}

const clientSince = (r, b) => (b === BOOT && Number.isFinite(r) ? Math.max(0, r) : 0);

// Saves a finished load test into its request's history (also covers tests whose browser tab was closed).
function persistRun(run) {
  const rep = run.report;
  if (!rep || !run.cfg.tabId) return;
  mutate((st, touch) => {
    const tab = st.tabs.find((t) => t.id === run.cfg.tabId);
    if (!tab) return;
    const runs = Array.isArray(tab.loadRuns) ? tab.loadRuns : [];
    if (runs.some((r) => r.id === rep.id)) return;
    const stored = Object.assign({}, rep, { timeline: Kit.downsample(rep.timeline, 300), downsampled: rep.timeline.length > 300 });
    tab.loadRuns = [stored].concat(runs).slice(0, 8);
    touch('tab', tab.id, { fields: ['loadRuns'] });
  });
}

// ---------- routes ----------
const Load = require('./load.js')({
  prepare, runHops, friendlyError, decompress,
  onStart: (run) => broadcast({ type: 'load', tabId: run.cfg.tabId, id: run.id, origin: run.origin }),
  onFinish: persistRun,
});
const Agent = require('./agent.js')({ loadState, mutate, sendRequest, friendlyError, Load, broadcast, port: PORT, root: __dirname });

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedRequest(req)) { res.writeHead(403); return res.end('Forbidden'); }
    const u = new URL(req.url, 'http://localhost');

    if (u.pathname.startsWith('/api/load/')) return await Load.route(req, res, u, { readBody: (r) => readBody(r, MAX_BODY_IN), sendJson });
    if (await Agent.route(req, res, u, { readBody: (r) => readBody(r, MAX_BODY_IN), sendJson })) return;

    if (u.pathname === '/api/send' && req.method === 'POST') {
      const raw = await readBody(req, MAX_BODY_IN);
      let spec;
      try { spec = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: 'Bad JSON' }); }
      try { return sendJson(res, 200, await sendRequest(spec)); }
      catch (e) { return sendJson(res, 200, friendlyError(e)); }
    }

    if (u.pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, app: 'postwoman', uptime: Math.round(process.uptime()), boot: BOOT });

    if (u.pathname === '/api/state' && req.method === 'GET') {
      const s = loadState();
      return sendJson(res, 200, s || { empty: true }, { 'X-PW-Rev': String(rev), 'X-PW-Boot': BOOT });
    }
    if (u.pathname === '/api/state' && req.method === 'PUT') {
      const raw = await readBody(req, MAX_BODY_IN);
      let obj;
      try { obj = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: 'Bad JSON' }); }
      if (!looksLikeState(obj)) return sendJson(res, 400, { ok: false, error: 'Refusing to save: body is not a Postwoman state (expected an object with a "tabs" array)' });
      if (req.headers['x-pw-rev'] != null) { // page-aware save: keep agent changes the page hasn't seen yet
        const since = clientSince(Number(req.headers['x-pw-rev']), req.headers['x-pw-boot']);
        if (since < rev) { const cur = loadState(); if (cur) Sync.applyItems(obj, itemsSince(since, cur)); }
      }
      saveState(obj);
      return sendJson(res, 200, { ok: true, rev, boot: BOOT });
    }
    if (u.pathname === '/api/changes' && req.method === 'GET') {
      const since = clientSince(Number(u.searchParams.get('since')), u.searchParams.get('boot'));
      return sendJson(res, 200, { ok: true, boot: BOOT, rev, reset: since < trimmedRev, items: since < rev ? itemsSince(since, loadState()) : [] });
    }
    if (u.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\ndata: ' + JSON.stringify({ type: 'hello', rev, boot: BOOT }) + '\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // static files
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(u.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (rel.indexOf('\0') !== -1) { res.writeHead(400); return res.end('Bad request'); }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status || 500, { ok: false, error: e.message }, e.close ? { Connection: 'close' } : undefined);
    else res.end();
  }
});

// A stray rejection or socket error (we talk to arbitrary servers) must not kill a running load test.
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.stack || e));
process.on('uncaughtException', (e) => { console.error('Uncaught exception:', e && e.stack || e); });

function openBrowser(url) {
  const { spawn } = require('child_process');
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).on('error', () => {}).unref(); } catch { /* no browser available */ }
}

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') { console.error('Server error:', e.message); process.exit(1); }
  // Is it another Postwoman? Then just say so instead of crashing.
  http.get({ host: HOST, port: PORT, path: '/api/health', timeout: 1500 }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; });
    r.on('end', () => {
      let mine = false; try { mine = JSON.parse(b).app === 'postwoman'; } catch { /* not ours */ }
      if (mine) { console.log(`\n  Postwoman is already running  ->  http://localhost:${PORT}\n`); if (process.argv.includes('--open')) openBrowser(`http://localhost:${PORT}`); process.exit(0); }
      console.error(`\n  Port ${PORT} is in use by another program.\n  Pick a free one:  PORT=8080 node server.js   (Windows PowerShell: $env:PORT=8080; node server.js)\n`); process.exit(1);
    });
  }).on('error', () => { console.error(`\n  Port ${PORT} is in use by another program. Set PORT to a free port and try again.\n`); process.exit(1); });
});

backupState();
server.listen(PORT, HOST, () => {
  console.log(`\n  Postwoman running  ->  http://localhost:${PORT}\n  State file: ${STATE_FILE}\n  AI agents (MCP)    ->  http://127.0.0.1:${PORT}/mcp   (or: node ${path.join(__dirname, 'mcp.js')})\n`);
  if (process.argv.includes('--open')) openBrowser(`http://localhost:${PORT}`);
});
