// Load-test helpers shared by the server engine and the UI. Pure functions (browser + Node).
(function (root) {
  'use strict';

  // RFC-4180-ish CSV: quoted fields, "" escapes, CRLF/LF. First non-empty row = variable names.
  function parseCsv(text) {
    const s = String(text || '');
    const rows = [];
    let row = [], cur = '', q = false, i = 0;
    while (i < s.length) {
      const c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i += 2; continue; } q = false; i++; continue; }
        cur += c; i++; continue;
      }
      if (c === '"' && cur === '') { q = true; i++; continue; }
      if (c === ',') { row.push(cur); cur = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += c; i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    const kept = rows.filter((r) => r.some((x) => x.trim() !== ''));
    if (!kept.length) return { headers: [], rows: [] };
    return { headers: kept[0].map((x) => x.trim()), rows: kept.slice(1) };
  }

  // "200-399, 404, 2xx" -> { ranges, test(status) }  |  { error }
  function parseStatusRule(text) {
    const parts = String(text || '').split(/[,\s]+/).filter(Boolean);
    const ranges = [];
    for (const p of parts) {
      let m;
      if ((m = /^([1-5])xx$/i.exec(p))) ranges.push([+m[1] * 100, +m[1] * 100 + 99]);
      else if ((m = /^(\d{3})-(\d{3})$/.exec(p)) && +m[1] <= +m[2]) ranges.push([+m[1], +m[2]]);
      else if ((m = /^(\d{3})$/.exec(p))) ranges.push([+m[1], +m[1]]);
      else return { error: 'Invalid success status "' + p + '". Use e.g. 200, 2xx or 200-399.' };
    }
    if (!ranges.length) ranges.push([200, 399]);
    return { ranges, test: (st) => ranges.some((r) => st >= r[0] && st <= r[1]) };
  }

  // Planned duration in seconds (null for iteration mode: it ends when every user has finished its loops).
  function plannedSeconds(cfg) {
    if (cfg.mode === 'iterations') return null;
    return (cfg.rampUp || 0) + (cfg.hold || 0) + (cfg.rampDown || 0);
  }

  // Users that should be running at t seconds. Ramp-up matches JMeter: user i starts at i * rampUp / users.
  function targetUsers(cfg, t) {
    const n = cfg.users, ru = cfg.rampUp || 0;
    if (t < 0) return 0;
    const up = ru > 0 ? Math.min(n, Math.floor((t * n) / ru) + 1) : n;
    if (cfg.mode === 'iterations') return up;
    const downAt = ru + (cfg.hold || 0), rd = cfg.rampDown || 0;
    if (t >= downAt + rd) return 0;
    if (rd > 0 && t >= downAt) return Math.min(up, n - Math.floor(((t - downAt) * n) / rd));
    return up;
  }

  function profilePoints(cfg, steps) {
    const total = plannedSeconds(cfg) || Math.max(1, cfg.rampUp || 0) * 1.25 || 1;
    const out = [];
    const k = steps || 120;
    for (let i = 0; i <= k; i++) { const t = (total * i) / k; out.push([t, Math.min(cfg.users, targetUsers(cfg, Math.min(t, total - 1e-9)))]); }
    return out;
  }

  // Merge per-second buckets so long tests stay cheap to draw/persist. Percentile fields keep the worst second.
  function downsample(tl, max) {
    if (!tl || tl.length <= max) return tl;
    const k = Math.ceil(tl.length / max);
    const out = [];
    for (let i = 0; i < tl.length; i += k) {
      const g = tl.slice(i, i + k);
      const m = { t: g[0].t, span: 0, users: 0, n: 0, err: 0, avg: null, min: null, p50: null, p90: null, p95: null, p99: null, max: null, kb: 0, kbs: 0, c2: 0, c3: 0, c4: 0, c5: 0, ce: 0 };
      let sum = 0;
      for (const b of g) {
        m.span += b.span || 1; m.users = Math.max(m.users, b.users); m.n += b.n; m.err += b.err; m.kb += b.kb; m.kbs += b.kbs;
        m.c2 += b.c2; m.c3 += b.c3; m.c4 += b.c4; m.c5 += b.c5; m.ce += b.ce;
        if (b.n) {
          sum += b.avg * b.n;
          m.min = m.min == null ? b.min : Math.min(m.min, b.min);
          for (const f of ['p50', 'p90', 'p95', 'p99', 'max']) m[f] = m[f] == null ? b[f] : Math.max(m[f], b[f]);
        }
      }
      m.avg = m.n ? sum / m.n : null;
      out.push(m);
    }
    return out;
  }

  // Percentile <-> "nines" axis (0 -> 0, 90 -> 1, 99 -> 2, 99.9 -> 3, 99.99 -> 4)
  const nines = (p) => -Math.log10(Math.max(1e-5, 1 - p / 100));
  const fromNines = (x) => 100 * (1 - Math.pow(10, -x));

  const PCTS = [['p50', 50], ['p75', 75], ['p90', 90], ['p95', 95], ['p99', 99], ['p999', 99.9], ['p9999', 99.99]];

  const api = { parseCsv, parseStatusRule, plannedSeconds, targetUsers, profilePoints, downsample, nines, fromNines, PCTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LoadKit = api;
})(typeof window !== 'undefined' ? window : globalThis);
