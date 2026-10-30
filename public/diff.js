// Response comparison helpers. Pure functions (browser + Node).
(function (root) {
  'use strict';

  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const keyPath = (base, k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? base + '.' + k : base + '[' + JSON.stringify(k) + ']');

  // "a, b.c, items[0].id" -> Set; an entry matches a key name anywhere or a full path (with or without "$.")
  function parseIgnore(text) {
    return new Set(String(text || '').split(/[,\n]/).map((s) => s.trim().replace(/^\$\.?/, '')).filter(Boolean));
  }

  // Structural JSON diff. Returns { diffs:[{path, kind:'changed'|'added'|'removed'|'type', a, b}], capped }
  function diffJson(a, b, opts) {
    opts = opts || {};
    const ignore = opts.ignore instanceof Set ? opts.ignore : parseIgnore(opts.ignore);
    const max = opts.max || 500;
    const diffs = [];
    let capped = false;
    const skip = (path, key) => key != null && (ignore.has(String(key)) || ignore.has(path.replace(/^\$\.?/, '')));
    const add = (d) => { if (diffs.length >= max) { capped = true; return false; } diffs.push(d); return true; };

    const walk = (x, y, path) => {
      if (capped) return;
      const tx = typeOf(x), ty = typeOf(y);
      if (tx !== ty) { add({ path, kind: 'type', a: x, b: y }); return; }
      if (tx === 'array') {
        const n = Math.max(x.length, y.length);
        for (let i = 0; i < n && !capped; i++) {
          const p = path + '[' + i + ']';
          if (i >= x.length) add({ path: p, kind: 'added', b: y[i] });
          else if (i >= y.length) add({ path: p, kind: 'removed', a: x[i] });
          else walk(x[i], y[i], p);
        }
      } else if (tx === 'object') {
        const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
        for (const k of keys) {
          if (capped) return;
          const p = keyPath(path, k);
          if (skip(p, k)) continue;
          const inX = Object.prototype.hasOwnProperty.call(x, k), inY = Object.prototype.hasOwnProperty.call(y, k);
          if (!inY) add({ path: p, kind: 'removed', a: x[k] });
          else if (!inX) add({ path: p, kind: 'added', b: y[k] });
          else walk(x[k], y[k], p);
        }
      } else if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) add({ path, kind: 'changed', a: x, b: y });
    };
    walk(a, b, '$');
    return { diffs, capped };
  }

  // Line-based text comparison: { equal, changedLines, firstLine, a, b }
  function diffText(a, b) {
    a = String(a == null ? '' : a); b = String(b == null ? '' : b);
    if (a === b) return { equal: true, changedLines: 0 };
    const la = a.split(/\r?\n/), lb = b.split(/\r?\n/);
    const n = Math.max(la.length, lb.length);
    let changed = 0, first = -1;
    for (let i = 0; i < n; i++) if (la[i] !== lb[i]) { changed++; if (first < 0) first = i; }
    return { equal: false, changedLines: changed, firstLine: first + 1, a: la[first], b: lb[first] };
  }

  const api = { diffJson, diffText, parseIgnore, typeOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Diff = api;
})(typeof window !== 'undefined' ? window : globalThis);
