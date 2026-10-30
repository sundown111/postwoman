// Latency statistics. Pure functions (browser + Node).
(function (root) {
  'use strict';

  // Nearest-rank percentile on a SORTED ascending array: sorted[ceil(p/100 * n) - 1]
  function percentile(sorted, p) {
    const n = sorted.length;
    if (!n) return null;
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[n - 1];
    return sorted[Math.max(0, Math.ceil((p / 100) * n) - 1)];
  }

  // samples: [{ms:number, status:number|0, ok:boolean}]  (status 0 / ok=false => transport error)
  function summarize(samples) {
    const n = samples.length;
    if (!n) return null;
    const ok = samples.filter((s) => s.ok);
    const ms = ok.map((s) => s.ms).sort((a, b) => a - b);
    const sum = ms.reduce((a, b) => a + b, 0);
    const avg = ms.length ? sum / ms.length : null;
    let sd = null;
    if (ms.length > 1) sd = Math.sqrt(ms.reduce((a, b) => a + (b - avg) * (b - avg), 0) / (ms.length - 1));
    const codes = {};
    let errors = 0;
    for (const s of samples) {
      if (!s.ok) { errors++; codes.ERR = (codes.ERR || 0) + 1; }
      else {
        const k = String(s.status);
        codes[k] = (codes[k] || 0) + 1;
      }
    }
    const classes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, err: errors };
    for (const s of ok) {
      const c = Math.floor(s.status / 100);
      if (c >= 2 && c <= 5) classes[c + 'xx']++;
    }
    return {
      count: n,
      timed: ms.length, // samples that got a response (percentiles are computed on these)
      errors,
      min: ms.length ? ms[0] : null,
      max: ms.length ? ms[ms.length - 1] : null,
      avg,
      sd,
      p50: percentile(ms, 50),
      p90: percentile(ms, 90),
      p95: percentile(ms, 95),
      p99: percentile(ms, 99),
      codes,
      classes,
      sorted: ms,
    };
  }

  // Histogram with `bins` equal-width buckets between min and max.
  function histogram(sorted, bins) {
    if (!sorted.length) return [];
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    if (lo === hi) return [{ from: lo, to: hi, count: sorted.length }];
    const w = (hi - lo) / bins;
    const out = Array.from({ length: bins }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, count: 0 }));
    for (const v of sorted) out[Math.min(bins - 1, Math.floor((v - lo) / w))].count++;
    return out;
  }

  const api = { percentile, summarize, histogram };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Stats = api;
})(typeof window !== 'undefined' ? window : globalThis);
