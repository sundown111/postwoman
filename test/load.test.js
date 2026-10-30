'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp, startUpstream, sleep } = require('./helpers');
const Stats = require('../public/stats.js');

let app, up;
before(async () => { up = await startUpstream(); app = await startApp(); });
after(async () => { await app.stop(); await up.close(); });

const spec = (path, extra) => Object.assign({ method: 'GET', url: up.url + path, headers: [], body: null }, extra);

async function start(body) {
  const r = await app.post('/api/load/start', body);
  return { status: r.status, body: await r.json() };
}
async function waitDone(id, ms) {
  const t0 = Date.now();
  for (;;) {
    const s = await app.json('/api/load/status?id=' + id);
    if (s.state === 'done') return s;
    if (Date.now() - t0 > (ms || 30000)) throw new Error('load test did not finish: ' + JSON.stringify({ state: s.state, elapsed: s.elapsed }));
    await sleep(100);
  }
}
async function run(body) {
  const s = await start(body);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  await waitDone(s.body.id);
  const rep = await app.json('/api/load/report?id=' + s.body.id);
  assert.equal(rep.ok, true, JSON.stringify(rep));
  return { id: s.body.id, report: rep.report };
}

test('input validation returns 400 with a useful message', async () => {
  const bad = async (body, re) => { const r = await start(body); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, re); };
  await bad({}, /Missing request/);
  await bad({ spec: spec('/echo'), status: 'abc', mode: 'iterations' }, /Invalid success status/);
  await bad({ spec: spec('/echo'), mode: 'duration', hold: 0, rampUp: 0 }, /hold time/i);
  await bad({ spec: spec('/echo'), mode: 'iterations', csv: 'a,b' }, /header row but no data/i);
  await bad({ spec: { method: 'GET', url: 'ftp://nope' }, mode: 'iterations' }, /./);
  assert.equal((await app.json('/api/load/active')).id, null, 'a rejected start must not leave a run behind');
});

test('iterations mode: exact sample count, percentiles agree with the raw .jtl export', async () => {
  const { id, report: r } = await run({ spec: spec('/jitter'), mode: 'iterations', users: 4, iterations: 25, status: '200-599' });
  assert.equal(r.count, 100); assert.equal(r.exact, true); assert.equal(r.reason, 'completed');
  assert.equal(r.codes.reduce((a, c) => a + c.n, 0), 100);
  assert.ok(r.maxUsers >= 1 && r.maxUsers <= 4);

  const jtl = await (await fetch(app.base + '/api/load/jtl?id=' + id)).text();
  const lines = jtl.trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'timeStamp'); assert.equal(lines.length, 101);
  const col = lines[0].split(',');
  const iEl = col.indexOf('elapsed'), iCode = col.indexOf('responseCode'), iOk = col.indexOf('success');
  const el = lines.slice(1).map((l) => Number(l.split(',')[iEl])).sort((a, b) => a - b);
  for (const [name, p] of [['p50', 50], ['p95', 95], ['p99', 99]]) {
    assert.ok(Math.abs(Stats.percentile(el, p) - r.el[name]) <= 1, name + ': jtl=' + Stats.percentile(el, p) + ' report=' + r.el[name]);
  }
  assert.equal(lines.slice(1).filter((l) => l.split(',')[iOk] === 'true').length, r.okCount);
  assert.equal(lines.slice(1).filter((l) => l.split(',')[iCode] === '200').length, (r.codes.find((c) => c.code === '200') || { n: 0 }).n);
  assert.ok(r.el.min <= r.el.p50 && r.el.p50 <= r.el.p95 && r.el.p95 <= r.el.p99 && r.el.p99 <= r.el.max);
});

test('per-user variables and CSV data are substituted into each request', async () => {
  const before = up.hits.length;
  const { report: r } = await run({
    spec: spec('/echo?vu={{$vu}}&it={{$iteration}}&name={{name}}&id={{$uuid}}'),
    mode: 'iterations', users: 2, iterations: 3, csv: 'name\nalice\nbob\ncarol',
  });
  assert.equal(r.count, 6);
  const mine = up.hits.slice(before).map((h) => new URL(h.url, 'http://x').searchParams);
  assert.equal(mine.length, 6);
  assert.deepEqual([...new Set(mine.map((q) => q.get('vu')))].sort(), ['1', '2']);
  assert.deepEqual([...new Set(mine.map((q) => q.get('it')))].sort(), ['1', '2', '3']);
  const names = mine.map((q) => q.get('name'));
  assert.deepEqual([...new Set(names)].sort(), ['alice', 'bob', 'carol']);
  assert.equal(names.filter((n) => n === 'alice').length, 2, 'CSV rows are shared by all users and recycled at the end');
  assert.equal(new Set(mine.map((q) => q.get('id'))).size, 6, '{{$uuid}} is fresh for every request');
});

test('basic auth parts are encoded per request', async () => {
  const before = up.hits.length;
  await run({ spec: spec('/echo', { basicAuth: { user: 'u-{{$vu}}', pass: 'p' } }), mode: 'iterations', users: 1, iterations: 1 });
  assert.equal(up.hits[before].headers.authorization, 'Basic ' + Buffer.from('u-1:p').toString('base64'));
});

test('assertions: status rule and body-contains decide success', async () => {
  const base = { mode: 'iterations', users: 2, iterations: 5 };
  let r = (await run(Object.assign({ spec: spec('/status?c=404'), status: '200' }, base))).report;
  assert.equal(r.errors, 10); assert.equal(r.okCount, 0); assert.match(r.errorsList[0].key, /Status 404 not in 200/);
  r = (await run(Object.assign({ spec: spec('/status?c=404'), status: '404' }, base))).report;
  assert.equal(r.errors, 0);
  r = (await run(Object.assign({ spec: spec('/text'), contains: 'hello-world-marker' }, base))).report;
  assert.equal(r.errors, 0);
  r = (await run(Object.assign({ spec: spec('/text'), contains: 'not-there' }, base))).report;
  assert.equal(r.errors, 10); assert.match(r.errorsList[0].key, /does not contain/);
  r = (await run(Object.assign({ spec: spec('/slow?ms=60'), maxMs: 20 }, base))).report;
  assert.equal(r.errors, 10); assert.match(r.errorsList[0].key, /Slower than 20 ms/);
});

test('connection errors are counted as errors with a friendly reason', async () => {
  const { report: r } = await run({ spec: { method: 'GET', url: 'http://127.0.0.1:1/' }, mode: 'iterations', users: 2, iterations: 3 });
  assert.equal(r.count, 6); assert.equal(r.errors, 6); assert.equal(r.okCount, 0);
  assert.match(r.errorsList[0].key, /ECONNREFUSED/);
  assert.equal(r.el.min !== undefined, true);
});

test('SLA verdict is "pass" or "fail" per the configured limits', async () => {
  const base = { spec: spec('/slow?ms=60'), mode: 'iterations', users: 2, iterations: 5 };
  const bad = (await run(Object.assign({ sla: { p95: 10 } }, base))).report;
  assert.equal(bad.verdict, 'fail'); assert.equal(bad.sla[0].pass, false);
  const good = (await run(Object.assign({ sla: { p95: 5000, errPct: 1 } }, base))).report;
  assert.equal(good.verdict, 'pass'); assert.equal(good.sla.length, 2);
  assert.equal((await run(base)).report.verdict, null, 'no limits configured => no verdict');
});

test('think time slows each user down', async () => {
  const { report: r } = await run({ spec: spec('/echo'), mode: 'iterations', users: 1, iterations: 5, thinkMs: 80 });
  assert.equal(r.count, 5);
  assert.ok(r.duration >= 0.3, 'expected at least 4 think gaps (~0.32s), got ' + r.duration);
});

test('max RPS caps throughput (duration mode)', async () => {
  const { report: r } = await run({ spec: spec('/echo'), mode: 'duration', users: 4, hold: 2, maxRps: 20 });
  assert.ok(r.count >= 28 && r.count <= 44, 'expected ~40 requests at 20 rps for 2s, got ' + r.count);
  assert.ok(r.rps <= 24, 'rps ' + r.rps);
});

test('only one test at a time; stop ends it and still produces a report', async () => {
  const s1 = await start({ spec: spec('/slow?ms=100'), mode: 'duration', users: 2, hold: 30 });
  assert.equal(s1.status, 200);
  const s2 = await start({ spec: spec('/echo'), mode: 'iterations', users: 1, iterations: 1 });
  assert.equal(s2.status, 409); assert.match(s2.body.error, /already running/i);
  assert.equal((await app.json('/api/load/active')).id, s1.body.id);
  assert.equal((await app.json('/api/load/report?id=' + s1.body.id)).ok, false, 'report is refused while running');
  await sleep(400);
  await app.post('/api/load/stop?id=' + s1.body.id, {});
  const st = await waitDone(s1.body.id, 10000);
  assert.equal(st.reason, 'stopped');
  const rep = (await app.json('/api/load/report?id=' + s1.body.id)).report;
  assert.ok(rep.count >= 2 && rep.count < 50, 'count ' + rep.count);
  assert.equal(rep.reason, 'stopped');
  assert.equal((await app.json('/api/load/active')).id, null);
});

test('unknown run ids give 404', async () => {
  const r = await fetch(app.base + '/api/load/status?id=nope'); assert.equal(r.status, 404);
});

test('the engine only keeps the last few runs in memory', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await run({ spec: spec('/echo'), mode: 'iterations', users: 1, iterations: 1 })).id);
  const alive = [];
  for (const id of ids) alive.push((await fetch(app.base + '/api/load/status?id=' + id)).status);
  assert.deepEqual(alive.slice(-3), [200, 200, 200], 'the newest runs stay available');
  assert.equal(alive[0], 404, 'the oldest run was evicted: ' + alive);
});

test('{{constructor}} and other prototype names are not treated as variables', async () => {
  const before = up.hits.length;
  await run({ spec: spec('/echo?c={{constructor}}&t={{toString}}'), mode: 'iterations', users: 1, iterations: 1 });
  const url = up.hits[before].url;
  assert.ok(!url.includes('object'), url);
  assert.ok(decodeURIComponent(url).includes('{{constructor}}'), 'left untouched: ' + url);
});
