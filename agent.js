// AI-agent access: one set of tools exposed over MCP (Claude Desktop, Claude Code, GitHub Copilot, Cursor, Gemini CLI,
// Codex, …) and over plain REST + OpenAPI (scripts, LangChain, custom agents). Lives inside the local server.
'use strict';

const crypto = require('crypto');
const path = require('path');
const ReqSpec = require('./public/reqspec.js');
const Curl = require('./public/curl.js');
const Stats = require('./public/stats.js');
const Diff = require('./public/diff.js');
const Kit = require('./public/loadkit.js');
const Checks = require('./public/checks.js');

const VERSION = '1.2.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const COLORS = ['#8b7bff', '#00e0b8', '#ffc857', '#ff6b81', '#5ab0ff', '#ff9f5a', '#c792ff', '#7be495'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MAX_SAMPLES = 500;
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token)$/i;

const INSTRUCTIONS = [
  'Postwoman is the user\'s local REST API client. Its workspace holds saved requests (with {{variables}}), grouped and tagged, plus environments (Dev, QA, Prod…) that define variable values.',
  'Typical flow: list_requests → get_request → send_request (optionally environment=...) → analyze the response. Use json_path to fetch only part of a large JSON body.',
  'compare_environments sends one request to several environments at the same moment and diffs speed and data. run_load_test runs a JMeter-style load test (virtual users, ramp-up, p50…p99.99, error rate, Apdex, SLA verdict); results also appear in the user\'s UI.',
  'Secret variables and credential headers are masked in what you see but are still used when sending. Changes you make (create/update/delete requests, set_variable) show up live in the user\'s open Postwoman window.',
  'Only send traffic, and especially load tests, to systems the user owns or is allowed to test. Prefer small load tests first (e.g. 5–10 users, 10–20 s).',
].join('\n');

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const iso = (t) => (t ? new Date(t).toISOString() : null);
// Keeps small values as real JSON (no double encoding); large ones become a truncated JSON string.
const preview = (v, n) => { const s = JSON.stringify(v === undefined ? null : v); return s.length > n ? s.slice(0, n - 1) + '…' : v; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTab(o) {
  return Object.assign({
    id: uid(), name: '', groupId: null, tags: [], method: 'GET', url: '',
    headers: [], bodyType: 'none', body: '',
    auth: { type: 'none', token: '', user: '', pass: '' },
    settings: { timeout: 30000, follow: true, insecure: false },
    captures: [], tests: [], samples: [],
  }, o || {});
}

// ---------- lookups ----------
function findTab(st, ref) {
  if (ref == null || String(ref).trim() === '') fail('Missing "request" (id or name). Call list_requests to see them.');
  const r = String(ref).trim(), lc = r.toLowerCase();
  const tabs = st.tabs || [];
  const title = (t) => (t.name || t.url || '').toLowerCase();
  let hit = tabs.find((t) => t.id === r) || tabs.filter((t) => title(t) === lc);
  if (!Array.isArray(hit)) return hit;
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) fail('Several requests are named "' + r + '": ' + hit.map((t) => t.id).join(', ') + '. Use the id.');
  hit = tabs.filter((t) => title(t).includes(lc) || (t.url || '').toLowerCase().includes(lc));
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) fail('"' + r + '" matches ' + hit.length + ' requests: ' + hit.slice(0, 10).map((t) => '"' + (t.name || t.url) + '" (' + t.id + ')').join(', ') + '. Be more specific or use the id.');
  fail('No saved request matches "' + r + '". Call list_requests to see them.');
}

const realEnvs = (st) => (st.envs || []).filter((e) => e.id !== 'globals');
function findEnv(st, ref, o) {
  if (ref == null || ref === '') return o && o.allowNone === false ? fail('Missing "environment"') : (st.envs || []).find((e) => e.id === st.activeEnvId) || null;
  const r = String(ref).trim().toLowerCase();
  if (r === 'globals' || r === 'global') return (st.envs || []).find((e) => e.id === 'globals');
  const e = (st.envs || []).find((x) => x.id === ref) || realEnvs(st).find((x) => x.name.toLowerCase() === r);
  if (e) return e;
  if (o && o.optional) return null;
  fail('No environment "' + ref + '". Available: ' + (realEnvs(st).map((x) => x.name).join(', ') || '(none)') + '.');
}
function varMap(st, env) {
  const m = {};
  const add = (e) => e && (e.vars || []).forEach((v) => { if (v.enabled !== false && v.key) m[v.key] = v.value; });
  add((st.envs || []).find((e) => e.id === 'globals'));
  if (env && env.id !== 'globals') add(env);
  return m;
}
const groupName = (st, id) => { const g = (st.groups || []).find((x) => x.id === id); return g ? g.name : null; };

// ---------- masking (secrets are used when sending but never shown to the agent) ----------
const onlyVars = (v) => /^\s*(\{\{[^{}]+\}\}\s*)+$/.test(String(v || ''));
function maskSecret(v) {
  const s = String(v == null ? '' : v);
  if (!s || onlyVars(s)) return s;
  const m = /^(\w+\s+)(.+)$/.exec(s);
  const scheme = m ? m[1] : '', rest = m ? m[2] : s;
  if (rest.includes('{{')) return s;
  return scheme + '••••' + (rest.length > 12 ? rest.slice(-4) : '');
}
const maskHeaders = (list) => (list || []).map((x) => (SENSITIVE.test(x.key) ? Object.assign({}, x, { value: maskSecret(x.value) }) : x));

function headerList(h) {
  if (h == null) return [];
  if (Array.isArray(h)) return h.filter((x) => x && (x.key || x.name)).map((x) => ({ key: String(x.key || x.name), value: String(x.value == null ? '' : x.value), enabled: x.enabled !== false }));
  if (typeof h === 'object') return Object.entries(h).map(([k, v]) => ({ key: k, value: String(v == null ? '' : v), enabled: true }));
  fail('"headers" must be an object like {"Accept":"application/json"} or a list of {key, value}');
}

// ---------- shaping ----------
function requestSummary(st, t) {
  const last = (t.loadRuns || [])[0];
  return {
    id: t.id, name: t.name || null, method: t.method, url: t.url, group: groupName(st, t.groupId), tags: t.tags || [],
    latency_samples: (t.samples || []).length, load_tests: (t.loadRuns || []).length,
    last_load_test: last ? { run_id: last.id, at: iso(last.at), verdict: last.verdict, p95_ms: r2(last.el && last.el.p95), throughput_rps: r2(last.rps), error_pct: r2(last.errPct) } : null,
  };
}

function requestDetail(st, t) {
  const a = t.auth || { type: 'none' };
  const auth = a.type === 'bearer' ? { type: 'bearer', token: maskSecret(a.token) } : a.type === 'basic' ? { type: 'basic', user: a.user, pass: a.pass ? maskSecret(a.pass) : '' } : { type: 'none' };
  const used = new Set();
  const scan = (s) => String(s || '').replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, n) => { used.add(n); return m; });
  [t.url, t.body, a.token, a.user, a.pass].forEach(scan);
  (t.headers || []).forEach((x) => { scan(x.key); scan(x.value); });
  const env = findEnv(st);
  const map = varMap(st, env);
  return {
    id: t.id, name: t.name || null, method: t.method, url: t.url, group: groupName(st, t.groupId), tags: t.tags || [],
    headers: maskHeaders(t.headers).map((x) => ({ key: x.key, value: x.value, enabled: x.enabled !== false })),
    body_type: t.bodyType, body: t.body || '', auth,
    settings: { timeout_ms: t.settings && t.settings.timeout, follow_redirects: t.settings ? t.settings.follow !== false : true, ignore_tls_errors: !!(t.settings && t.settings.insecure) },
    captures: (t.captures || []).filter((c) => c.key && c.value).map((c) => ({ variable: c.key, json_path: c.value })),
    tests: (t.tests || []).map((x) => ({ check: Checks.label(x), enabled: x.enabled !== false })),
    variables_used: [...used].map((n) => ({ name: n, defined_in_active_environment: Object.prototype.hasOwnProperty.call(map, n) || ReqSpec.DYNAMIC.includes(n) || n === '$vu' || n === '$iteration' })),
    active_environment: env && env.id !== 'globals' ? env.name : null,
    latency_samples: (t.samples || []).length,
    load_tests: (t.loadRuns || []).map((r) => ({ run_id: r.id, at: iso(r.at), verdict: r.verdict, users: r.config && r.config.users, samples: r.count, throughput_rps: r2(r.rps), p95_ms: r2(r.el && r.el.p95), p99_ms: r2(r.el && r.el.p99), error_pct: r2(r.errPct) })),
  };
}

function bodyOut(res, o) {
  const out = {};
  if (!res.isText) { out.body = null; out.body_note = 'Binary body (' + (res.contentType || 'unknown type') + ', ' + res.size + ' bytes) not shown'; return out; }
  let json = null;
  const t = (res.body || '').trim();
  if (t && (/json/i.test(res.contentType) || t[0] === '{' || t[0] === '[')) { try { json = { v: JSON.parse(t) }; } catch { /* not JSON */ } }
  let text;
  if (o.json_path) {
    out.json_path = o.json_path;
    if (!json) { out.json_path_error = 'Body is not JSON'; text = res.body; }
    else { const v = ReqSpec.pickPath(json.v, o.json_path); out.json_path_found = v !== undefined; text = JSON.stringify(v === undefined ? null : v, null, 1); }
  } else text = json ? JSON.stringify(json.v, null, 1) : res.body;
  out.body_format = json ? 'json' : 'text';
  const max = Math.min(500000, Math.max(200, Number(o.max_body_chars) || 20000));
  if (text.length > max) { out.body = text.slice(0, max); out.body_truncated = { shown_chars: max, total_chars: text.length, hint: 'Use json_path to select a part, or raise max_body_chars' }; }
  else out.body = text;
  return out;
}

function shapeResponse(res, o) {
  const reqInfo = { method: res.reqMethod, url: res.reqUrl, environment: o.envName || null };
  if (!res.ok) return { ok: false, request: reqInfo, error: res.error, code: res.code, missing_variables: res.missing };
  const T = res.timings || {};
  const out = {
    ok: true, request: reqInfo, status: res.status, status_text: res.statusText, http_version: res.httpVersion,
    timings_ms: { total: T.total, dns: T.dns, tcp: T.tcp, tls: T.tls, ttfb: T.ttfb, download: T.download },
    size_bytes: res.size, content_type: res.contentType || null, redirects: res.redirects || 0, final_url: res.url,
  };
  if (o.include_headers !== false) out.headers = (res.headers || []).map(([k, v]) => [k, SENSITIVE.test(k) ? maskSecret(v) : v]);
  if (res.truncated) out.warning = 'Response exceeded 50 MB and was cut off';
  return Object.assign(out, bodyOut(res, o));
}

const sumOf = (s) => s && ({
  count: s.count, avg: r2(s.avg), min: r2(s.min), p50: r2(s.p50), p75: r2(s.p75), p90: r2(s.p90), p95: r2(s.p95), p99: r2(s.p99),
  'p99.9': r2(s.p999), 'p99.99': r2(s.p9999), max: r2(s.max), std_dev: r2(s.sd),
});

function shapeReport(rep, o) {
  const c = rep.config || {};
  const out = {
    run_id: rep.id, state: 'done', verdict: rep.verdict || null, end_reason: rep.reason,
    request: { name: rep.label, method: rep.method, url: rep.url }, environment: rep.env || null,
    started_at: iso(rep.at), ended_at: iso(rep.endedAt), duration_s: r2(rep.duration),
    config: { users: c.users, mode: c.mode, ramp_up_s: c.rampUp, hold_s: c.mode === 'duration' ? c.hold : undefined, ramp_down_s: c.rampDown || undefined, iterations_per_user: c.mode === 'iterations' ? c.iterations : undefined,
      think_time_ms: c.thinkMs || undefined, max_rps: c.maxRps || undefined, keep_alive: c.keepAlive, success_status: c.status, csv_rows: c.csvRows || undefined },
    samples: rep.count, successful: rep.okCount, errors: rep.errors, error_pct: r2(rep.errPct),
    throughput_rps: r2(rep.rps), peak_rps: r2(rep.peakRps), max_active_users: rep.maxUsers,
    apdex: rep.apdex ? { threshold_ms: rep.apdex.T, score: rep.apdex.score == null ? null : Math.round(rep.apdex.score * 1000) / 1000 } : null,
    response_time_ms: sumOf(rep.el), response_time_successful_only_ms: sumOf(rep.elOk), latency_ttfb_ms: sumOf(rep.lat), connect_ms: sumOf(rep.con),
    received_kb_per_s: r2(rep.recvKBs), sent_kb_per_s: r2(rep.sentKBs), avg_response_bytes: Math.round(rep.avgBytes || 0),
    status_codes: (rep.codes || []).map((x) => ({ code: x.code, message: x.msg || undefined, count: x.n })),
    errors_by_type: (rep.errorsList || []).slice(0, 20).map((x) => ({ error: x.key, count: x.n })),
    sla: (rep.sla || []).map((x) => ({ criterion: x.label, actual: r2(x.actual), limit: x.op + ' ' + x.limit + ' ' + x.fmt, pass: x.pass })),
    percentiles_exact: !!rep.exact,
    notes: [],
  };
  if (rep.health) {
    out.load_generator = { main_thread_busy_pct: Math.round(rep.health.elu || 0), event_loop_lag_p99_ms: r2(rep.health.lagP99), saturated: !!rep.health.saturated };
    if (rep.health.saturated) out.notes.push('The load generator itself was saturated; measured times include client-side queueing, so the server is likely faster than shown. Re-run with fewer users, think time, or max_rps.');
  }
  if (rep.count < 10000) out.notes.push('p99.99 needs ≥ 10,000 samples to differ from max' + (rep.count < 1000 ? '; p99.9 needs ≥ 1,000' : '') + '.');
  if (o.include_timeline !== false && rep.timeline && rep.timeline.length) {
    out.timeline_per_interval = Kit.downsample(rep.timeline, 60).map((b) => ({ t_s: b.t, users: b.users, rps: r2(b.n / (b.span || 1)), errors_per_s: r2(b.err / (b.span || 1)), avg_ms: r2(b.avg), p95_ms: r2(b.p95), p99_ms: r2(b.p99), max_ms: r2(b.max) }));
  }
  return out;
}

function shapeLive(st) {
  const s = st.summary || {}, e = s.el || {};
  return {
    run_id: st.id, state: st.state, elapsed_s: r2(st.elapsed), planned_s: st.planned, active_users: st.active, users: st.users,
    samples: s.count, errors: s.errors, error_pct: r2(s.errPct), throughput_now_rps: r2(s.curRps), throughput_avg_rps: r2(s.rps),
    response_time_ms: { avg: r2(e.avg), p50: r2(e.p50), p90: r2(e.p90), p95: r2(e.p95), p99: r2(e.p99), 'p99.9': r2(e.p999), 'p99.99': r2(e.p9999), max: r2(e.max) },
    note: 'Still running. Call get_load_test with this run_id to get the final report, or stop_load_test to end it.',
  };
}

// ---------- schemas ----------
const S = {
  request: { type: 'string', description: 'Saved request id or name (see list_requests). Partial names work if unambiguous.' },
  environment: { type: 'string', description: 'Environment name or id (see list_environments). Defaults to the one active in the UI.' },
  headers: { description: 'Headers as an object {"Accept":"application/json"} or a list of {key, value}', anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key'] } }] },
  bodyType: { type: 'string', enum: ['json', 'text', 'form', 'none'], description: 'Default: detected from the body / Content-Type' },
  auth: { type: 'object', description: 'Auth helper. Use {{variables}} for secrets.', properties: { type: { type: 'string', enum: ['none', 'bearer', 'basic'] }, token: { type: 'string' }, user: { type: 'string' }, pass: { type: 'string' } }, required: ['type'] },
  settings: { type: 'object', properties: { timeout_ms: { type: 'integer', minimum: 100, maximum: 300000 }, follow_redirects: { type: 'boolean' }, ignore_tls_errors: { type: 'boolean' } } },
  tags: { type: 'array', items: { type: 'string' } },
};
const obj = (properties, required) => ({ type: 'object', properties, required: required || [], additionalProperties: false });

module.exports = function createAgent(ctx) {
  const sessions = new Map();
  const activity = [];
  const clientOf = (sid) => (sid && sessions.get(sid)) || null;

  // ---------- shared actions ----------
  async function sendTab(tab, map) {
    const missing = new Set();
    const spec = ReqSpec.buildSpec(tab, map, missing);
    if (missing.size) return { ok: false, code: 'EMISSING', missing: [...missing], error: 'Undefined variable' + (missing.size > 1 ? 's' : '') + ': ' + [...missing].map((m) => '{{' + m + '}}').join(', '), reqUrl: spec.url, reqMethod: spec.method };
    try { return Object.assign(await ctx.sendRequest(spec), { reqUrl: spec.url, reqMethod: spec.method }); }
    catch (e) { return Object.assign(ctx.friendlyError(e), { reqUrl: spec.url, reqMethod: spec.method }); }
  }

  function missingHelp(st, missing) {
    if (!missing || !missing.length) return undefined;
    return missing.map((n) => ({ variable: n, defined_in: realEnvs(st).filter((e) => (e.vars || []).some((v) => v.key === n && v.enabled !== false)).map((e) => e.name) }));
  }

  function tabFromArgs(a) {
    if (a.curl) {
      if (!Curl.looksLikeCurl(a.curl)) fail('"curl" must start with "curl"');
      const r = Curl.parseCurl(a.curl);
      if (!r.url) fail('That cURL command has no URL');
      return { tab: makeTab({ method: r.method, url: r.url, headers: r.headers, body: r.body, bodyType: ReqSpec.guessBodyType(r.body, r.headers),
        settings: { timeout: r.timeout || 30000, follow: r.followRedirects || true, insecure: r.insecure } }), warnings: r.warnings };
    }
    if (!a.url) fail('Give "request" (a saved request), or "url" / "curl" for an ad-hoc request');
    const headers = headerList(a.headers);
    const body = a.body == null ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return { tab: makeTab({ method: String(a.method || (body ? 'POST' : 'GET')).toUpperCase(), url: String(a.url), headers, body, bodyType: a.body_type || ReqSpec.guessBodyType(body, headers) }), warnings: [] };
  }

  // ---------- tools ----------
  const TOOLS = [
    {
      name: 'list_requests', title: 'List saved requests',
      description: 'List the saved API requests in the user\'s Postwoman workspace (id, name, method, URL template, group, tags, how many latency samples and load tests exist). Filter with query (matches name, URL, group, tags), tag or group.',
      inputSchema: obj({ query: { type: 'string' }, tag: { type: 'string' }, group: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run(a) {
        const st = ctx.loadState() || { tabs: [], groups: [], envs: [] };
        const q = String(a.query || '').toLowerCase().replace(/^#/, ''), tag = String(a.tag || '').toLowerCase().replace(/^#/, ''), grp = String(a.group || '').toLowerCase();
        let tabs = st.tabs || [];
        if (q) tabs = tabs.filter((t) => [t.name, t.url, t.method, groupName(st, t.groupId), ...(t.tags || [])].join(' ').toLowerCase().includes(q));
        if (tag) tabs = tabs.filter((t) => (t.tags || []).some((x) => x.toLowerCase() === tag));
        if (grp) tabs = tabs.filter((t) => (groupName(st, t.groupId) || '').toLowerCase().includes(grp));
        const env = findEnv(st);
        return {
          count: tabs.length, requests: tabs.slice(0, a.limit || 200).map((t) => requestSummary(st, t)),
          groups: (st.groups || []).map((g) => g.name), active_environment: env && env.id !== 'globals' ? env.name : null,
          environments: realEnvs(st).map((e) => e.name),
        };
      },
    },
    {
      name: 'get_request', title: 'Get request details',
      description: 'Full definition of one saved request: method, URL, headers, body, auth (secrets masked), settings, captures, which {{variables}} it uses and whether they are defined, plus its load-test history.',
      inputSchema: obj({ request: S.request }, ['request']),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run(a) { const st = ctx.loadState() || {}; return requestDetail(st, findTab(st, a.request)); },
    },
    {
      name: 'send_request',
      title: 'Send a request',
      description: 'Send a saved request (or an ad-hoc one via url/method/headers/body, or a curl command) through Postwoman and return status, timings (DNS/TCP/TLS/TTFB/download), headers and body. {{variables}} are resolved from the chosen environment (secrets included, without revealing them). Large JSON: use json_path (e.g. "data.items[0]") or max_body_chars. Sends to saved requests are recorded in their latency stats and run their captures, like the Send button; the request\'s Tests (set in the UI) are evaluated and returned as `tests`.',
      inputSchema: obj({
        request: S.request, environment: S.environment,
        method: { type: 'string', description: 'Ad-hoc request method (default GET, or POST when a body is given)' },
        url: { type: 'string', description: 'Ad-hoc request URL (may contain {{variables}})' },
        headers: S.headers, body: { description: 'Ad-hoc request body (string, or JSON value)' }, body_type: S.bodyType,
        curl: { type: 'string', description: 'Ad-hoc request as a curl command' },
        variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra/override variable values for this send only' },
        json_path: { type: 'string', description: 'Return only this part of a JSON response, e.g. "items[0].id" or "$.data"' },
        max_body_chars: { type: 'integer', minimum: 200, maximum: 500000, default: 20000 },
        include_headers: { type: 'boolean', default: true },
        record: { type: 'boolean', default: true, description: 'For saved requests: add to latency stats and run captures' },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(a) {
        const st = ctx.loadState() || { tabs: [], envs: [] };
        const saved = a.request ? findTab(st, a.request) : null;
        const { tab, warnings } = saved ? { tab: saved, warnings: [] } : tabFromArgs(a);
        const env = findEnv(st, a.environment);
        const map = Object.assign(varMap(st, env), a.variables || {});
        const res = await sendTab(tab, map);
        const envName = env && env.id !== 'globals' ? env.name : null;
        const out = shapeResponse(res, Object.assign({}, a, { envName }));
        if (!res.ok && res.missing) out.missing_variables = missingHelp(st, res.missing);
        if (warnings && warnings.length) out.curl_warnings = warnings;
        if (saved && (saved.tests || []).some((x) => x.enabled !== false) && res.code !== 'EMISSING') {
          const results = Checks.evaluate(saved.tests, res, map);
          out.tests = Object.assign(Checks.summarize(results), { results: results.map((r) => ({ check: r.label, pass: r.pass, got: r.actual, error: r.error })) });
        }
        if (saved && a.record !== false && res.code !== 'EMISSING') {
          const captured = [];
          ctx.mutate((s, touch) => {
            const t = s.tabs.find((x) => x.id === saved.id);
            if (!t) return;
            t.samples = Array.isArray(t.samples) ? t.samples : [];
            t.samples.push({ t: Date.now(), ms: res.ok ? res.timings.total : null, status: res.ok ? res.status : 0, ok: !!res.ok });
            if (t.samples.length > MAX_SAMPLES) t.samples.splice(0, t.samples.length - MAX_SAMPLES);
            touch('tab', t.id, { fields: ['samples'] });
            if (res.ok && res.isText && (t.captures || []).length) {
              let j = null; try { j = JSON.parse(res.body); } catch { /* not JSON */ }
              const target = (env && s.envs.find((e) => e.id === env.id)) || s.envs.find((e) => e.id === 'globals');
              if (j && target) for (const c of t.captures) {
                if (!c.key || !c.value) continue;
                const v = ReqSpec.pickPath(j, c.value);
                if (v === undefined || v === null) continue;
                const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
                const ex = target.vars.find((x) => x.key === c.key.trim());
                if (ex) { ex.value = val; ex.enabled = true; } else target.vars.push({ key: c.key.trim(), value: val, secret: false, enabled: true });
                captured.push({ variable: c.key.trim(), environment: target.name });
              }
              if (captured.length) touch('env', target.id);
            }
          });
          if (captured.length) out.captured_variables = captured;
        }
        return out;
      },
    },
    {
      name: 'compare_environments', title: 'Compare across environments',
      description: 'Send the same saved request to several environments at the same moment (optionally several rounds) and compare performance (time, p50/p95, TTFB, size, fastest) and data (field-level JSON diff vs a baseline: changed / added / removed / type). Use ignore_fields for noisy keys like timestamps or ids.',
      inputSchema: obj({
        request: S.request,
        environments: { type: 'array', items: { type: 'string' }, description: 'Environment names/ids; default: all environments' },
        baseline: { type: 'string', description: 'Environment to diff the others against; default: the first one' },
        rounds: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
        ignore_fields: { description: 'Keys or paths to ignore in the data diff, e.g. ["timestamp","meta.traceId"]', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
        max_differences: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      }, ['request']),
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(a) {
        const st = ctx.loadState() || { tabs: [], envs: [] };
        const tab = findTab(st, a.request);
        const envs = a.environments && a.environments.length ? a.environments.map((r) => findEnv(st, r, { allowNone: false })) : realEnvs(st);
        if (envs.length < 2) fail('Need at least two environments to compare (found ' + envs.length + '). Create them in the UI or with set_variable(create_environment=true).');
        const rounds = Math.min(20, Math.max(1, a.rounds || 1));
        const rows = envs.map((e) => ({ env: e, samples: [], last: null, error: null }));
        for (let i = 0; i < rounds; i++) {
          await Promise.all(rows.map(async (r) => {
            if (r.error) return;
            const res = await sendTab(tab, varMap(st, r.env));
            if (res.code === 'EMISSING') { r.error = res; return; }
            r.samples.push(res.ok ? { ok: true, ms: res.timings.total, ttfb: (res.timings.dns || 0) + (res.timings.tcp || 0) + (res.timings.tls || 0) + (res.timings.ttfb || 0), status: res.status } : { ok: false, status: 0, code: res.code, error: res.error });
            if (res.ok || !r.last || !r.last.ok) r.last = res;
          }));
        }
        const perf = rows.map((r) => {
          const ok = r.samples.filter((s) => s.ok);
          const sum = Stats.summarize(r.samples.map((s) => ({ ms: s.ms, status: s.status, ok: s.ok })));
          return {
            environment: r.env.name,
            error: r.error ? r.error.error : (!ok.length && r.last ? r.last.error : undefined),
            statuses: [...new Set(r.samples.map((s) => (s.ok ? s.status : s.code || 'ERR')))],
            successful: ok.length, failed: r.samples.length - ok.length,
            response_time_ms: sum && sum.timed ? { avg: r2(sum.avg), p50: r2(sum.p50), p95: r2(sum.p95), min: r2(sum.min), max: r2(sum.max) } : null,
            ttfb_avg_ms: ok.length ? r2(ok.reduce((x, s) => x + s.ttfb, 0) / ok.length) : null,
            size_bytes: r.last && r.last.ok ? r.last.size : null,
            url: r.last ? r.last.reqUrl : undefined,
          };
        });
        const timed = perf.filter((p) => p.response_time_ms);
        const key = (p) => (rounds > 1 ? p.response_time_ms.p50 : p.response_time_ms.avg);
        const best = timed.length ? timed.reduce((m, p) => (key(p) < key(m) ? p : m)) : null;
        if (best) for (const p of timed) p.vs_fastest = p === best ? 'fastest' : '+' + r2(key(p) - key(best)) + ' ms (' + (key(p) / key(best)).toFixed(2) + '×)';

        const usable = rows.filter((r) => r.last && r.last.ok);
        const data = { compared: usable.length >= 2 };
        if (usable.length >= 2) {
          const base = (a.baseline && usable.find((r) => r.env.name.toLowerCase() === String(a.baseline).toLowerCase() || r.env.id === a.baseline)) || usable[0];
          const ignore = Diff.parseIgnore(Array.isArray(a.ignore_fields) ? a.ignore_fields.join(',') : a.ignore_fields);
          const maxD = Math.min(500, a.max_differences || 50);
          const parse = (res) => { if (!res.isText) return null; try { return { v: JSON.parse(res.body) }; } catch { return null; } };
          data.baseline = base.env.name;
          data.ignored_fields = [...ignore];
          data.comparisons = usable.filter((r) => r !== base).map((r) => {
            const A = base.last, B = r.last, ja = parse(A), jb = parse(B);
            const c = { environment: r.env.name, status: [A.status, B.status], status_same: A.status === B.status, content_type_same: (A.contentType || '') === (B.contentType || ''), size_bytes: [A.size, B.size] };
            if (ja && jb) {
              const d = Diff.diffJson(ja.v, jb.v, { ignore, max: 2000 });
              Object.assign(c, { mode: 'json', identical: !d.diffs.length && c.status_same, difference_count: d.diffs.length + (d.capped ? '+' : ''),
                differences: d.diffs.slice(0, maxD).map((x) => ({ path: x.path, kind: x.kind, [base.env.name]: x.kind === 'added' ? undefined : preview(x.a, 200), [r.env.name]: x.kind === 'removed' ? undefined : preview(x.b, 200) })) });
              if (d.diffs.length > maxD) c.more_differences = d.diffs.length - maxD;
            } else if (A.isText && B.isText) {
              const d = Diff.diffText(A.body, B.body);
              Object.assign(c, { mode: 'text', identical: d.equal && c.status_same, changed_lines: d.changedLines, first_difference: d.equal ? undefined : { line: d.firstLine, [base.env.name]: preview(d.a, 300), [r.env.name]: preview(d.b, 300) } });
            } else Object.assign(c, { mode: 'binary', identical: A.body === B.body && c.status_same });
            return c;
          });
        } else data.note = 'Need successful responses from at least two environments to compare data';
        return { request: { name: tab.name || null, method: tab.method, url: tab.url }, rounds, fastest: best ? best.environment : null, performance: perf, data };
      },
    },
    {
      name: 'run_load_test', title: 'Run a load test',
      description: 'Run a JMeter-style load test on a saved request inside the local Postwoman server: N virtual users with ramp-up, then hold for a duration (or a fixed number of iterations per user), optional think time and throughput cap, assertions and SLA pass/fail criteria. Returns throughput, error %, Apdex, avg/min/median/p75/p90/p95/p99/p99.9/p99.99/max for response time, TTFB and connect, status codes, error types, SLA verdict and a per-second timeline. The result is also saved to the request and shown live in the user\'s UI. By default waits up to max_wait_seconds; if still running, returns live numbers and a run_id for get_load_test. Only test systems the user owns.',
      inputSchema: obj({
        request: S.request, environment: S.environment,
        users: { type: 'integer', minimum: 1, maximum: 5000, default: 10, description: 'Concurrent virtual users (threads)' },
        ramp_up_seconds: { type: 'number', minimum: 0, maximum: 3600, default: 5 },
        duration_seconds: { type: 'number', minimum: 0, maximum: 86400, default: 30, description: 'Hold time at full load (ignored when iterations is set)' },
        ramp_down_seconds: { type: 'number', minimum: 0, maximum: 3600, default: 0 },
        iterations: { type: 'integer', minimum: 1, maximum: 10000000, description: 'If set: each user sends this many requests, then stops (loop-count mode)' },
        think_time_ms: { type: 'number', minimum: 0, maximum: 600000, default: 0 },
        think_jitter_ms: { type: 'number', minimum: 0, maximum: 600000, default: 0 },
        max_rps: { type: 'number', minimum: 0, maximum: 100000, default: 0, description: 'Throughput cap in requests/second (0 = unlimited)' },
        keep_alive: { type: 'boolean', default: true },
        success_status: { type: 'string', default: '200-399', description: 'Statuses that count as success, e.g. "200-399", "2xx", "200,201"' },
        body_contains: { type: 'string', description: 'Fail samples whose body lacks this text' },
        max_response_ms: { type: 'number', minimum: 0, description: 'Fail samples slower than this' },
        apdex_t_ms: { type: 'number', minimum: 1, default: 500 },
        sla: obj({ p95_ms: { type: 'number' }, p99_ms: { type: 'number' }, p99_99_ms: { type: 'number' }, max_error_pct: { type: 'number' }, min_rps: { type: 'number' } }),
        csv: { type: 'string', description: 'CSV test data; first row = variable names usable as {{name}}; rows are shared and recycled' },
        wait: { type: 'boolean', default: true },
        max_wait_seconds: { type: 'number', minimum: 0, maximum: 280, default: 55 },
        include_timeline: { type: 'boolean', default: true },
      }, ['request']),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      async run(a) {
        const st = ctx.loadState() || { tabs: [], envs: [] };
        const tab = findTab(st, a.request);
        const env = findEnv(st, a.environment);
        const csv = Kit.parseCsv(a.csv || '');
        const bad = csv.headers.find((x) => !/^[A-Za-z_][\w.-]*$/.test(x));
        if (bad != null) fail('CSV column "' + bad + '" is not a valid variable name');
        const map = varMap(st, env);
        ['$vu', '$iteration'].concat(ReqSpec.DYNAMIC).forEach((k) => { if (!Object.prototype.hasOwnProperty.call(map, k)) map[k] = '{{' + k + '}}'; });
        csv.headers.forEach((k) => { map[k] = '{{' + k + '}}'; });
        const missing = new Set();
        const spec = ReqSpec.buildSpec(tab, map, missing, { forLoad: true });
        if (missing.size) return { ok: false, error: 'Undefined variables: ' + [...missing].map((m) => '{{' + m + '}}').join(', '), missing_variables: missingHelp(st, [...missing]) };
        const sla = a.sla || {};
        const iterMode = a.iterations != null;
        const body = {
          spec, origin: 'agent', tabId: tab.id, label: tab.name || tab.url, urlTemplate: tab.url, env: env && env.id !== 'globals' ? env.name : null,
          users: a.users == null ? 10 : a.users, rampUp: a.ramp_up_seconds == null ? 5 : a.ramp_up_seconds,
          mode: iterMode ? 'iterations' : 'duration', hold: a.duration_seconds == null ? 30 : a.duration_seconds, rampDown: a.ramp_down_seconds || 0, iterations: a.iterations || 1,
          thinkMs: a.think_time_ms || 0, jitterMs: a.think_jitter_ms || 0, maxRps: a.max_rps || 0, keepAlive: a.keep_alive !== false,
          status: a.success_status || '200-399', contains: a.body_contains || '', maxMs: a.max_response_ms || 0, apdexT: a.apdex_t_ms || 500,
          sla: { p95: sla.p95_ms, p99: sla.p99_ms, p9999: sla.p99_99_ms, errPct: sla.max_error_pct, minRps: sla.min_rps }, csv: a.csv || '',
        };
        let run;
        try { run = ctx.Load.start(body); } catch (e) { fail(e.message); }
        if (a.wait === false) return Object.assign(shapeLive(run.status(0)), { note: 'Started. Call get_load_test with this run_id for progress and the final report.' });
        const deadline = Date.now() + Math.min(280, a.max_wait_seconds == null ? 55 : a.max_wait_seconds) * 1000;
        while (run.state !== 'done' && Date.now() < deadline) await sleep(250);
        if (run.state !== 'done') return shapeLive(run.status(0));
        if (!run.report) fail('The load test failed: ' + (run.error || 'unknown error'));
        return shapeReport(run.report, a);
      },
    },
    {
      name: 'get_load_test', title: 'Get load test results',
      description: 'Get a load test: live progress if still running, otherwise the full report (same shape as run_load_test). Give run_id, or request to list that request\'s saved runs (newest first) with the latest report. With no arguments returns the currently running test.',
      inputSchema: obj({ run_id: { type: 'string' }, request: S.request, include_timeline: { type: 'boolean', default: true } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run(a) {
        if (a.run_id) {
          const run = ctx.Load.get(a.run_id);
          if (run) {
            if (run.state !== 'done') return shapeLive(run.status(0));
            if (run.report) return shapeReport(run.report, a);
          }
          const st = ctx.loadState() || { tabs: [] };
          for (const t of st.tabs || []) { const r = (t.loadRuns || []).find((x) => x.id === a.run_id); if (r) return shapeReport(r, a); }
          fail('No load test with run_id ' + a.run_id);
        }
        if (a.request) {
          const st = ctx.loadState() || { tabs: [] };
          const t = findTab(st, a.request);
          const runs = t.loadRuns || [];
          const live = ctx.Load.active();
          return {
            request: { id: t.id, name: t.name || null },
            running: live && live.cfg.tabId === t.id ? shapeLive(live.status(0)) : undefined,
            runs: runs.map((r) => ({ run_id: r.id, at: iso(r.at), verdict: r.verdict, users: r.config && r.config.users, samples: r.count, throughput_rps: r2(r.rps), p95_ms: r2(r.el && r.el.p95), p99_ms: r2(r.el && r.el.p99), 'p99.99_ms': r2(r.el && r.el.p9999), error_pct: r2(r.errPct) })),
            latest: runs[0] ? shapeReport(runs[0], a) : null,
          };
        }
        const live = ctx.Load.active();
        if (!live) fail('No load test is running. Pass run_id or request.');
        return shapeLive(live.status(0));
      },
    },
    {
      name: 'stop_load_test', title: 'Stop a load test',
      description: 'Stop the running load test (or the one with run_id). In-flight requests are cancelled; the partial report is kept.',
      inputSchema: obj({ run_id: { type: 'string' } }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(a) {
        const run = a.run_id ? ctx.Load.get(a.run_id) : ctx.Load.active();
        if (!run) fail(a.run_id ? 'No load test with run_id ' + a.run_id : 'No load test is running');
        run.stop();
        const until = Date.now() + 5000;
        while (run.state !== 'done' && Date.now() < until) await sleep(100);
        return run.report ? Object.assign(shapeReport(run.report, { include_timeline: false }), { stopped: true }) : { run_id: run.id, state: run.state, stopped: true };
      },
    },
    {
      name: 'get_latency_stats', title: 'Get latency stats',
      description: 'Latency statistics collected for a saved request from individual sends (Send button, send_request, benchmark runs): count, errors, min/avg/p50/p90/p95/p99/max/std-dev, status-code counts, and the most recent samples.',
      inputSchema: obj({ request: S.request, recent: { type: 'integer', minimum: 0, maximum: 500, default: 20 } }, ['request']),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run(a) {
        const st = ctx.loadState() || { tabs: [] };
        const t = findTab(st, a.request);
        const samples = t.samples || [];
        const s = Stats.summarize(samples.map((x) => ({ ms: x.ms, status: x.status, ok: x.ok })));
        return {
          request: { id: t.id, name: t.name || null, method: t.method, url: t.url },
          summary_ms: s ? { count: s.count, responded: s.timed, transport_errors: s.errors, min: r2(s.min), avg: r2(s.avg), p50: r2(s.p50), p90: r2(s.p90), p95: r2(s.p95), p99: r2(s.p99), max: r2(s.max), std_dev: r2(s.sd) } : null,
          status_codes: s ? s.codes : {},
          recent: samples.slice(-(a.recent == null ? 20 : a.recent)).map((x) => ({ at: iso(x.t), ms: r2(x.ms), status: x.status, ok: x.ok })),
          note: s && s.timed < 100 ? 'Fewer than 100 samples: p99 is just the slowest request. Use run_load_test for solid percentiles.' : undefined,
        };
      },
    },
    {
      name: 'list_environments', title: 'List environments',
      description: 'List environments (Dev, QA, Prod…) and Globals with their variables. Secret values are masked. Shows which environment is active in the UI.',
      inputSchema: obj({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run() {
        const st = ctx.loadState() || { envs: [] };
        const vars = (e) => (e.vars || []).filter((v) => v.key).map((v) => ({ name: v.key, value: v.secret ? '••••' : v.value, secret: !!v.secret, enabled: v.enabled !== false }));
        const g = (st.envs || []).find((e) => e.id === 'globals');
        return {
          active: (realEnvs(st).find((e) => e.id === st.activeEnvId) || {}).name || null,
          environments: realEnvs(st).map((e) => ({ id: e.id, name: e.name, active: e.id === st.activeEnvId, variables: vars(e) })),
          globals: g ? vars(g) : [],
          dynamic_variables: ReqSpec.DYNAMIC.map((d) => '{{' + d + '}}'),
        };
      },
    },
    {
      name: 'set_variable', title: 'Set a variable',
      description: 'Create or update a variable in an environment (default: the active one; "Globals" for shared values). Set create_environment=true to create the environment if it does not exist. Mark secret=true for tokens/passwords (masked in the UI and to agents).',
      inputSchema: obj({ name: { type: 'string' }, value: { type: 'string' }, environment: S.environment, secret: { type: 'boolean' }, create_environment: { type: 'boolean', default: false } }, ['name', 'value']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run(a) {
        const name = String(a.name || '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '');
        if (!/^[^{}\s]+$/.test(name)) fail('Invalid variable name');
        return ctx.mutate((st, touch) => {
          let env = findEnv(st, a.environment, { optional: true });
          if (!env && a.environment) {
            if (!a.create_environment) fail('No environment "' + a.environment + '". Pass create_environment=true to create it.');
            env = { id: uid(), name: String(a.environment).trim(), vars: [] };
            st.envs.push(env);
          }
          if (!env) env = st.envs.find((e) => e.id === 'globals');
          const ex = env.vars.find((v) => v.key === name);
          if (ex) { ex.value = String(a.value); ex.enabled = true; if (a.secret != null) ex.secret = !!a.secret; }
          else env.vars.push({ key: name, value: String(a.value), secret: !!a.secret, enabled: true });
          touch('env', env.id);
          return { environment: env.name, variable: name, secret: !!(ex ? ex.secret : a.secret), created: !ex };
        });
      },
    },
    {
      name: 'create_request', title: 'Create a saved request',
      description: 'Create a new saved request in the workspace (appears in the user\'s UI immediately). Give method/url/headers/body, or a curl command. Use {{variables}} for environment-specific parts like {{baseUrl}} and for secrets. group is created if missing.',
      inputSchema: obj({
        name: { type: 'string' }, method: { type: 'string' }, url: { type: 'string' }, headers: S.headers, body: { description: 'String or JSON value' }, body_type: S.bodyType,
        auth: S.auth, settings: S.settings, group: { type: 'string' }, tags: S.tags, curl: { type: 'string', description: 'Create from a curl command instead of url/method/…' },
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run(a) {
        const { tab, warnings } = tabFromArgs(a);
        applyPatch(tab, a, true);
        if (!tab.name) { try { tab.name = new URL(/^[a-z]+:\/\//i.test(tab.url) ? tab.url : 'http://' + tab.url.replace(/\{\{[^}]+\}\}/g, 'x')).pathname.replace(/\/$/, '').split('/').pop() || ''; } catch { /* keep empty */ } }
        return ctx.mutate((st, touch) => {
          if (a.group) tab.groupId = ensureGroup(st, a.group, touch);
          st.tabs.push(tab);
          touch('tab', tab.id);
          const out = requestDetail(st, tab);
          if (warnings && warnings.length) out.curl_warnings = warnings;
          return out;
        });
      },
    },
    {
      name: 'update_request', title: 'Update a saved request',
      description: 'Change fields of a saved request. Only given fields change; headers and tags replace the whole list. group: name to move into (created if missing) or "" to ungroup.',
      inputSchema: obj({
        request: S.request, name: { type: 'string' }, method: { type: 'string' }, url: { type: 'string' }, headers: S.headers, body: { description: 'String or JSON value' },
        body_type: S.bodyType, auth: S.auth, settings: S.settings, group: { type: 'string' }, tags: S.tags,
      }, ['request']),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run(a) {
        return ctx.mutate((st, touch) => {
          const t = findTab(st, a.request);
          if (a.url != null) t.url = String(a.url);
          if (a.method != null) t.method = String(a.method).toUpperCase();
          if (a.headers != null) t.headers = headerList(a.headers);
          if (a.body != null) { t.body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body, null, 2); if (a.body_type == null) t.bodyType = ReqSpec.guessBodyType(t.body, t.headers); }
          applyPatch(t, a, false);
          if (a.group != null) t.groupId = a.group === '' ? null : ensureGroup(st, a.group, touch);
          touch('tab', t.id);
          return requestDetail(st, t);
        });
      },
    },
    {
      name: 'delete_request', title: 'Delete a saved request',
      description: 'Permanently delete a saved request (and its latency samples and load-test history) from the workspace.',
      inputSchema: obj({ request: S.request }, ['request']),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      run(a) {
        return ctx.mutate((st, touch) => {
          const t = findTab(st, a.request);
          st.tabs = st.tabs.filter((x) => x.id !== t.id);
          touch('tab', t.id, { deleted: true });
          return { deleted: { id: t.id, name: t.name || null, method: t.method, url: t.url } };
        });
      },
    },
  ];

  function applyPatch(t, a, isNew) {
    if (a.name != null) t.name = String(a.name);
    if (isNew && a.method) t.method = String(a.method).toUpperCase();
    if (t.method && !/^[A-Z]+$/.test(t.method)) fail('Invalid method "' + t.method + '"');
    if (a.body_type != null) t.bodyType = a.body_type;
    if (a.auth) {
      const type = ['none', 'bearer', 'basic'].includes(a.auth.type) ? a.auth.type : fail('auth.type must be none, bearer or basic');
      t.auth = { type, token: a.auth.token || '', user: a.auth.user || '', pass: a.auth.pass || '' };
    }
    if (a.settings) {
      const s = t.settings = Object.assign({ timeout: 30000, follow: true, insecure: false }, t.settings || {});
      if (a.settings.timeout_ms != null) s.timeout = Math.min(300000, Math.max(100, Number(a.settings.timeout_ms) || 30000));
      if (a.settings.follow_redirects != null) s.follow = !!a.settings.follow_redirects;
      if (a.settings.ignore_tls_errors != null) s.insecure = !!a.settings.ignore_tls_errors;
    }
    if (a.tags) t.tags = [...new Set(a.tags.map((x) => String(x).trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')).filter(Boolean))];
    if (!METHODS.includes(t.method) && !/^[A-Z]+$/.test(t.method)) fail('Invalid method');
  }

  function ensureGroup(st, name, touch) {
    const n = String(name).trim();
    const g = st.groups.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (g) return g.id;
    const ng = { id: uid(), name: n, color: COLORS[st.groups.length % COLORS.length], collapsed: false };
    st.groups.push(ng);
    touch('group', ng.id);
    return ng.id;
  }

  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const publicDef = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: Object.assign({ title: t.title }, t.annotations) });

  function describe(name, a, out) {
    const ref = a.request || a.url || a.name || a.run_id || '';
    if (name === 'send_request' && out && out.request) return (out.request.method || '') + ' ' + (out.request.url || ref) + (out.status ? ' → ' + out.status : out.error ? ' → ' + out.error : '');
    if (name === 'run_load_test' && out) return 'load test ' + (a.request || '') + (out.state === 'done' ? ' → ' + (out.verdict ? out.verdict.toUpperCase() + ', ' : '') + 'p95 ' + (out.response_time_ms && out.response_time_ms.p95) + ' ms' : ' (running)');
    return name.replace(/_/g, ' ') + (ref ? ' ' + ref : '');
  }

  async function callTool(name, args, client) {
    const tool = byName.get(name);
    if (!tool) return { unknown: true };
    const a = args && typeof args === 'object' ? args : {};
    const t0 = Date.now();
    let out, error = null;
    try { out = await tool.run(a); }
    catch (e) { error = e instanceof ToolError ? e.message : 'Internal error: ' + e.message; if (!(e instanceof ToolError)) console.error('Tool', name, 'failed:', e); }
    const ok = !error && !(out && out.ok === false);
    const act = { at: Date.now(), client: (client && client.name) || 'AI agent', tool: name, text: describe(name, a, out), ok, ms: Date.now() - t0 };
    if (error) act.text += ' ✗ ' + error;
    activity.unshift(act); activity.splice(50);
    if (client) { client.calls = (client.calls || 0) + 1; client.lastSeen = act.at; }
    if (name !== 'list_requests' && name !== 'list_environments' && name !== 'get_request') ctx.broadcast(Object.assign({ type: 'activity' }, act));
    return { out, error };
  }

  // ---------- MCP (JSON-RPC 2.0 over Streamable HTTP; mcp.js bridges stdio to this) ----------
  async function handleRpc(msg, sid, setSid) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code, message } });
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return err(-32600, 'Invalid Request');
    if (typeof msg.method !== 'string') return null; // a response to us: nothing to do
    const isNotification = msg.id === undefined;
    const p = msg.params || {};
    switch (msg.method) {
      case 'initialize': {
        const proto = PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0];
        const id = crypto.randomUUID();
        const ci = p.clientInfo || {};
        sessions.set(id, { id, name: ci.title || ci.name || 'AI agent', version: ci.version || '', since: Date.now(), lastSeen: Date.now(), calls: 0 });
        if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
        setSid(id);
        ctx.broadcast({ type: 'activity', at: Date.now(), client: sessions.get(id).name, tool: 'connect', text: 'connected', ok: true });
        return reply({ protocolVersion: proto, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'postwoman', title: 'Postwoman', version: VERSION }, instructions: INSTRUCTIONS });
      }
      case 'ping': return isNotification ? null : reply({});
      case 'tools/list': return reply({ tools: TOOLS.map(publicDef) });
      case 'tools/call': {
        const client = clientOf(sid);
        const r = await callTool(p.name, p.arguments, client);
        if (r.unknown) return err(-32602, 'Unknown tool: ' + p.name);
        if (r.error) return reply({ content: [{ type: 'text', text: r.error }], isError: true });
        const text = JSON.stringify(r.out, null, 1);
        return reply({ content: [{ type: 'text', text }], isError: !!(r.out && r.out.ok === false) });
      }
      case 'resources/list': return reply({ resources: [] });
      case 'resources/templates/list': return reply({ resourceTemplates: [] });
      case 'prompts/list': return reply({ prompts: [] });
      case 'logging/setLevel': return reply({});
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
        return err(-32601, 'Method not found: ' + msg.method);
    }
  }

  function openapi() {
    const paths = {};
    for (const t of TOOLS) {
      paths['/api/tools/' + t.name] = { post: {
        operationId: t.name, summary: t.title, description: t.description,
        requestBody: { required: true, content: { 'application/json': { schema: t.inputSchema } } },
        responses: { 200: { description: 'Tool result', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } } } } } } },
      } };
    }
    return { openapi: '3.1.0', info: { title: 'Postwoman agent API', version: VERSION, description: INSTRUCTIONS }, servers: [{ url: 'http://127.0.0.1:' + ctx.port }], paths };
  }

  async function route(req, res, u, h) {
    const p = u.pathname;
    if (p === '/mcp') {
      if (req.method === 'POST') {
        let parsed;
        try { parsed = JSON.parse((await h.readBody(req)).toString('utf8')); }
        catch { h.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return true; }
        let sid = req.headers['mcp-session-id'] || null, newSid = null;
        const setSid = (id) => { newSid = id; };
        if (sid && sessions.has(sid)) sessions.get(sid).lastSeen = Date.now();
        const batch = Array.isArray(parsed);
        const out = [];
        for (const m of batch ? parsed : [parsed]) { const r = await handleRpc(m, sid || newSid, setSid); if (r) out.push(r); }
        const headers = newSid ? { 'Mcp-Session-Id': newSid } : {};
        if (!out.length) { res.writeHead(202, headers); res.end(); return true; }
        h.sendJson(res, 200, batch ? out : out[0], headers);
        return true;
      }
      if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); res.writeHead(204); res.end(); return true; }
      res.writeHead(405, { Allow: 'POST, DELETE' }); res.end(); return true;
    }
    if (p === '/api/tools' && req.method === 'GET') { h.sendJson(res, 200, { ok: true, tools: TOOLS.map(publicDef) }); return true; }
    if (p.startsWith('/api/tools/') && req.method === 'POST') {
      const name = decodeURIComponent(p.slice('/api/tools/'.length));
      let args = {};
      try { const raw = (await h.readBody(req)).toString('utf8').trim(); args = raw ? JSON.parse(raw) : {}; } catch { h.sendJson(res, 400, { ok: false, error: 'Body must be JSON' }); return true; }
      const cname = String(req.headers['x-client-name'] || 'REST client').slice(0, 60);
      const key = 'rest:' + cname;
      if (!sessions.has(key)) sessions.set(key, { id: key, name: cname, version: 'REST', since: Date.now(), lastSeen: Date.now(), calls: 0 });
      const client = sessions.get(key);
      const r = await callTool(name, args, client);
      if (r.unknown) h.sendJson(res, 404, { ok: false, error: 'Unknown tool: ' + name + '. GET /api/tools lists them.' });
      else if (r.error) h.sendJson(res, 400, { ok: false, error: r.error });
      else h.sendJson(res, 200, { ok: !(r.out && r.out.ok === false), result: r.out });
      return true;
    }
    if (p === '/openapi.json' && req.method === 'GET') { h.sendJson(res, 200, openapi()); return true; }
    if (p === '/api/agent/info' && req.method === 'GET') {
      const recent = Date.now() - 60 * 60 * 1000;
      h.sendJson(res, 200, {
        ok: true, version: VERSION, port: ctx.port,
        mcpUrl: 'http://127.0.0.1:' + ctx.port + '/mcp', mcpScript: path.join(ctx.root, 'mcp.js'), node: process.execPath, root: ctx.root,
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, readOnly: !!t.annotations.readOnlyHint })),
        clients: [...sessions.values()].filter((s) => s.lastSeen > recent).sort((x, y) => y.lastSeen - x.lastSeen).map((s) => ({ name: s.name, version: s.version, lastSeen: s.lastSeen, calls: s.calls })),
        activity: activity.slice(0, 30),
      });
      return true;
    }
    return false;
  }

  return { route, tools: TOOLS, callTool };
};
