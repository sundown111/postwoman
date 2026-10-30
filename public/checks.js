// Declarative response checks ("Tests"). No scripting / eval: every check is { type, target, op, value }.
// Pure functions (browser + Node). Depends on loadkit.js (status rules) and reqspec.js ({{variables}}, JSON paths).
(function (root) {
  'use strict';

  const Kit = typeof module !== 'undefined' && module.exports ? require('./loadkit.js') : root.LoadKit;
  const Req = typeof module !== 'undefined' && module.exports ? require('./reqspec.js') : root.ReqSpec;

  const OPS = {
    exists: 'exists', notExists: 'does not exist', equals: 'equals', notEquals: 'does not equal', contains: 'contains', notContains: 'does not contain',
    matches: 'matches regex', gt: '>', gte: '≥', lt: '<', lte: '≤', type: 'has type', is: 'is',
  };
  // type -> { label, ops, target? (what the "target" box means), value? (placeholder) }
  const TYPES = {
    status: { label: 'Status', ops: ['is'], value: '2xx   or   200   or   200-299, 404' },
    time: { label: 'Response time (ms)', ops: ['lte', 'lt'], value: '500' },
    json: { label: 'JSON path', ops: ['exists', 'notExists', 'equals', 'notEquals', 'contains', 'matches', 'gt', 'gte', 'lt', 'lte', 'type'], target: 'data.items[0].id', value: 'expected value' },
    header: { label: 'Header', ops: ['exists', 'notExists', 'equals', 'contains', 'matches'], target: 'Content-Type', value: 'application/json' },
    body: { label: 'Body text', ops: ['contains', 'notContains', 'matches'], value: 'text or regex' },
  };
  const NO_VALUE = new Set(['exists', 'notExists']);
  const MAX_TEXT = 1e6; // regexes only ever see the first 1 MB

  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  function deepEq(a, b) {
    if (a === b) return true;
    if (typeOf(a) !== typeOf(b) || a === null || typeof a !== 'object') return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
  }
  // "123" matches both the number 123 and the string "123"; objects/arrays/true/null are compared as JSON.
  function looseEq(actual, expected) {
    let parsed, ok = false;
    try { parsed = JSON.parse(expected); ok = true; } catch { /* plain text */ }
    if (ok && deepEq(actual, parsed)) return true;
    return actual !== null && typeof actual !== 'object' && String(actual) === String(expected);
  }
  const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  // strings are shown quoted so "7" (text) and 7 (number) can be told apart
  const preview = (v) => { const s = v === undefined ? 'undefined' : JSON.stringify(v); return s.length > 80 ? s.slice(0, 77) + '…' : s; };

  function jsonOf(res) {
    if (res._json !== undefined) return res._json;
    res._json = null;
    if (res.isText && res.body && res.body.length < 40e6) { try { res._json = { v: JSON.parse(res.body.trim()) }; } catch { /* not JSON */ } }
    return res._json;
  }

  function compare(op, actual, expected) {
    switch (op) {
      case 'exists': return actual !== undefined;
      case 'notExists': return actual === undefined;
      case 'equals': return actual !== undefined && looseEq(actual, expected);
      case 'notEquals': return actual === undefined || !looseEq(actual, expected);
      case 'contains': return typeof actual === 'string' ? actual.includes(expected) : Array.isArray(actual) ? actual.some((x) => looseEq(x, expected)) : false;
      case 'notContains': return typeof actual === 'string' ? !actual.includes(expected) : true;
      case 'matches': { const re = new RegExp(expected); return actual !== undefined && re.test(asText(actual).slice(0, MAX_TEXT)); }
      case 'type': return typeOf(actual) === String(expected).trim().toLowerCase();
      case 'gt': case 'gte': case 'lt': case 'lte': {
        const a = typeof actual === 'number' || (typeof actual === 'string' && actual.trim() !== '') ? Number(actual) : NaN, b = Number(expected);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      }
      default: throw new Error('Unknown operator "' + op + '"');
    }
  }

  function label(t) {
    const info = TYPES[t.type];
    if (!info) return 'Unknown check';
    const val = NO_VALUE.has(t.op) ? '' : ' ' + (t.value === '' || t.value == null ? '…' : t.value);
    if (t.type === 'status') return 'Status is ' + (t.value || '…');
    if (t.type === 'time') return 'Response time ' + (t.op === 'lt' ? '<' : '≤') + ' ' + (t.value || '…') + ' ms';
    if (t.type === 'body') return 'Body ' + OPS[t.op] + val;
    return (t.type === 'header' ? 'Header ' : 'JSON ') + (t.target || '…') + ' ' + OPS[t.op] + val;
  }

  // Runs one check. Returns { pass, actual, error? }
  function runOne(t, res, map) {
    const I = (s) => Req.interpolate(String(s == null ? '' : s), map || {});
    const value = I(t.value), target = I(t.target);
    if (!TYPES[t.type] || !TYPES[t.type].ops.includes(t.op)) return { pass: false, error: 'Invalid check' };
    switch (t.type) {
      case 'status': {
        const rule = Kit.parseStatusRule(value);
        if (rule.error) return { pass: false, error: rule.error };
        if (!value.trim()) return { pass: false, error: 'Enter a status, e.g. 2xx or 200' };
        return { pass: rule.test(res.status), actual: String(res.status) };
      }
      case 'time': {
        const limit = Number(value);
        if (!Number.isFinite(limit)) return { pass: false, error: 'Enter a number of milliseconds' };
        const ms = res.timings && res.timings.total;
        return { pass: t.op === 'lt' ? ms < limit : ms <= limit, actual: ms == null ? '' : Math.round(ms * 10) / 10 + ' ms' };
      }
      case 'header': {
        if (!target.trim()) return { pass: false, error: 'Enter a header name' };
        const vals = (res.headers || []).filter(([k]) => k.toLowerCase() === target.trim().toLowerCase()).map(([, v]) => v);
        const actual = vals.length ? vals.join(', ') : undefined;
        return { pass: compare(t.op, actual, value), actual: actual === undefined ? 'missing' : preview(actual) };
      }
      case 'body': {
        if (!res.isText) return { pass: false, error: 'The body is not text' };
        return { pass: compare(t.op, (res.body || '').slice(0, MAX_TEXT), value), actual: (res.size || 0) + ' bytes' };
      }
      case 'json': {
        const j = jsonOf(res);
        if (!j) return { pass: false, error: 'The body is not JSON' };
        if (!target.trim()) return { pass: false, error: 'Enter a JSON path, e.g. data.id' };
        const actual = Req.pickPath(j.v, target);
        return { pass: compare(t.op, actual, value), actual: actual === undefined ? 'missing' : preview(actual) };
      }
      default: return { pass: false, error: 'Invalid check' };
    }
  }

  // tests: tab.tests; res: a response from /api/send; map: variables for {{...}} inside targets/values
  function evaluate(tests, res, map) {
    const out = [];
    for (const t of tests || []) {
      if (!t || t.enabled === false) continue;
      let r;
      if (!res || res.ok === false) r = { pass: false, error: 'No response' + (res && res.error ? ': ' + res.error : '') };
      else { try { r = runOne(t, res, map); } catch (e) { r = { pass: false, error: e instanceof SyntaxError ? 'Invalid regular expression' : e.message }; } }
      out.push(Object.assign({ id: t.id, label: label(t) }, r));
    }
    return out;
  }

  const summarize = (results) => ({ total: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length });
  const make = (type) => ({ id: Math.random().toString(36).slice(2, 10), enabled: true, type: type || 'status', target: '', op: TYPES[type || 'status'].ops[0], value: type === 'time' ? '500' : type === 'status' ? '2xx' : '' });

  const api = { TYPES, OPS, NO_VALUE, evaluate, summarize, label, make, compare };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Checks = api;
})(typeof window !== 'undefined' ? window : globalThis);
