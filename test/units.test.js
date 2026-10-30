'use strict';
// Pure-function tests: curl parser, stats, diff, load-test helpers, request builder.
const { test } = require('node:test');
const assert = require('node:assert');
const Curl = require('../public/curl.js');
const Stats = require('../public/stats.js');
const Diff = require('../public/diff.js');
const LoadKit = require('../public/loadkit.js');
const ReqSpec = require('../public/reqspec.js');

const hdr = (r, name) => (r.headers.find((h) => h.key.toLowerCase() === name.toLowerCase()) || {}).value;

// ---------------- curl ----------------
test('curl tokenizer: quotes, escapes, ANSI-C strings, line continuations', () => {
  assert.deepEqual(Curl.tokenize(`curl -H 'A: b c' "x y" z\\ w`), ['curl', '-H', 'A: b c', 'x y', 'z w']);
  assert.deepEqual(Curl.tokenize(`echo $'a\\nb\\u0041'`), ['echo', 'a\nbA']);
  assert.deepEqual(Curl.tokenize('curl \\\n  -X POST \\\r\n  http://x'), ['curl', '-X', 'POST', 'http://x']);
  assert.deepEqual(Curl.tokenize(`"say \\"hi\\""`), ['say "hi"']);
});

test('curl: looksLikeCurl accepts curl and curl.exe only', () => {
  assert.ok(Curl.looksLikeCurl('curl http://x'));
  assert.ok(Curl.looksLikeCurl('  CURL.EXE -s http://x'));
  assert.ok(Curl.looksLikeCurl('curl'));
  assert.ok(!Curl.looksLikeCurl('curlish http://x'));
  assert.ok(!Curl.looksLikeCurl('http://x'));
});

test('curl: method, headers, body and the implied POST', () => {
  const r = Curl.parseCurl(`curl -X PUT https://api.test/v1/x -H 'Content-Type: application/json' -H "X-A: 1" -d '{"a":1}'`);
  assert.equal(r.method, 'PUT'); assert.equal(r.url, 'https://api.test/v1/x'); assert.equal(r.body, '{"a":1}');
  assert.equal(hdr(r, 'content-type'), 'application/json'); assert.equal(hdr(r, 'x-a'), '1');
  const p = Curl.parseCurl(`curl https://x.test -d 'a=1&b=2'`);
  assert.equal(p.method, 'POST'); assert.equal(hdr(p, 'content-type'), 'application/x-www-form-urlencoded');
  assert.equal(Curl.parseCurl('curl https://x.test').method, 'GET');
});

test('curl: flag clusters, attached values, long options with =', () => {
  const r = Curl.parseCurl(`curl -sSL -XPOST -H'X-B: 2' --max-time=2.5 -k https://x.test`);
  assert.equal(r.followRedirects, true); assert.equal(r.insecure, true);
  assert.equal(r.method, 'POST'); assert.equal(hdr(r, 'x-b'), '2'); assert.equal(r.timeout, 2500);
});

test('curl: auth, cookies, user-agent, referer, bearer', () => {
  const r = Curl.parseCurl(`curl -u me:s3cret -b 'a=1; b=2' -A tester -e http://ref --oauth2-bearer tok https://x.test`);
  assert.equal(hdr(r, 'authorization') && r.headers.filter((h) => h.key === 'Authorization').length, 2); // basic + bearer, as given
  assert.ok(r.headers.some((h) => h.value === 'Basic ' + Buffer.from('me:s3cret').toString('base64')));
  assert.ok(r.headers.some((h) => h.value === 'Bearer tok'));
  assert.equal(hdr(r, 'cookie'), 'a=1; b=2'); assert.equal(hdr(r, 'user-agent'), 'tester'); assert.equal(hdr(r, 'referer'), 'http://ref');
});

test('curl: --json, -G, -I, --data-urlencode', () => {
  const j = Curl.parseCurl(`curl --json '{"a":1}' https://x.test`);
  assert.equal(j.method, 'POST'); assert.equal(hdr(j, 'content-type'), 'application/json'); assert.equal(hdr(j, 'accept'), 'application/json');
  const g = Curl.parseCurl(`curl -G -d a=1 -d b=2 https://x.test/p`);
  assert.equal(g.method, 'GET'); assert.equal(g.url, 'https://x.test/p?a=1&b=2'); assert.equal(g.body, '');
  const g2 = Curl.parseCurl(`curl -G -d a=1 'https://x.test/p?z=9'`); assert.equal(g2.url, 'https://x.test/p?z=9&a=1');
  assert.equal(Curl.parseCurl('curl -I https://x.test').method, 'HEAD');
  assert.equal(Curl.parseCurl(`curl --data-urlencode 'q=a b&c' https://x.test`).body, 'q=a%20b%26c');
});

test('curl: unsupported bits produce warnings instead of silent loss', () => {
  assert.ok(Curl.parseCurl(`curl -F 'f=@a.txt' https://x.test`).warnings.some((w) => /multipart/i.test(w)));
  assert.ok(Curl.parseCurl(`curl -d @body.json https://x.test`).warnings.some((w) => /file upload/i.test(w)));
  assert.ok(Curl.parseCurl(`curl https://a.test https://b.test`).warnings.some((w) => /multiple urls/i.test(w)));
  assert.equal(Curl.parseCurl(`curl https://a.test https://b.test`).url, 'https://a.test');
});

test('curl: toCurl output parses back to the same request (including single quotes)', () => {
  const req = { method: 'POST', url: "https://x.test/a?b='1'", headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }, { key: 'X-Off', value: 'no', enabled: false }], body: `{"name":"O'Brien"}` };
  const text = Curl.toCurl(req);
  assert.ok(!text.includes('X-Off'));
  const back = Curl.parseCurl(text);
  assert.equal(back.method, 'POST'); assert.equal(back.url, req.url); assert.equal(back.body, req.body);
  assert.equal(hdr(back, 'content-type'), 'application/json');
  assert.equal(Curl.toCurl({ method: 'HEAD', url: 'http://x' }).startsWith('curl -I '), true);
});

// ---------------- stats ----------------
test('stats: nearest-rank percentiles', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(Stats.percentile(s, 50), 50); assert.equal(Stats.percentile(s, 95), 95); assert.equal(Stats.percentile(s, 99), 99);
  assert.equal(Stats.percentile(s, 0), 1); assert.equal(Stats.percentile(s, 100), 100);
  assert.equal(Stats.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(Stats.percentile([], 50), null);
  assert.equal(Stats.percentile([42], 99), 42);
});

test('stats: summarize ignores failed requests for timing, counts them as errors', () => {
  const ok = (ms, status) => ({ ms, status: status || 200, ok: true });
  const sum = Stats.summarize([ok(10), ok(20), ok(30, 404), ok(40, 503), { ms: 5000, status: 0, ok: false }]);
  assert.equal(sum.count, 5); assert.equal(sum.timed, 4); assert.equal(sum.errors, 1);
  assert.equal(sum.min, 10); assert.equal(sum.max, 40); assert.equal(sum.avg, 25);
  assert.deepEqual(sum.codes, { 200: 2, 404: 1, 503: 1, ERR: 1 });
  assert.deepEqual(sum.classes, { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 1, err: 1 });
  assert.equal(Stats.summarize([]), null);
  const sd = Stats.summarize([ok(1), ok(2), ok(3)]).sd; assert.ok(Math.abs(sd - 1) < 1e-12);
  const allBad = Stats.summarize([{ ms: 1, status: 0, ok: false }]);
  assert.equal(allBad.avg, null); assert.equal(allBad.p99, null); assert.equal(allBad.errors, 1);
});

test('stats: histogram buckets add up', () => {
  const h = Stats.histogram([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.equal(h.length, 5); assert.equal(h.reduce((a, b) => a + b.count, 0), 10);
  assert.deepEqual(h.map((b) => b.count), [2, 2, 2, 2, 2]);
  assert.deepEqual(Stats.histogram([7, 7, 7], 10), [{ from: 7, to: 7, count: 3 }]);
  assert.deepEqual(Stats.histogram([], 10), []);
});

// ---------------- diff ----------------
test('diff: changed, added, removed and type changes with paths', () => {
  const d = Diff.diffJson({ a: 1, b: { c: [1, 2, 3] }, 'x-y': 1, t: 1, gone: true }, { a: 2, b: { c: [1, 2] }, 'x-y': 2, t: '1', fresh: 1 }).diffs;
  const by = Object.fromEntries(d.map((x) => [x.path, x.kind]));
  assert.deepEqual(by, { '$.a': 'changed', '$.b.c[2]': 'removed', '$["x-y"]': 'changed', '$.t': 'type', '$.gone': 'removed', '$.fresh': 'added' });
  assert.equal(Diff.diffJson([1, 2], [1, 2, 3]).diffs[0].kind, 'added');
  assert.equal(Diff.diffJson({ a: [1, { b: 1 }] }, { a: [1, { b: 1 }] }).diffs.length, 0);
  assert.equal(Diff.diffJson(NaN, NaN).diffs.length, 0);
  assert.equal(Diff.diffJson(null, {}).diffs[0].kind, 'type');
});

test('diff: ignore by key name anywhere or by full path, and the diff cap', () => {
  const a = { id: 1, meta: { ts: 1, keep: 1 }, items: [{ ts: 1 }] }, b = { id: 2, meta: { ts: 2, keep: 1 }, items: [{ ts: 9 }] };
  assert.equal(Diff.diffJson(a, b, { ignore: 'id, ts' }).diffs.length, 0);
  assert.deepEqual(Diff.diffJson(a, b, { ignore: 'meta.ts' }).diffs.map((x) => x.path).sort(), ['$.id', '$.items[0].ts']);
  assert.deepEqual([...Diff.parseIgnore('$.a, b\nc.d,,')], ['a', 'b', 'c.d']);
  const big = Array.from({ length: 50 }, (_, i) => i), big2 = big.map((x) => x + 1);
  const capped = Diff.diffJson(big, big2, { max: 10 }); assert.equal(capped.diffs.length, 10); assert.equal(capped.capped, true);
});

test('diff: text comparison counts changed lines and finds the first', () => {
  assert.deepEqual(Diff.diffText('a\nb', 'a\nb'), { equal: true, changedLines: 0 });
  const d = Diff.diffText('a\nb\nc', 'a\nX\nc\nd');
  assert.equal(d.equal, false); assert.equal(d.changedLines, 2); assert.equal(d.firstLine, 2); assert.equal(d.a, 'b'); assert.equal(d.b, 'X');
  assert.equal(Diff.diffText('a\r\nb', 'a\nb').equal, false, 'CRLF vs LF differ as raw strings');
  assert.equal(Diff.diffText('a\r\nb', 'a\nb').changedLines, 0, '...but no line differs once split');
});

// ---------------- load-test helpers ----------------
test('loadkit: CSV parsing (quotes, escaped quotes, CRLF, blank lines, embedded newlines)', () => {
  const r = LoadKit.parseCsv('name, age\r\n"Smith, J",30\r\n\r\n"He said ""hi""",4\n"multi\nline",5');
  assert.deepEqual(r.headers, ['name', 'age']);
  assert.deepEqual(r.rows, [['Smith, J', '30'], ['He said "hi"', '4'], ['multi\nline', '5']]);
  assert.deepEqual(LoadKit.parseCsv(''), { headers: [], rows: [] });
  assert.deepEqual(LoadKit.parseCsv('a,b').rows, []);
});

test('loadkit: success status rules', () => {
  const d = LoadKit.parseStatusRule(''); assert.ok(d.test(200) && d.test(399) && !d.test(400) && !d.test(199));
  const r = LoadKit.parseStatusRule('2xx, 404 500-503'); assert.ok(r.test(204) && r.test(404) && r.test(502) && !r.test(504) && !r.test(403));
  assert.match(LoadKit.parseStatusRule('abc').error, /Invalid success status "abc"/);
  assert.ok(LoadKit.parseStatusRule('399-200').error);
  assert.ok(LoadKit.parseStatusRule('6xx').error);
});

test('loadkit: ramp profile (JMeter-style start times) and planned duration', () => {
  const c = { mode: 'duration', users: 10, rampUp: 10, hold: 10, rampDown: 10 };
  assert.equal(LoadKit.plannedSeconds(c), 30);
  const at = (t) => LoadKit.targetUsers(c, t);
  assert.deepEqual([-1, 0, 5, 9.99, 10, 15, 20, 25, 29.9, 30, 99].map(at), [0, 1, 6, 10, 10, 10, 10, 5, 1, 0, 0]);
  assert.equal(LoadKit.plannedSeconds({ mode: 'iterations' }), null);
  assert.equal(LoadKit.targetUsers({ mode: 'iterations', users: 4, rampUp: 0 }, 0), 4);
  assert.equal(LoadKit.targetUsers({ mode: 'duration', users: 5, rampUp: 0, hold: 3, rampDown: 0 }, 2.9), 5);
  assert.equal(LoadKit.targetUsers({ mode: 'duration', users: 5, rampUp: 0, hold: 3, rampDown: 0 }, 3), 0);
  const pts = LoadKit.profilePoints(c, 30); assert.equal(pts.length, 31); assert.ok(pts.every(([, u]) => u >= 0 && u <= 10));
});

test('loadkit: downsample keeps totals, worst-case percentiles and the peak user count', () => {
  const tl = Array.from({ length: 10 }, (_, i) => ({ t: i, span: 1, users: i + 1, n: 10, err: i === 3 ? 2 : 0, avg: 10 + i, min: 5 + i, p50: 10, p90: 20, p95: 30, p99: 40 + i, max: 50 + i, kb: 1, kbs: 2, c2: 8, c3: 0, c4: 0, c5: 0, ce: 2 }));
  assert.equal(LoadKit.downsample(tl, 20), tl, 'short timelines are returned untouched');
  const d = LoadKit.downsample(tl, 5); // groups of 2
  assert.equal(d.length, 5);
  assert.equal(d.reduce((a, b) => a + b.n, 0), 100); assert.equal(d.reduce((a, b) => a + b.err, 0), 2);
  assert.equal(d[0].users, 2); assert.equal(d[0].p99, 41); assert.equal(d[0].min, 5); assert.equal(d[0].span, 2);
  assert.ok(Math.abs(d[0].avg - 10.5) < 1e-9);
});

test('loadkit: nines axis round-trips', () => {
  assert.ok(Math.abs(LoadKit.nines(90) - 1) < 1e-9 && Math.abs(LoadKit.nines(99) - 2) < 1e-9 && LoadKit.nines(0) === 0);
  for (const p of [50, 90, 99, 99.9]) assert.ok(Math.abs(LoadKit.fromNines(LoadKit.nines(p)) - p) < 1e-9, String(p));
});

// ---------------- request builder ----------------
test('reqspec: interpolate replaces known, reports unknown, supports dynamic values', () => {
  const missing = new Set();
  assert.equal(ReqSpec.interpolate('{{ host }}/a/{{id}}/{{nope}}', { host: 'h', id: '7' }, missing), 'h/a/7/{{nope}}');
  assert.deepEqual([...missing], ['nope']);
  assert.match(ReqSpec.interpolate('{{$uuid}}', {}), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(ReqSpec.interpolate('{{$timestamp}}', {}), /^\d{10}$/);
  assert.match(ReqSpec.interpolate('{{$isoTimestamp}}', {}), /^\d{4}-\d\d-\d\dT/);
  assert.ok(Number(ReqSpec.interpolate('{{$randomInt}}', {})) <= 1000);
  assert.equal(ReqSpec.interpolate('no vars', {}), 'no vars');
  assert.equal(ReqSpec.interpolate('{{constructor}}', {}, new Set()), '{{constructor}}', 'prototype keys are not variables');
});

test('reqspec: buildSpec resolves variables, auth, content type, and skips disabled headers', () => {
  const tab = {
    method: 'post', url: '{{base}}/x', bodyType: 'json', body: '{"u":"{{user}}"}',
    headers: [{ key: 'X-On', value: '{{user}}', enabled: true }, { key: 'X-Off', value: 'z', enabled: false }, { key: '', value: 'blank' }],
    auth: { type: 'bearer', token: '{{tok}}' }, settings: { timeout: 5000, follow: true, insecure: false },
  };
  const s = ReqSpec.buildSpec(tab, { base: 'http://h', user: 'bob', tok: 'T' }, new Set());
  assert.equal(s.method, 'POST'); assert.equal(s.url, 'http://h/x'); assert.equal(s.body, '{"u":"bob"}');
  assert.deepEqual(s.headers, [{ key: 'X-On', value: 'bob' }, { key: 'Authorization', value: 'Bearer T' }, { key: 'Content-Type', value: 'application/json' }]);
  assert.equal(s.timeout, 5000); assert.equal(s.followRedirects, true);
});

test('reqspec: basic auth (plain and load mode), explicit Authorization wins, GET never has a body', () => {
  const basic = { method: 'GET', url: 'http://h', bodyType: 'none', headers: [], auth: { type: 'basic', user: 'u', pass: 'p' } };
  assert.equal(ReqSpec.buildSpec(basic, {}).headers[0].value, 'Basic ' + Buffer.from('u:p').toString('base64'));
  const load = ReqSpec.buildSpec(basic, {}, null, { forLoad: true });
  assert.deepEqual(load.basicAuth, { user: 'u', pass: 'p' }); assert.equal(load.headers.length, 0);
  const explicit = ReqSpec.buildSpec(Object.assign({}, basic, { headers: [{ key: 'authorization', value: 'mine' }] }), {});
  assert.deepEqual(explicit.headers, [{ key: 'authorization', value: 'mine' }]);
  const get = ReqSpec.buildSpec({ method: 'GET', url: 'http://h', bodyType: 'json', body: '{"a":1}', headers: [] }, {});
  assert.equal(get.body, null); assert.equal(get.headers.length, 0);
});

test('reqspec: guessBodyType and pickPath', () => {
  assert.equal(ReqSpec.guessBodyType('', []), 'none');
  assert.equal(ReqSpec.guessBodyType('a=1', [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }]), 'form');
  assert.equal(ReqSpec.guessBodyType('{"a":1}', []), 'json');
  assert.equal(ReqSpec.guessBodyType('hello', []), 'text');
  const o = { data: { items: [{ id: 5, 'a b': 'x' }] } };
  assert.equal(ReqSpec.pickPath(o, 'data.items[0].id'), 5);
  assert.equal(ReqSpec.pickPath(o, '$.data.items[0]["a b"]'), 'x');
  assert.equal(ReqSpec.pickPath(o, 'data.missing.deep'), undefined);
});

// ---------------- response checks ("Tests") ----------------
const Checks = require('../public/checks.js');
const mkRes = (over) => Object.assign({
  ok: true, status: 201, isText: true, size: 120, timings: { total: 120.4 },
  headers: [['Content-Type', 'application/json; charset=utf-8'], ['Set-Cookie', 'a=1'], ['set-cookie', 'b=2']],
  body: JSON.stringify({ data: { id: 7, name: 'Ada', tags: ['x', 'y'], active: true, score: '3.5', n: null }, items: [{ id: 1 }, { id: 2 }] }),
}, over);
const T = (type, op, target, value) => ({ type, op, target, value, enabled: true });
const pass = (t, over, map) => { const r = Checks.evaluate([t], mkRes(over), map)[0]; return r.pass; };
const result = (t, over, map) => Checks.evaluate([t], mkRes(over), map)[0];

test('checks: status rules reuse the load-test syntax and report bad input', () => {
  assert.equal(pass(T('status', 'is', '', '2xx')), true);
  assert.equal(pass(T('status', 'is', '', '200')), false);
  assert.equal(pass(T('status', 'is', '', '200-299, 404')), true);
  assert.match(result(T('status', 'is', '', 'abc')).error, /Invalid success status/);
  assert.match(result(T('status', 'is', '', '')).error, /Enter a status/);
  assert.equal(result(T('status', 'is', '', '2xx')).actual, '201');
});

test('checks: response time limits', () => {
  assert.equal(pass(T('time', 'lte', '', '500')), true);
  assert.equal(pass(T('time', 'lte', '', '100')), false);
  assert.equal(pass(T('time', 'lt', '', '120.4')), false);
  assert.equal(pass(T('time', 'lte', '', '120.4')), true);
  assert.match(result(T('time', 'lte', '', 'fast')).error, /number of milliseconds/);
});

test('checks: headers are case-insensitive and repeated headers are joined', () => {
  assert.equal(pass(T('header', 'contains', 'content-type', 'json')), true);
  assert.equal(pass(T('header', 'exists', 'X-Nope', '')), false);
  assert.equal(pass(T('header', 'notExists', 'X-Nope', '')), true);
  assert.equal(pass(T('header', 'equals', 'SET-COOKIE', 'a=1, b=2')), true);
  assert.equal(pass(T('header', 'matches', 'content-type', '^application/(json|xml)')), true);
  assert.equal(result(T('header', 'exists', 'X-Nope', '')).actual, 'missing');
  assert.match(result(T('header', 'exists', '', '')).error, /header name/);
});

test('checks: JSON paths, equality rules, types, numbers and regexes', () => {
  const j = (op, target, value) => pass(T('json', op, target, value));
  assert.ok(j('equals', 'data.id', '7')); assert.ok(j('equals', 'data.name', 'Ada')); assert.ok(j('equals', 'data.name', '"Ada"'));
  assert.ok(j('equals', 'data.active', 'true')); assert.ok(j('equals', 'data.n', 'null')); assert.ok(j('equals', 'items[1].id', '2'));
  assert.ok(j('equals', 'data.tags', '["x","y"]')); assert.ok(!j('equals', 'data.tags', '["y","x"]')); assert.ok(!j('equals', 'data.id', '8'));
  assert.ok(j('notEquals', 'data.id', '8')); assert.ok(!j('notEquals', 'data.id', '7'));
  assert.ok(j('exists', 'data.n'), 'null counts as existing'); assert.ok(!j('exists', 'data.missing')); assert.ok(j('notExists', 'data.missing'));
  assert.ok(j('contains', 'data.tags', 'x')); assert.ok(!j('contains', 'data.tags', 'z')); assert.ok(j('contains', 'data.name', 'd'));
  assert.ok(j('matches', 'data.name', '^A')); assert.ok(!j('matches', 'data.name', '^B'));
  assert.ok(j('gt', 'data.score', '3')); assert.ok(j('lte', 'data.id', '7')); assert.ok(!j('lt', 'data.id', '7')); assert.ok(!j('gt', 'data.name', '3'), 'non-numbers never compare');
  assert.ok(j('type', 'data.tags', 'array')); assert.ok(j('type', 'data', 'object')); assert.ok(j('type', 'data.n', 'null')); assert.ok(j('type', 'data.id', 'Number'));
  assert.equal(result(T('json', 'equals', 'data.id', '8')).actual, '7');
  assert.equal(result(T('json', 'exists', 'nope', '')).actual, 'missing');
});

test('checks: body text, non-JSON bodies, invalid regexes and unknown ops fail with a reason', () => {
  assert.ok(pass(T('body', 'contains', '', '"Ada"'))); assert.ok(pass(T('body', 'notContains', '', 'Grace'))); assert.ok(pass(T('body', 'matches', '', '"id":\\s*7')));
  assert.match(result(T('body', 'contains', '', 'x'), { isText: false }).error, /not text/);
  assert.match(result(T('json', 'exists', 'a', ''), { body: '<html>' }).error, /not JSON/);
  assert.match(result(T('json', 'matches', 'data.name', '[')).error, /Invalid regular expression/);
  assert.match(result(T('json', 'exists', '', '')).error, /JSON path/);
  assert.match(result({ type: 'json', op: 'explode', target: 'a', value: '' }).error, /Invalid check/);
  assert.match(result({ type: 'sql', op: 'is', value: '' }).error, /Invalid check/);
});

test('checks: {{variables}} work in targets and values; disabled checks are skipped; failed requests fail every check', () => {
  assert.ok(pass(T('json', 'equals', 'data.{{field}}', '{{want}}'), {}, { field: 'id', want: '7' }));
  assert.ok(pass(T('time', 'lte', '', '{{limit}}'), {}, { limit: '1000' }));
  const off = Object.assign(T('status', 'is', '', '500'), { enabled: false });
  assert.equal(Checks.evaluate([off, T('status', 'is', '', '2xx')], mkRes()).length, 1);
  const dead = Checks.evaluate([T('status', 'is', '', '2xx'), T('time', 'lte', '', '5')], { ok: false, error: 'Connection refused' });
  assert.deepEqual(dead.map((r) => r.pass), [false, false]); assert.match(dead[0].error, /No response: Connection refused/);
  assert.deepEqual(Checks.summarize([{ pass: true }, { pass: false }, { pass: true }]), { total: 3, passed: 2, failed: 1 });
});

test('checks: labels read like sentences and every type has a working default', () => {
  assert.equal(Checks.label(T('status', 'is', '', '2xx')), 'Status is 2xx');
  assert.equal(Checks.label(T('time', 'lte', '', '500')), 'Response time ≤ 500 ms');
  assert.equal(Checks.label(T('json', 'equals', 'data.id', '7')), 'JSON data.id equals 7');
  assert.equal(Checks.label(T('json', 'exists', 'data.id', '')), 'JSON data.id exists');
  assert.equal(Checks.label(T('header', 'contains', 'Content-Type', 'json')), 'Header Content-Type contains json');
  assert.equal(Checks.label(T('body', 'notContains', '', 'oops')), 'Body does not contain oops');
  for (const type of Object.keys(Checks.TYPES)) { const t = Checks.make(type); assert.ok(Checks.TYPES[type].ops.includes(t.op), type); assert.ok(t.id && t.enabled); }
});

test('checks: shown values are quoted for text and bare for numbers', () => {
  assert.equal(result(T('json', 'equals', 'data.name', 'x')).actual, '"Ada"');
  assert.equal(result(T('json', 'equals', 'data.id', '8')).actual, '7');
  assert.equal(result(T('header', 'equals', 'content-type', 'x')).actual, '"application/json; charset=utf-8"');
});
