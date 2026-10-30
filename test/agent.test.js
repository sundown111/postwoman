'use strict';
// AI-agent surface: REST tools, MCP (Streamable HTTP + stdio bridge), masking, live workspace changes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const { startApp, startUpstream, freePort } = require('./helpers');

const SECRET = 'S3CRET-VALUE-123456';
const BEARER = 'abcdefghijklmnopqrstuvwxyz';
let app, up;

const mk = (o) => Object.assign({
  id: '', name: '', groupId: null, tags: [], method: 'GET', url: '', headers: [], bodyType: 'none', body: '',
  auth: { type: 'none', token: '', user: '', pass: '' }, settings: { timeout: 30000, follow: true, insecure: false }, captures: [], samples: [],
}, o);

before(async () => {
  up = await startUpstream();
  const v = (key, value, secret) => ({ key, value, secret: !!secret, enabled: true });
  app = await startApp({
    state: {
      v: 1, activeTabId: null, activeEnvId: 'eA',
      groups: [{ id: 'g1', name: 'Auth flow', color: '#7c5cff', collapsed: false }],
      envs: [
        { id: 'globals', name: 'Globals', vars: [] },
        { id: 'eA', name: 'Alpha', vars: [v('base', up.url + '/echo?x=1'), v('secret', SECRET, true)] },
        { id: 'eB', name: 'Beta', vars: [v('base', up.url + '/echo?x=2'), v('secret', SECRET, true)] },
      ],
      tabs: [
        mk({ id: 't_echo', name: 'Echo', url: '{{base}}', tags: ['smoke', 'echo'], groupId: 'g1' }),
        mk({ id: 't_login', name: 'Login', url: up.url + '/token?n=1', method: 'POST', captures: [{ key: 'tok', value: 'data.access_token' }], groupId: 'g1', tags: ['auth'], tests: [{ id: 'k1', enabled: true, type: 'status', op: 'is', target: '', value: '2xx' }, { id: 'k2', enabled: true, type: 'json', op: 'equals', target: 'data.user.id', value: '7' }, { id: 'k3', enabled: true, type: 'json', op: 'equals', target: 'data.access_token', value: 'wrong' }, { id: 'k4', enabled: false, type: 'status', op: 'is', target: '', value: '500' }] }),
        mk({ id: 't_need', name: 'Needs token', url: up.url + '/needs-token', headers: [{ key: 'Authorization', value: 'Bearer {{tok}}', enabled: true }], tags: ['auth'] }),
        mk({ id: 't_secure', name: 'Secure', url: up.url + '/echo', auth: { type: 'bearer', token: BEARER, user: '', pass: '' }, headers: [{ key: 'Authorization', value: 'Bearer ' + BEARER + '123456', enabled: true }] }),
        mk({ id: 't_secret', name: 'Uses secret', url: up.url + '/echo', headers: [{ key: 'X-S', value: '{{secret}}', enabled: true }] }),
      ],
    },
  });
});
after(async () => { await app.stop(); await up.close(); });

const tool = async (name, args) => { const r = await app.post('/api/tools/' + name, args || {}); return { status: r.status, body: await r.json() }; };
const okTool = async (name, args) => { const r = await tool(name, args); assert.equal(r.status, 200, name + ': ' + JSON.stringify(r.body)); assert.equal(r.body.ok, true, JSON.stringify(r.body)); return r.body.result; };
const rpc = async (msg, sid) => {
  const r = await fetch(app.base + '/mcp', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, sid ? { 'Mcp-Session-Id': sid } : {}), body: JSON.stringify(msg) });
  const text = await r.text();
  return { status: r.status, sid: r.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null };
};

// ---------- discovery ----------
test('13 tools are exposed identically over REST, OpenAPI and MCP', async () => {
  const names = ['list_requests', 'get_request', 'send_request', 'compare_environments', 'run_load_test', 'get_load_test', 'stop_load_test', 'get_latency_stats', 'list_environments', 'set_variable', 'create_request', 'update_request', 'delete_request'];
  const rest = (await app.json('/api/tools')).tools; assert.deepEqual(rest.map((t) => t.name).sort(), names.slice().sort());
  for (const t of rest) { assert.equal(t.inputSchema.type, 'object', t.name); assert.ok(t.description.length > 20, t.name); }
  const oa = await app.json('/openapi.json'); assert.equal(oa.openapi, '3.1.0');
  assert.deepEqual(Object.keys(oa.paths).sort(), names.map((n) => '/api/tools/' + n).sort());
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-agent' } } });
  assert.ok(init.sid); assert.equal(init.body.result.serverInfo.name, 'postwoman'); assert.equal(init.body.result.protocolVersion, '2025-06-18');
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sid);
  assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), names.slice().sort());
  assert.equal(list.body.result.tools.find((t) => t.name === 'delete_request').annotations.destructiveHint, true);
  assert.equal(list.body.result.tools.find((t) => t.name === 'list_requests').annotations.readOnlyHint, true);
});

test('MCP protocol edge cases', async () => {
  const unknownProto = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknownProto.body.result.protocolVersion, '2025-06-18', 'falls back to the newest version we speak');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.deepEqual((await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' })).body.result, {});
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'nope/nothing' })).body.error.code, -32601);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ghost' } })).body.error.code, -32602);
  assert.equal((await rpc({ id: 8, method: 'ping' })).body.error.code, -32600);
  const batch = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.equal(batch.body.length, 2);
  const bad = await fetch(app.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, -32700);
  assert.equal((await fetch(app.base + '/mcp')).status, 405);
  const c = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_request', arguments: { request: 'no-such-thing' } } });
  assert.equal(c.body.result.isError, true); assert.match(c.body.result.content[0].text, /No saved request matches/);
  const good = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_requests', arguments: {} } });
  assert.equal(good.body.result.isError, false); assert.equal(JSON.parse(good.body.result.content[0].text).count, 5);
});

// ---------- read-only tools ----------
test('list_requests filters by text, tag and group', async () => {
  const all = await okTool('list_requests'); assert.equal(all.count, 5);
  assert.deepEqual(all.environments, ['Alpha', 'Beta']); assert.equal(all.active_environment, 'Alpha'); assert.deepEqual(all.groups, ['Auth flow']);
  assert.deepEqual((await okTool('list_requests', { tag: '#auth' })).requests.map((r) => r.name).sort(), ['Login', 'Needs token']);
  assert.deepEqual((await okTool('list_requests', { group: 'auth' })).requests.map((r) => r.name).sort(), ['Echo', 'Login']);
  assert.equal((await okTool('list_requests', { query: 'needs-token' })).count, 1);
  assert.equal((await okTool('list_requests', { limit: 2 })).requests.length, 2);
});

test('get_request masks secrets but still reports which variables exist', async () => {
  const s = await okTool('get_request', { request: 'Secure' });
  assert.equal(s.auth.token, '••••wxyz');
  assert.equal(s.headers[0].value, 'Bearer ••••3456');
  assert.ok(!JSON.stringify(s).includes(BEARER));
  const n = await okTool('get_request', { request: 'Needs token' });
  assert.equal(n.headers[0].value, 'Bearer {{tok}}', 'variable references are not secrets');
  assert.deepEqual(n.variables_used, [{ name: 'tok', defined_in_active_environment: false }]);
  const e = await okTool('get_request', { request: 'echo' }); // case-insensitive name
  assert.deepEqual(e.variables_used, [{ name: 'base', defined_in_active_environment: true }]);
  assert.equal(e.active_environment, 'Alpha');
});

test('list_environments never reveals secret values', async () => {
  const r = await okTool('list_environments');
  assert.ok(!JSON.stringify(r).includes(SECRET));
  const alpha = r.environments.find((x) => x.name === 'Alpha');
  assert.equal(alpha.variables.find((x) => x.name === 'secret').value, '••••'); assert.equal(alpha.active, true);
  assert.ok(r.dynamic_variables.includes('{{$uuid}}'));
});

// ---------- sending ----------
test('send_request: saved request, environment override, json_path, recorded sample', async () => {
  const a = await okTool('send_request', { request: 'Echo' });
  assert.equal(a.status, 200); assert.equal(a.request.environment, 'Alpha'); assert.ok(a.request.url.endsWith('/echo?x=1'));
  assert.ok(a.timings_ms.total > 0); assert.equal(a.body_format, 'json');
  const b = await okTool('send_request', { request: 'Echo', environment: 'Beta', json_path: 'url', include_headers: false });
  assert.equal(b.request.environment, 'Beta'); assert.equal(b.json_path_found, true); assert.equal(JSON.parse(b.body), '/echo?x=2'); assert.equal(b.headers, undefined);
  const miss = await okTool('send_request', { request: 'Echo', json_path: 'does.not.exist' }); assert.equal(miss.json_path_found, false);
  const stats = await okTool('get_latency_stats', { request: 'Echo' });
  assert.equal(stats.summary_ms.count, 3); assert.ok(stats.summary_ms.p95 >= stats.summary_ms.p50);
  assert.equal(stats.status_codes['200'], 3); assert.equal(stats.recent.length, 3);
  const quiet = await okTool('send_request', { request: 'Echo', record: false });
  assert.equal(quiet.status, 200); assert.equal((await okTool('get_latency_stats', { request: 'Echo' })).summary_ms.count, 3);
});

test('send_request: captures feed the next request in the chain', async () => {
  const pre = await tool('send_request', { request: 'Needs token' }); assert.equal(pre.status, 200); assert.equal(pre.body.ok, false, 'envelope flags the failure');
  const before = pre.body.result; assert.equal(before.ok, false, 'tok is not defined yet');
  assert.match(before.error, /\{\{tok\}\}/); assert.equal(before.missing_variables[0].variable, 'tok');
  const login = await okTool('send_request', { request: 'Login' });
  assert.equal(login.status, 200); assert.deepEqual(login.captured_variables, [{ variable: 'tok', environment: 'Alpha' }]);
  assert.deepEqual({ total: login.tests.total, passed: login.tests.passed, failed: login.tests.failed }, { total: 3, passed: 2, failed: 1 }, 'disabled checks are not run');
  assert.deepEqual(login.tests.results.map((r) => [r.check, r.pass]), [['Status is 2xx', true], ['JSON data.user.id equals 7', true], ['JSON data.access_token equals wrong', false]]);
  assert.equal(login.tests.results[2].got, '"tok-1"');
  assert.equal((await okTool('get_request', { request: 'Login' })).tests.length, 4);

  const after = await okTool('send_request', { request: 'Needs token' });
  assert.equal(after.status, 200); assert.equal(JSON.parse(after.body).ok, true);
  const alpha = (await app.state()).envs.find((e) => e.id === 'eA'); assert.equal(alpha.vars.find((x) => x.key === 'tok').value, 'tok-1');
});

test('send_request: secrets are used on the wire but not revealed in listings', async () => {
  const n = up.hits.length;
  const r = await okTool('send_request', { request: 'Uses secret' });
  assert.equal(r.status, 200); assert.equal(up.hits[n].headers['x-s'], SECRET, 'upstream receives the real value');
});

test('send_request: ad-hoc url, curl command, per-call variables, friendly failures', async () => {
  const adhoc = await okTool('send_request', { url: up.url + '/echo?a={{v}}', variables: { v: '42' }, method: 'post', body: { k: 1 } });
  const b = JSON.parse(adhoc.body); assert.equal(b.method, 'POST'); assert.equal(b.url, '/echo?a=42'); assert.equal(b.body, '{"k":1}'); assert.equal(b.headers['content-type'], 'application/json');
  const curl = await okTool('send_request', { curl: `curl -X PUT '${up.url}/echo' -H 'X-Hi: yo' -d 'x=1' -F 'f=@z'` });
  assert.equal(JSON.parse(curl.body).method, 'PUT'); assert.equal(JSON.parse(curl.body).headers['x-hi'], 'yo'); assert.ok(curl.curl_warnings.length);
  const refused = (await tool('send_request', { url: 'http://127.0.0.1:1/' })).body.result; assert.equal(refused.ok, false); assert.equal(refused.code, 'ECONNREFUSED');
  const undef = await tool('send_request', { url: 'http://x.invalid/{{nope}}' });
  assert.equal(undef.status, 200); assert.equal(undef.body.ok, false); assert.equal(undef.body.result.missing_variables[0].variable, 'nope');
  assert.equal((await tool('send_request', {})).status, 400);
  assert.equal((await tool('send_request', { curl: 'wget http://x' })).status, 400);
});

test('compare_environments: finds the field differences and honours ignore_fields', async () => {
  const r = await okTool('compare_environments', { request: 'Echo', rounds: 2 });
  assert.equal(r.rounds, 2); assert.equal(r.performance.length, 2); assert.ok(['Alpha', 'Beta'].includes(r.fastest));
  for (const p of r.performance) { assert.equal(p.successful, 2); assert.deepEqual(p.statuses, [200]); assert.ok(p.response_time_ms.p95 >= p.response_time_ms.min); }
  const c = r.data.comparisons[0]; assert.equal(r.data.baseline, 'Alpha'); assert.equal(c.environment, 'Beta'); assert.equal(c.identical, false);
  assert.deepEqual(c.differences.map((d) => d.path), ['$.url']); assert.equal(c.differences[0].Alpha, '/echo?x=1'); assert.equal(c.differences[0].Beta, '/echo?x=2');
  const ign = await okTool('compare_environments', { request: 'Echo', ignore_fields: ['url'], baseline: 'Beta' });
  assert.equal(ign.data.baseline, 'Beta'); assert.equal(ign.data.comparisons[0].identical, true);
  const one = await tool('compare_environments', { request: 'Echo', environments: ['Alpha'] });
  assert.equal(one.status, 400); assert.match(one.body.error, /at least two/i);
});

// ---------- load tests ----------
test('run_load_test waits for the report; get_load_test and stop_load_test behave', async () => {
  const r = await okTool('run_load_test', { request: 'Echo', environment: 'Beta', users: 2, iterations: 3, ramp_up_seconds: 0, sla: { p95_ms: 5000, max_error_pct: 1 } });
  assert.equal(r.state, 'done'); assert.equal(r.samples, 6); assert.equal(r.errors, 0); assert.equal(r.verdict, 'pass'); assert.equal(r.environment, 'Beta');
  assert.ok(r.response_time_ms.p50 <= r.response_time_ms.p99); assert.ok(r.percentiles_exact); assert.equal(r.status_codes[0].code, '200');
  assert.ok(r.notes.some((n) => /p99\.99/.test(n)), 'small samples carry a caveat');
  const again = await okTool('get_load_test', { run_id: r.run_id }); assert.equal(again.samples, 6);
  const noTl = await okTool('get_load_test', { run_id: r.run_id, include_timeline: false }); assert.equal(noTl.timeline_per_interval, undefined);
  const stop = await tool('stop_load_test', {}); assert.equal(stop.status, 400); assert.match(stop.body.error, /No load test is running/);
  assert.equal((await tool('get_load_test', {})).status, 400);
  assert.equal((await tool('get_load_test', { run_id: 'zzz' })).status, 400);
});

test('run_load_test: wait=false returns live numbers, stop ends it with a partial report', async () => {
  const s = await okTool('run_load_test', { request: 'Echo', users: 2, ramp_up_seconds: 0, duration_seconds: 30, wait: false });
  assert.equal(s.state, 'running');
  const busy = await tool('run_load_test', { request: 'Echo', users: 1, iterations: 1 }); assert.equal(busy.status, 400); assert.match(busy.body.error, /already running/i);
  await new Promise((r) => setTimeout(r, 500));
  const live = await okTool('get_load_test', {}); assert.equal(live.run_id, s.run_id);
  const stopped = await okTool('stop_load_test', { run_id: s.run_id });
  assert.equal(stopped.stopped, true); assert.equal(stopped.end_reason, 'stopped'); assert.ok(stopped.samples > 0);
});

test('run_load_test: undefined variables and bad CSV headers are reported, not run', async () => {
  await okTool('create_request', { name: 'Needs nope', url: up.url + '/echo?x={{nope}}' });
  const m = await tool('run_load_test', { request: 'Needs nope', users: 1, iterations: 1 });
  assert.equal(m.body.ok, false); assert.match(m.body.result.error, /\{\{nope\}\}/);
  const csv = await tool('run_load_test', { request: 'Echo', iterations: 1, csv: 'bad name\nx' });
  assert.equal(csv.status, 400); assert.match(csv.body.error, /not a valid variable name/);
});

// ---------- workspace editing ----------
test('set_variable: updates, creates (on request) and keeps secrets secret', async () => {
  const upd = await okTool('set_variable', { name: '{{base}}', value: up.url + '/echo?x=9', environment: 'Beta' });
  assert.deepEqual(upd, { environment: 'Beta', variable: 'base', secret: false, created: false });
  const refused = await tool('set_variable', { name: 'k', value: 'v', environment: 'Gamma' }); assert.equal(refused.status, 400); assert.match(refused.body.error, /create_environment/);
  const made = await okTool('set_variable', { name: 'token', value: 'hunter2-hunter2', environment: 'Gamma', create_environment: true, secret: true });
  assert.equal(made.created, true); assert.equal(made.secret, true);
  const g = await okTool('set_variable', { name: 'shared', value: '1', environment: 'globals' }); assert.equal(g.environment, 'Globals');
  const list = await okTool('list_environments'); assert.ok(list.environments.some((e) => e.name === 'Gamma'));
  assert.ok(!JSON.stringify(list).includes('hunter2'));
  assert.equal((await tool('set_variable', { name: 'bad name', value: '1' })).status, 400);
  const st = await app.state(); assert.equal(st.envs.find((e) => e.name === 'Gamma').vars[0].value, 'hunter2-hunter2', 'the real value is stored');
});

test('create_request / update_request / delete_request change the saved workspace', async () => {
  const c = await okTool('create_request', { name: 'Made by agent', curl: `curl -X POST ${up.url}/echo -H 'Content-Type: application/json' -d '{"a":1}'`, group: 'Agents', tags: ['#Bot', 'new thing'] });
  assert.equal(c.method, 'POST'); assert.equal(c.body_type, 'json'); assert.deepEqual(c.tags, ['bot', 'new-thing']); assert.equal(c.group, 'Agents');
  let st = await app.state(); assert.ok(st.tabs.some((t) => t.name === 'Made by agent')); assert.ok(st.groups.some((g) => g.name === 'Agents'));
  const u = await okTool('update_request', { request: c.id, method: 'put', headers: { 'X-One': '1' }, group: '', settings: { timeout_ms: 5000 }, auth: { type: 'bearer', token: '{{tok}}' } });
  assert.equal(u.method, 'PUT'); assert.equal(u.group, null); assert.equal(u.settings.timeout_ms, 5000); assert.equal(u.auth.token, '{{tok}}'); assert.equal(u.headers[0].key, 'X-One');
  assert.equal((await tool('update_request', { request: c.id, auth: { type: 'oauth' } })).status, 400);
  assert.equal((await tool('update_request', { request: c.id, method: 'GE T' })).status, 400);
  const d = await okTool('delete_request', { request: c.id }); assert.equal(d.deleted.name, 'Made by agent');
  st = await app.state(); assert.ok(!st.tabs.some((t) => t.id === c.id));
  assert.equal((await tool('delete_request', { request: c.id })).status, 400);
});

test('ambiguous request names are refused with the candidates listed', async () => {
  const r = await tool('get_request', { request: 'e' });
  assert.equal(r.status, 400); assert.match(r.body.error, /matches \d+ requests/);
});

test('tool calls show up in the activity feed and /api/agent/info', async () => {
  const info = await app.json('/api/agent/info');
  assert.equal(info.ok, true); assert.equal(info.tools.length, 13); assert.ok(info.mcpUrl.endsWith('/mcp'));
  assert.ok(info.activity.length > 5); assert.ok(info.clients.some((c) => c.name === 'REST client' && c.calls > 5));
  assert.equal(info.tools.find((t) => t.name === 'send_request').readOnly, false);
});

test('agent changes are visible to the page through the revision feed', async () => {
  const before = await fetch(app.base + '/api/state'); const rev0 = Number(before.headers.get('x-pw-rev'));
  await okTool('set_variable', { name: 'rev_probe', value: '1', environment: 'Alpha' });
  const after = await fetch(app.base + '/api/state'); assert.ok(Number(after.headers.get('x-pw-rev')) > rev0);
  const ch = await app.json('/api/changes?since=' + rev0 + '&boot=' + before.headers.get('x-pw-boot'));
  assert.ok(JSON.stringify(ch).includes('env'), JSON.stringify(ch).slice(0, 200));
});

// ---------- stdio bridge ----------
function bridge(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp.js')], { env: Object.assign({}, process.env, { POSTWOMAN_NO_AUTOSTART: '1' }, env), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const lines = []; let waiter = null; let err = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } if (waiter) waiter(); });
  child.stderr.on('data', (d) => { err += d; });
  const next = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no reply from bridge; stderr: ' + err)), 8000);
    const check = () => { if (lines.length) { clearTimeout(t); waiter = null; resolve(lines.shift()); } else waiter = check; };
    check();
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const done = () => new Promise((r) => { child.stdin.end(); child.on('exit', (c) => r(c)); });
  return { send, next, done, child, err: () => err };
}

test('stdio bridge forwards JSON-RPC to the running server and exits when stdin closes', async () => {
  const b = bridge({ POSTWOMAN_PORT: String(app.port) });
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'bridge-test' } } });
  assert.equal((await b.next()).result.serverInfo.name, 'postwoman');
  b.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // no reply expected
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_requests', arguments: { tag: 'smoke' } } });
  const r = await b.next(); assert.equal(r.id, 2); assert.equal(JSON.parse(r.result.content[0].text).count, 1);
  b.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual((await b.next()).result, {});
  assert.equal(await b.done(), 0);
  assert.ok((await app.json('/api/agent/info')).clients.some((c) => c.name === 'bridge-test'), 'the client shows up in the UI');
});

test('stdio bridge answers with a clear error when the server is down (and autostart is off)', async () => {
  const b = bridge({ POSTWOMAN_PORT: String(await freePort()) });
  b.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  const r = await b.next(); assert.equal(r.id, 7); assert.match(r.error.message, /Cannot reach Postwoman/);
  b.child.stdin.write('{broken\n'); assert.equal((await b.next()).error.code, -32700);
  assert.equal(await b.done(), 0);
});
