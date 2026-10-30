// Sending, bench runs, response viewer (tree / pretty / raw / preview), headers, timing, latency stats.
(function () {
  'use strict';
  const { h } = PW;
  PW.running = {};
  const respSub = {}, bodyView = {};
  const SVG = 'http://www.w3.org/2000/svg';

  // ---------- build the outgoing request (shared with the server's AI-agent tools: public/reqspec.js) ----------
  PW.buildSpec = ReqSpec.buildSpec;
  PW.pickPath = ReqSpec.pickPath;

  PW.jsonOf = function (res) {
    if (res._json !== undefined) return res._json;
    res._json = null;
    if (res.isText && res.body && res.body.length < 40e6) {
      const t = res.body.trim();
      if (/json/i.test(res.contentType) || t[0] === '{' || t[0] === '[') { try { res._json = { v: JSON.parse(t) }; } catch { /* not JSON */ } }
    }
    return res._json;
  };

  // ---------- send ----------
  PW.send = async function (tabId, o) {
    o = o || {};
    const tab = PW.tab(tabId);
    const missing = new Set();
    const spec = PW.buildSpec(tab, o.map || PW.varMap(), missing);
    if (missing.size) return { ok: false, code: 'EMISSING', missing: [...missing], error: 'Undefined variable' + (missing.size > 1 ? 's' : '') + ': ' + [...missing].map((m) => '{{' + m + '}}').join(', ') };
    let data;
    try {
      const r = await fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec), signal: o.signal });
      data = await r.json();
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, code: 'ABORT', error: 'Cancelled' };
      return { ok: false, code: 'ESERVER', error: 'Cannot reach the Postwoman server (' + e.message + '). Is `node server.js` still running?' };
    }
    data.at = Date.now();
    data.reqUrl = spec.url; data.reqMethod = spec.method;
    if (o.record === false) return data; // compare runs: keep latency stats and captures untouched
    tab.samples.push({ t: data.at, ms: data.ok ? data.timings.total : null, status: data.ok ? data.status : 0, ok: !!data.ok });
    if (tab.samples.length > PW.MAX_SAMPLES) tab.samples.splice(0, tab.samples.length - PW.MAX_SAMPLES);
    if (data.ok && tab.captures.length) {
      const j = PW.jsonOf(data);
      if (j) for (const c of tab.captures) {
        if (!c.key || !c.value) continue;
        const v = PW.pickPath(j.v, c.value);
        if (v !== undefined && v !== null) { PW.setVar(c.key.trim(), typeof v === 'object' ? JSON.stringify(v) : String(v)); if (!o.quiet) PW.toast('Captured {{' + c.key.trim() + '}}'); }
      }
    }
    // Tests run after captures, so a check can use a variable captured from this very response
    const tests = Checks.evaluate(tab.tests, data, o.map || PW.varMap());
    if (tests.length) data.tests = tests;
    PW.save();
    return data;
  };

  PW.sendActive = async function () {
    const id = PW.state.activeTabId;
    const tab = PW.tab(id);
    if (PW.running[id]) { PW.running[id].ctl.abort(); return; }
    if (Curl.looksLikeCurl(tab.url) && PW.applyCurl(tab, tab.url) === false) return;
    if (!tab.url.trim()) { PW.toast('Enter a URL first'); const i = PW.$('.urlbar input'); i && i.focus(); return; }
    const ctl = new AbortController();
    PW.running[id] = { ctl, started: Date.now() };
    respSub[id] = respSub[id] === 'stats' || respSub[id] === 'timing' || respSub[id] === 'headers' ? respSub[id] : 'body';
    PW.emit('running');
    if (id === PW.state.activeTabId) PW.renderResponse();
    const res = await PW.send(id, { signal: ctl.signal });
    delete PW.running[id];
    if (res.code !== 'ABORT') PW.responses[id] = res;
    PW.emit('running'); PW.emit('response', id);
  };

  // ---------- bench ----------
  PW.bench = async function (id, n, conc, onTick) {
    if (PW.running[id]) return;
    const ctl = new AbortController();
    const run = PW.running[id] = { ctl, bench: true, done: 0, n, started: Date.now() };
    PW.emit('running');
    if (id === PW.state.activeTabId) PW.renderResponse();
    let next = 0, fatal = null, last = null;
    const worker = async () => {
      while (!ctl.signal.aborted && !fatal) {
        const i = next++; if (i >= n) break;
        const r = await PW.send(id, { signal: ctl.signal, quiet: true });
        if (r.code === 'ABORT') break;
        if (r.code === 'EMISSING' || r.code === 'ESERVER') { fatal = r; break; }
        run.done++; last = r;
        onTick && onTick(run);
      }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    delete PW.running[id];
    if (last) PW.responses[id] = last;
    if (fatal) { PW.responses[id] = fatal; respSub[id] = 'body'; }
    PW.save(); PW.emit('running'); PW.emit('response', id);
    return run.done;
  };

  PW.bind('running', document.body, () => {});
  PW.on('running', () => {
    const b = PW.$('#sendBtn'); if (!b) return;
    const r = PW.running[PW.state.activeTabId];
    b.textContent = r ? (r.bench || r.compare ? 'Stop ■' : 'Cancel ■') : 'Send ▸';
    b.classList.toggle('danger', !!r);
    const c = PW.$('#compareBtn');
    if (c) c.disabled = !!r;
  });

  // ---------- rendering ----------
  const clsOf = (st) => 's' + Math.floor(st / 100);
  PW.clsOf = clsOf;

  // Shared busy indicator for any in-flight work in the response area. Pass `started` to show a live timer.
  PW.loader = function (title, sub, started, extra) {
    const time = h('div', { class: 'ld-time' });
    const box = h('div', { class: 'loader', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'spinner' }), h('h3', null, title), sub ? h('div', { class: 'hint' }, sub) : null, extra || null, started ? time : null);
    if (started) {
      let attached = false;
      const tick = () => {
        if (box.isConnected) attached = true;
        else if (attached) { clearInterval(iv); return; }
        time.textContent = PW.fmtMs(Date.now() - started);
      };
      const iv = setInterval(tick, 100);
      tick();
    }
    return box;
  };
  PW.spin = () => h('span', { class: 'spin', 'aria-hidden': 'true' });
  PW.showResponseTab = function (id, sub) { respSub[id] = sub; if (id === PW.state.activeTabId) PW.renderResponse(); };

  function placeholder(title, sub) {
    return h('div', { class: 'placeholder' }, h('div', null, h('div', { style: { fontSize: '30px' } }, '⚡'), h('h3', null, title), h('div', null, sub)));
  }

  function errorView(res, tab) {
    const box = h('div', { class: 'errbox' }, h('b', null, res.code === 'EMISSING' ? 'Missing variables' : 'Request failed'), h('div', { style: { margin: '6px 0' } }, res.error));
    if (res.code && res.code !== 'EMISSING') box.append(h('div', { class: 'hint', style: { fontFamily: 'var(--mono)' } }, res.code));
    if (res.missing) {
      const env = PW.activeEnv() || PW.globals();
      box.append(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
        res.missing.map((m) => h('button', { class: 'btn', onclick: () => PW.prompt('Value for {{' + m + '}}  →  ' + env.name, '', (v) => { PW.setVar(m, v); PW.sendActive(); }) }, '＋ Set {{' + m + '}}'))));
    }
    return box;
  }

  // One huge <pre> freezes the page (measured: Pretty view of a 20 MB JSON = ~50 s), so big bodies are shown in slices.
  const SLICE = 1e6;
  function slicedText(text) {
    if (text.length <= SLICE * 1.5) return h('pre', { class: 'code' }, text);
    const box = h('div');
    const pre = h('pre', { class: 'code' });
    const foot = h('div', { class: 'treebar' });
    box.append(pre, foot);
    let shown = 0;
    const step = () => {
      let end = Math.min(text.length, shown + SLICE);
      if (end < text.length) { const nl = text.indexOf('\n', end); if (nl !== -1 && nl - end < 4000) end = nl + 1; } // finish the current line
      pre.append(text.slice(shown, end));
      shown = end;
      foot.replaceChildren();
      if (shown < text.length) {
        foot.append(
          h('button', { class: 'btn', onclick: step }, 'Show next ' + PW.fmtBytes(Math.min(SLICE, text.length - shown))),
          h('span', { class: 'hint' }, 'Showing ' + PW.fmtBytes(shown) + ' of ' + PW.fmtBytes(text.length) + ' (large bodies are shown in slices to keep the page fast). Tree view has search; Copy and Download always use the full body.'));
      }
    };
    step();
    return box;
  }

  function bodyTab(res, tab) {
    const id = tab.id;
    const json = PW.jsonOf(res);
    const isHtml = /html/i.test(res.contentType), isImg = /^image\//i.test(res.contentType);
    const views = [];
    if (res.isText) {
      if (json) views.push(['tree', 'Tree']);
      views.push(['pretty', 'Pretty'], ['raw', 'Raw']);
      if (isHtml) views.push(['preview', 'Preview']);
    } else if (isImg) views.push(['preview', 'Preview']);
    let view = bodyView[id];
    if (!views.some((v) => v[0] === view)) view = views.length ? views[0][0] : 'none';
    bodyView[id] = view;

    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } });
    const top = h('div', { class: 'treebar' });
    views.length && top.append(h('div', { class: 'seg' }, views.map(([v, l]) => h('button', { class: view === v ? 'on' : '', onclick: () => { bodyView[id] = v; PW.renderResponse(); } }, l))));
    const content = h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' } });

    if (res.truncated) top.append(h('span', { class: 'hint' }, '⚠ Response exceeded 50 MB and was cut off.'));
    if (res.isText && !json && res.body && res.body.length >= 40e6 && /^\s*[[{]/.test(res.body.slice(0, 64))) top.append(h('span', { class: 'hint' }, 'Too large for Tree view (over 40 MB of text); Pretty and Raw are shown in slices.'));
    if (!res.size) { content.append(h('div', { class: 'hint' }, 'Empty response body.')); }
    else if (view === 'tree') {
      const q = h('input', { class: 'search', placeholder: 'Search keys & values…', spellcheck: 'false' });
      const info = h('span', { class: 'hint' });
      const tree = JsonTree.create(content, json.v, { expandDepth: 1 });
      let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { const r = tree.search(q.value); info.textContent = q.value.trim() ? (r.count ? r.count + (r.capped ? '+' : '') + ' match' + (r.count === 1 ? '' : 'es') : 'no matches') : ''; }, 160); });
      top.append(q, h('button', { class: 'btn', onclick: () => { const cut = tree.expandAll(); cut && PW.toast('Expanded first 5,000 nodes'); } }, 'Expand all'), h('button', { class: 'btn', onclick: () => tree.collapseAll() }, 'Collapse'), info,
        h('span', { class: 'hint', style: { marginLeft: 'auto' } }, 'click = copy value · Alt+click = copy path'));
    } else if (view === 'pretty') {
      if (json && res._pretty === undefined) res._pretty = JSON.stringify(json.v, null, 2);
      content.append(slicedText(json ? res._pretty : res.body));
    } else if (view === 'raw') {
      content.append(slicedText(res.body));
    } else if (view === 'preview') {
      if (isImg) content.append(h('img', { class: 'img-preview', src: 'data:' + res.contentType + ';base64,' + res.body }));
      else content.append(h('iframe', { class: 'preview', sandbox: '', srcdoc: res.body }));
    } else {
      content.append(h('div', { class: 'hint' }, 'Binary response (' + (res.contentType || 'unknown type') + ', ' + PW.fmtBytes(res.size) + '). Use Download to save it.'));
    }
    wrap.append(top, content);
    return wrap;
  }

  function testsView(res) {
    const r = res.tests || [];
    if (!r.length) return h('div', { class: 'hint' }, 'No tests ran for this response. Add checks in the request’s Tests tab.');
    const s = Checks.summarize(r);
    return h('div', null,
      h('div', { style: { marginBottom: '10px' } }, h('b', null, s.passed + ' of ' + s.total), ' tests passed'),
      r.map((x) => h('div', { class: 'test-res ' + (x.pass ? 'ok' : 'bad') }, h('span', { class: 'mark' }, x.pass ? '✓' : '✗'), h('span', { class: 'lbl' }, x.label),
        h('span', { class: 'act' }, x.error ? x.error : x.actual !== undefined ? 'got ' + x.actual : ''))));
  }

  function headersTab(res) {
    const t = h('table', { class: 'hdr' });
    res.headers.forEach(([k, v]) => t.append(h('tr', null, h('td', null, k), h('td', null, v))));
    const chain = res.redirects ? h('div', { style: { marginTop: '16px' } }, h('h4', null, 'Redirect chain'), res.chain.map((c, i) => h('div', { class: 'hdr', style: { fontFamily: 'var(--mono)', fontSize: '12px' } }, (i + 1) + '. ', h('span', { class: 'chip ' + clsOf(c.status), style: { padding: '0 7px' } }, c.status), ' ' + c.url))) : null;
    return h('div', null, t, chain);
  }

  function timingTab(res) {
    const T = res.timings;
    const phases = [['DNS lookup', T.dns, '#5ab0ff'], ['TCP connect', T.tcp, '#00e0b8'], ['TLS handshake', T.tls, '#c792ff'], ['Waiting (TTFB)', T.ttfb, '#ffc857'], ['Download', T.download, '#7be495']];
    const sum = phases.reduce((a, p) => a + (p[1] || 0), 0) || 1;
    const grid = h('div', { class: 'wf' });
    let off = 0;
    phases.forEach(([label, v, color]) => {
      const w = ((v || 0) / sum) * 100;
      grid.append(h('div', { class: 'lab' }, label), h('div', { class: 'track' }, v != null ? h('div', { class: 'bar', style: { left: off + '%', width: Math.max(w, 0.6) + '%', background: color } }) : null), h('div', { class: 'val' }, v == null ? 'n/a' : PW.fmtMs(v)));
      off += w;
    });
    const out = h('div', null, grid,
      h('div', { class: 'wf', style: { marginTop: '12px' } }, h('div', { class: 'lab', style: { color: 'var(--text)', fontWeight: 700 } }, 'Total'), h('div'), h('div', { class: 'val', style: { fontWeight: 700 } }, PW.fmtMs(T.total))));
    if (res.redirects) out.append(h('p', { class: 'hint' }, 'Followed ' + res.redirects + ' redirect' + (res.redirects > 1 ? 's' : '') + ': phases above are for the final request (' + PW.fmtMs(T.hop) + '); the earlier hops account for the rest of the total.'));
    out.append(h('p', { class: 'hint' }, 'Measured by the local server on a fresh connection per request (no keep-alive), so DNS/TCP/TLS are real costs every time. “n/a” = not applicable (IP address, or plain HTTP).'));
    return out;
  }

  // ---------- stats ----------
  function el(tag, attrs, ...kids) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    kids.forEach((k) => e.append(k));
    return e;
  }

  function histogramSvg(sum) {
    const bins = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(sum.sorted.length))));
    const hist = Stats.histogram(sum.sorted, bins);
    const W = 520, H = 130, pad = 22;
    const max = Math.max(...hist.map((b) => b.count)) || 1;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H + 18}`, width: '100%', style: 'max-width:640px' });
    const bw = (W - pad) / hist.length;
    hist.forEach((b, i) => {
      const bh = (b.count / max) * (H - 14);
      const r = el('rect', { x: pad + i * bw + 1, y: H - bh, width: Math.max(1, bw - 2), height: bh, rx: 3, fill: 'var(--accent)', opacity: 0.85 });
      r.append(el('title', {}, PW.fmtMs(b.from) + ' – ' + PW.fmtMs(b.to) + ': ' + b.count));
      svg.append(r);
    });
    const lo = sum.sorted[0], hi = sum.sorted[sum.sorted.length - 1], span = hi - lo || 1;
    const mark = (v, label, color) => {
      const x = pad + ((v - lo) / span) * (W - pad - 2);
      svg.append(el('line', { x1: x, x2: x, y1: 4, y2: H, stroke: color, 'stroke-dasharray': '3 3', 'stroke-width': 1.4 }));
      const t = el('text', { x: Math.min(x + 3, W - 28), y: 12, fill: color, 'font-size': 10, 'font-family': 'var(--mono)' }); t.textContent = label; svg.append(t);
    };
    if (hi > lo) { mark(sum.p50, 'p50', 'var(--accent2)'); mark(sum.p95, 'p95', 'var(--warn)'); if (sum.p99 !== sum.p95) mark(sum.p99, 'p99', 'var(--bad)'); }
    const t1 = el('text', { x: pad, y: H + 14, fill: 'var(--dim)', 'font-size': 10, 'font-family': 'var(--mono)' }); t1.textContent = PW.fmtMs(lo);
    const t2 = el('text', { x: W - 2, y: H + 14, fill: 'var(--dim)', 'font-size': 10, 'font-family': 'var(--mono)', 'text-anchor': 'end' }); t2.textContent = PW.fmtMs(hi);
    svg.append(t1, t2);
    return svg;
  }

  function seriesSvg(samples) {
    const last = samples.slice(-120);
    const W = 520, H = 70;
    const ok = last.filter((s) => s.ok);
    if (ok.length < 2) return null;
    const max = Math.max(...ok.map((s) => s.ms)), min = Math.min(...ok.map((s) => s.ms)), span = max - min || 1;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', style: 'max-width:640px' });
    const step = W / Math.max(1, last.length - 1);
    let d = '';
    last.forEach((s, i) => { if (!s.ok) return; const x = i * step, y = H - 6 - ((s.ms - min) / span) * (H - 14); d += (d ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); });
    svg.append(el('path', { d, fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }));
    last.forEach((s, i) => { if (!s.ok) svg.append(el('line', { x1: i * step, x2: i * step, y1: 0, y2: H, stroke: 'var(--bad)', opacity: 0.6 })); });
    return svg;
  }

  const codeColor = (c) => (c === 'ERR' ? 'var(--bad)' : c[0] === '2' ? 'var(--ok)' : c[0] === '3' ? 'var(--info)' : c[0] === '4' ? 'var(--warn)' : 'var(--bad)');

  function statsTab(tab) {
    const id = tab.id;
    const root = h('div');
    const nIn = h('input', { type: 'number', min: 1, max: 2000, value: PW.benchN || 20 });
    const cIn = h('input', { type: 'number', min: 1, max: 50, value: PW.benchC || 1 });
    const prog = h('div', { class: 'progress', id: 'benchProg' }, h('i'));
    const run = PW.running[id];
    const go = h('button', { class: 'btn primary', onclick: () => {
      if (PW.running[id]) { PW.running[id].ctl.abort(); return; }
      const n = Math.min(2000, Math.max(1, parseInt(nIn.value, 10) || 20)), c = Math.min(50, Math.max(1, parseInt(cIn.value, 10) || 1));
      PW.benchN = n; PW.benchC = c;
      PW.bench(id, n, c, (r) => { const live = PW.$('#benchProg i'); if (live) live.style.width = (r.done / r.n * 100) + '%'; });
    } }, run && run.bench ? 'Stop ■' : 'Run ▸');
    if (run && !run.bench) go.disabled = true;
    if (run && run.bench) prog.firstChild.style.width = (run.done / run.n * 100) + '%';
    const clear = h('button', { class: 'btn ghost', onclick: () => { tab.samples = []; PW.save(); PW.renderResponse(); } }, 'Clear samples');
    root.append(h('div', { class: 'benchbar' }, h('span', null, 'Run'), nIn, h('span', null, '× at concurrency'), cIn, go, prog, clear),
      h('p', { class: 'hint', style: { margin: '-4px 0 12px' } }, 'Quick browser-side sampling: use concurrency 1 for clean latency numbers. For real load (virtual users, ramp-up, p99.99, SLA verdict) use the Load test tab. Only hammer servers you own. Every manual Send counts as a sample too.'));

    const sum = Stats.summarize(tab.samples.map((s) => ({ ms: s.ms, status: s.status, ok: s.ok })));
    if (!sum) { root.append(placeholder('No samples yet', 'Send the request or press Run ▸ to collect latency data.')); return root; }

    const card = (label, v, hot) => h('div', { class: 'card' + (hot ? ' hot' : '') }, h('small', null, label), h('b', null, v));
    const okRate = ((sum.count - sum.errors - sum.classes['4xx'] - sum.classes['5xx']) / sum.count * 100);
    root.append(h('div', { class: 'cards' },
      card('Samples', sum.count), card('Success',okRate.toFixed(okRate % 1 ? 1 : 0) + '%'),
      card('Min', PW.fmtMs(sum.min)), card('Avg', PW.fmtMs(sum.avg)), card('p50', PW.fmtMs(sum.p50)), card('p90', PW.fmtMs(sum.p90)),
      card('p95', PW.fmtMs(sum.p95), true), card('p99', PW.fmtMs(sum.p99), true), card('Max', PW.fmtMs(sum.max)), card('Std dev', PW.fmtMs(sum.sd)),
      card('Errors', sum.errors)));
    if (sum.timed < 100) root.append(h('p', { class: 'hint', style: { marginTop: '-6px' } }, 'ⓘ Percentiles use nearest-rank over ' + sum.timed + ' responses' + (sum.timed < 20 ? ' — p95/p99 are basically the slowest request until you have more samples (≥100 for a meaningful p99).' : '; p99 needs ≥100 samples to be meaningful.')));

    const left = h('div');
    if (sum.sorted.length) { left.append(h('h4', null, 'Latency distribution'), histogramSvg(sum)); const s = seriesSvg(tab.samples); if (s) left.append(h('h4', { style: { marginTop: '14px' } }, 'Last ' + Math.min(120, tab.samples.length) + ' samples (red = failed)'), s); }
    const right = h('div');
    const codes = Object.entries(sum.codes).sort((a, b) => b[1] - a[1]);
    right.append(h('h4', null, 'Status codes'), h('div', { class: 'codes' }, codes.map(([c, n]) => h('div', { class: 'r' }, h('span', { style: { color: codeColor(c) } }, c), h('div', { class: 'track' }, h('i', { style: { width: (n / sum.count * 100) + '%', background: codeColor(c) } })), h('span', { style: { textAlign: 'right' } }, n)))));
    root.append(h('div', { class: 'grid2' }, left, right));
    return root;
  }

  // ---------- main renderer ----------
  PW.renderResponse = function () {
    const pane = PW.$('#respane'); if (!pane) return;
    const tab = PW.tab(), id = tab.id;
    const res = PW.responses[id];
    const run = PW.running[id];
    let sub = respSub[id] || 'body';
    pane.textContent = '';

    const bar = h('div', { class: 'rbar' });
    if (run && run.compare) bar.append(h('span', { class: 'metric' }, PW.spin(), ' Comparing across ', h('b', null, run.envs), ' environments…'));
    else if (run && run.bench) bar.append(h('span', { class: 'metric' }, PW.spin(), ' Running benchmark (', h('b', null, run.n), ' requests)…'));
    else if (run) bar.append(h('span', { class: 'metric' }, PW.spin(), ' Sending ', h('b', null, tab.method), ' request…'));
    else if (res && res.ok) {
      const ts = res.tests ? Checks.summarize(res.tests) : null;
      bar.append(h('span', { class: 'chip ' + clsOf(res.status) }, res.status + ' ' + res.statusText),
        ...(ts ? [h('span', { class: 'chip testchip ' + (ts.failed ? 's5' : 's2'), title: 'Show test results', onclick: () => PW.showResponseTab(id, 'tests') }, (ts.failed ? '✗ ' + ts.failed + ' of ' + ts.total + ' tests failed' : '✓ ' + (ts.total === 1 ? '1 test passed' : ts.total + ' tests passed')))] : []),
        h('span', { class: 'metric' }, 'Time ', h('b', null, PW.fmtMs(res.timings.total))),
        h('span', { class: 'metric' }, 'TTFB ', h('b', null, PW.fmtMs((res.timings.dns || 0) + (res.timings.tcp || 0) + (res.timings.tls || 0) + (res.timings.ttfb || 0)))),
        h('span', { class: 'metric' }, 'Size ', h('b', null, PW.fmtBytes(res.size)), res.wireSize !== res.size ? h('span', { class: 'hint' }, ' (' + PW.fmtBytes(res.wireSize) + ' on wire)') : null),
        ...(res.redirects ? [h('span', { class: 'metric' }, 'Redirects ', h('b', null, res.redirects))] : []), // spread: native append() would print "null"
        h('span', { class: 'metric', style: { marginLeft: 'auto' } }, 'HTTP/' + res.httpVersion + ' · ' + new Date(res.at).toLocaleTimeString()));
    } else if (res) bar.append(h('span', { class: 'chip s0' }, 'ERROR'), h('span', { class: 'metric' }, res.code || ''));
    else bar.append(h('span', { class: 'metric' }, 'Response will appear here'));
    const lchip = PW.loadChip && PW.loadChip(id);
    if (lchip) bar.prepend(lchip);

    const hasRes = res && res.ok;
    const nSamples = tab.samples.length;
    const defs = [['body', 'Body'], ['headers', 'Headers' + (hasRes ? ' ' : '')], ['timing', 'Timing']];
    if ((tab.tests || []).length || (res && res.tests)) defs.push(['tests', 'Tests']);
    defs.push(['stats', 'Latency stats'], ['compare', 'Compare envs'], ['load', 'Load test']);
    const tsum = res && res.tests ? Checks.summarize(res.tests) : null;
    const tabs = h('div', { class: 'tabs' });
    const nCmp = PW.compares && PW.compares[id] ? PW.compares[id].envs.length : 0;
    const nLoad = PW.loads && PW.loads[id] ? '●' : (tab.loadRuns || []).length;
    defs.forEach(([k, l]) => tabs.append(h('button', { class: sub === k ? 'on' : '', onclick: () => { respSub[id] = k; PW.renderResponse(); } }, l,
      k === 'headers' && hasRes ? h('span', { class: 'badge' }, res.headers.length) : null, k === 'stats' && nSamples ? h('span', { class: 'badge' }, nSamples) : null,
      k === 'tests' && tsum ? h('span', { class: 'badge ' + (tsum.failed ? 'bad' : 'good') }, tsum.failed ? '✗ ' + tsum.failed : '✓ ' + tsum.passed) : null,
      k === 'compare' && nCmp ? h('span', { class: 'badge' }, nCmp) : null, k === 'load' && nLoad ? h('span', { class: 'badge' + (nLoad === '●' ? ' live' : '') }, nLoad) : null)));
    if (hasRes && sub === 'body' && res.size && !run) {
      tabs.append(h('div', { class: 'right' },
        h('button', { class: 'btn ghost', onclick: () => PW.copy(res.isText ? res.body : '', res.isText ? 'Body copied' : 'Binary body cannot be copied as text') }, 'Copy'),
        h('button', { class: 'btn ghost', onclick: () => {
          const ext = /json/i.test(res.contentType) ? 'json' : /html/i.test(res.contentType) ? 'html' : res.isText ? 'txt' : 'bin';
          if (res.isText) PW.download('response.' + ext, res.body, res.contentType || 'text/plain');
          else { const bin = atob(res.body); const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0)); PW.download('response.' + ext, u8, res.contentType || 'application/octet-stream'); }
        } }, 'Download')));
    }
    const body = h('div', { class: 'body' });

    if (sub === 'stats') body.append(statsTab(tab));
    else if (sub === 'compare') body.append(PW.compareTab(tab));
    else if (sub === 'load') body.append(PW.loadTab(tab));
    else if (run && run.compare) body.append(PW.loader('Comparing environments…', 'Results are in the Compare envs tab', run.started));
    else if (run && run.bench) body.append(PW.loader('Running benchmark…', 'Progress is in the Latency stats tab · press Stop to end early', run.started));
    else if (run) body.append(PW.loader('Sending request…', 'Press Cancel (or Ctrl+Enter) to stop', run.started));
    else if (!res) body.append(placeholder('Hit Send ▸', 'Ctrl+Enter sends · ⇆ Compare runs it in several environments · paste a cURL command anywhere to import it'));
    else if (!res.ok) body.append(errorView(res, tab));
    else if (sub === 'tests') body.append(testsView(res));
    else if (sub === 'body') { body.style.padding = '10px 14px 0'; body.style.display = 'flex'; body.style.flexDirection = 'column'; body.append(bodyTab(res, tab)); }
    else if (sub === 'headers') body.append(headersTab(res));
    else if (sub === 'timing') body.append(timingTab(res));
    pane.append(bar, tabs, body);
  };

  PW.on('response', (id) => { if (id === PW.state.activeTabId) PW.renderResponse(); });
})();
