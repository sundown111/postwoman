// Lazy, searchable JSON tree viewer. Children render only when a node is expanded,
// so very large payloads stay fast.
(function (root) {
  'use strict';

  const CHUNK = 200; // array/object children rendered per "show more" click

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v; // object | string | number | boolean
  }

  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  function childPath(parent, key, isIndex) {
    if (isIndex) return parent + '[' + key + ']';
    return IDENT.test(key) ? parent + '.' + key : parent + '[' + JSON.stringify(key) + ']';
  }

  function previewOf(v) {
    if (Array.isArray(v)) return v.length === 0 ? '[]' : '[' + v.length + ']';
    return Object.keys(v).length === 0 ? '{}' : '{' + Object.keys(v).length + '}';
  }

  // Compute which paths must be open + which nodes match a query.
  function computeSearch(data, q, limit) {
    const open = new Set(), hits = new Set();
    const needle = q.toLowerCase();
    let count = 0;
    (function walk(v, path) {
      if (count >= limit) return false;
      let matched = false;
      const isC = v !== null && typeof v === 'object';
      if (isC) {
        const isArr = Array.isArray(v);
        const keys = isArr ? null : Object.keys(v);
        const n = isArr ? v.length : keys.length;
        for (let i = 0; i < n; i++) {
          const k = isArr ? i : keys[i];
          const p = childPath(path, k, isArr);
          const child = v[k];
          const keyHit = !isArr && String(k).toLowerCase().includes(needle);
          const childHit = walk(child, p);
          if (keyHit) { hits.add(p); count++; }
          if (keyHit || childHit) { matched = true; }
        }
        if (matched) open.add(path);
      } else if (String(v).toLowerCase().includes(needle)) {
        hits.add(path); count++; matched = true;
      }
      return matched;
    })(data, '$');
    return { open, hits, count };
  }

  function create(container, data, opts) {
    opts = opts || {};
    const state = { open: new Set(), hits: new Set(), query: '' };
    const defaultDepth = opts.expandDepth == null ? 1 : opts.expandDepth;
    let flash = null;

    function copy(text, anchor) {
      const done = () => {
        if (flash) clearTimeout(flash);
        anchor.classList.add('copied');
        flash = setTimeout(() => anchor.classList.remove('copied'), 700);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => {});
      else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch { /* ignore */ }
        ta.remove();
      }
    }

    function valueSpan(v) {
      const t = typeOf(v);
      if (t === 'string') {
        const s = el('span', 'jt-str');
        const shown = v.length > 500 ? v.slice(0, 500) : v;
        s.textContent = JSON.stringify(shown).slice(0, -1) + (v.length > 500 ? '… (' + v.length + ' chars)' : '') + '"';
        if (v.length > 500) s.title = 'Click row to copy full value';
        return s;
      }
      return el('span', 'jt-' + (t === 'number' ? 'num' : t === 'boolean' ? 'bool' : 'null'), String(v));
    }

    function makeNode(key, v, path, isIndex, depth) {
      const isC = v !== null && typeof v === 'object';
      const row = el('div', 'jt-row');
      const wrap = el('div', 'jt-node');
      wrap.appendChild(row);
      row.dataset.path = path;

      const caret = el('span', 'jt-caret', isC ? '▸' : '');
      row.appendChild(caret);
      if (key !== null) {
        row.appendChild(el('span', isIndex ? 'jt-idx' : 'jt-key', isIndex ? String(key) : JSON.stringify(key)));
        row.appendChild(el('span', 'jt-colon', ': '));
      }
      if (state.hits.has(path)) row.classList.add('hit');

      if (!isC) {
        row.appendChild(valueSpan(v));
        row.addEventListener('click', (e) => {
          if (e.altKey) copy(path, row);
          else copy(typeof v === 'string' ? v : JSON.stringify(v), row);
        });
        row.title = 'Click: copy value · Alt+click: copy path\n' + path;
        return wrap;
      }

      const isArr = Array.isArray(v);
      row.appendChild(el('span', 'jt-brace', isArr ? '[' : '{'));
      const summary = el('span', 'jt-sum', ' ' + (isArr ? v.length + (v.length === 1 ? ' item' : ' items') : Object.keys(v).length + (Object.keys(v).length === 1 ? ' key' : ' keys')) + ' ');
      row.appendChild(summary);
      const closeInline = el('span', 'jt-brace', isArr ? ']' : '}');
      row.appendChild(closeInline);

      const kids = el('div', 'jt-kids');
      let rendered = false, isOpen = false;

      const fill = () => {
        if (rendered) return;
        rendered = true;
        const keys = isArr ? null : Object.keys(v);
        const n = isArr ? v.length : keys.length;
        let shown = 0;
        const more = el('div', 'jt-more');
        const renderMore = () => {
          const end = Math.min(n, shown + CHUNK);
          for (let i = shown; i < end; i++) {
            const k = isArr ? i : keys[i];
            kids.insertBefore(makeNode(k, v[k], childPath(path, k, isArr), isArr, depth + 1), more);
          }
          shown = end;
          if (shown >= n) more.remove();
          else more.textContent = 'Show ' + Math.min(CHUNK, n - shown) + ' more (' + (n - shown) + ' left)';
        };
        more.addEventListener('click', renderMore);
        kids.appendChild(more);
        renderMore();
      };

      const set = (open) => {
        isOpen = open;
        if (open) { fill(); state.open.add(path); } else state.open.delete(path);
        wrap.classList.toggle('open', open);
        caret.textContent = open ? '▾' : '▸';
        closeInline.style.display = open ? 'none' : '';
        summary.style.display = open ? 'none' : '';
        row.dataset.open = open ? '1' : '0';
      };
      wrap.appendChild(kids);
      const empty = (isArr ? v.length : Object.keys(v).length) === 0;
      if (empty) { caret.textContent = ''; summary.textContent = ' '; return wrap; }

      row.addEventListener('click', (e) => {
        if (e.altKey) { copy(path, row); return; }
        set(!isOpen);
      });
      row.title = 'Click: expand/collapse · Alt+click: copy path\n' + path;
      const auto = state.open.size || state.query ? state.open.has(path) : depth < defaultDepth;
      set(auto);
      // expose for expandAll / collapseAll
      wrap._set = set;
      return wrap;
    }

    function draw() {
      container.textContent = '';
      const tree = el('div', 'jt');
      tree.appendChild(makeNode(null, data, '$', false, 0));
      container.appendChild(tree);
    }

    function expandAll(maxNodes) {
      const limit = maxNodes || 5000;
      let n = 0;
      state.open = new Set();
      (function walk(v, path) {
        if (v === null || typeof v !== 'object' || n > limit) return;
        n++; state.open.add(path);
        const isArr = Array.isArray(v);
        for (const k of Object.keys(v)) walk(v[k], childPath(path, k, isArr));
      })(data, '$');
      state.query = state.query || ' ';
      draw();
      return n > limit;
    }

    function collapseAll() { state.open = new Set(['$']); state.query = ' '; draw(); }

    function search(q) {
      q = (q || '').trim();
      state.query = q;
      if (!q) { state.open = new Set(); state.hits = new Set(); draw(); return { count: 0 }; }
      const r = computeSearch(data, q, 2000);
      state.open = r.open; state.hits = r.hits;
      if (!state.open.size) state.open.add('$');
      draw();
      const first = container.querySelector('.jt-row.hit');
      if (first) first.scrollIntoView({ block: 'center' });
      return { count: r.count, capped: r.count >= 2000 };
    }

    draw();
    return { expandAll, collapseAll, search, redraw: draw };
  }

  root.JsonTree = { create };
})(window);
