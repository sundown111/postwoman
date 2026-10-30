// Compare mode: fire the same request at several environments simultaneously, then compare latency and data.
(function () {
  'use strict';
  const { h } = PW;
  PW.compares = {};
  const baseSel = {}, openDiff = {};
  const MAX_RUNS = 50;

  const envChoices = () => PW.state.envs.filter((e) => e.id !== 'globals');
  // Must return the SAME object on every call: the input handlers hold on to it.
  function cfg(tab) {
    if (!tab.compare || typeof tab.compare !== 'object') tab.compare = {};
    const c = tab.compare;
    if (!(c.runs >= 1)) c.runs = 1;
    if (typeof c.ignore !== 'string') c.ignore = '';
    if (!Array.isArray(c.envs)) c.envs = envChoices().map((e) => e.id);
    return c;
  }
  const selectedEnvs = (tab) => { const ids = cfg(tab).envs; return envChoices().filter((e) => ids.includes(e.id)); };

  PW.envVarMap = function (envId) {
    const m = {};
    [PW.globals(), PW.env(envId)].forEach((env) => env && env.vars.forEach((v) => { if (v.enabled !== false && v.key) m[v.key] = v.value; }));
    return m;
  };

  const ttfbOf = (t) => (t.dns || 0) + (t.tcp || 0) + (t.tls || 0) + (t.ttfb || 0);
  const avgOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // ---------- run ----------
  PW.compare = async function (id) {
    const tab = PW.tab(id);
    if (PW.running[id]) return;
    if (Curl.looksLikeCurl(tab.url) && PW.applyCurl(tab, tab.url) === false) return;
    if (!tab.url.trim()) { PW.toast('Enter a URL first'); return; }
    const envs = selectedEnvs(tab);
    if (envs.length < 2) { PW.showResponseTab(id, 'compare'); PW.toast('Pick at least two environments to compare'); return; }
    const runs = Math.min(MAX_RUNS, Math.max(1, parseInt(cfg(tab).runs, 10) || 1));

    const ctl = new AbortController();
    const run = PW.running[id] = { ctl, compare: true, envs: envs.length, rounds: runs, round: 0, done: 0, n: runs * envs.length, started: Date.now() };
    const result = { at: Date.now(), method: tab.method, url: tab.url, runs, envs: envs.map((e) => ({ id: e.id, name: e.name, samples: [], last: null, error: null })) };
    PW.emit('running');
    PW.showResponseTab(id, 'compare');

    const tick = () => {
      const bar = PW.$('#cmpProg i'), txt = PW.$('#cmpProgTxt');
      if (bar) bar.style.width = (run.done / run.n * 100) + '%';
      if (txt) txt.textContent = 'Round ' + run.round + ' of ' + run.rounds + ' · ' + run.done + ' / ' + run.n + ' responses';
    };
    for (let r = 0; r < runs && !ctl.signal.aborted; r++) {
      run.round = r + 1; tick();
      // every environment gets the same request at the same moment, so they see the same conditions
      await Promise.all(result.envs.map(async (er) => {
        if (er.error) return;
        const res = await PW.send(id, { signal: ctl.signal, quiet: true, record: false, map: PW.envVarMap(er.id) });
        if (res.code === 'ABORT') return;
        if (res.code === 'EMISSING' || res.code === 'ESERVER') { er.error = res; run.done += runs - r; tick(); return; }
        er.samples.push(res.ok ? { ok: true, ms: res.timings.total, ttfb: ttfbOf(res.timings), status: res.status } : { ok: false, ms: null, status: 0, code: res.code });
        if (res.ok || !er.last || !er.last.ok) er.last = res;
        run.done++; tick();
      }));
    }
    result.aborted = ctl.signal.aborted;
    delete PW.running[id];
    if (result.envs.some((e) => e.samples.length || e.error)) PW.compares[id] = result;
    else if (result.aborted) PW.toast('Comparison cancelled');
    PW.emit('running'); PW.emit('response', id);
  };

  // ---------- analysis ----------
  function perfOf(er) {
    const sum = Stats.summarize(er.samples.map((s) => ({ ms: s.ms, status: s.status, ok: s.ok })));
    const ok = er.samples.filter((s) => s.ok);
    return { sum, ttfb: avgOf(ok.map((s) => s.ttfb)), statuses: [...new Set(er.samples.map((s) => (s.ok ? s.status : 'ERR')))] };
  }

  function compareData(base, other, ignore) {
    const a = base.last, b = other.last;
    const out = { statusSame: a.status === b.status, typeSame: (a.contentType || '') === (b.contentType || ''), sizeA: a.size, sizeB: b.size };
    const ja = PW.jsonOf(a), jb = PW.jsonOf(b);
    if (ja && jb) {
      const d = Diff.diffJson(ja.v, jb.v, { ignore, max: 500 });
      Object.assign(out, { mode: 'json', diffs: d.diffs, capped: d.capped, equal: !d.diffs.length });
    } else if (a.isText && b.isText) {
      const d = Diff.diffText(a.body, b.body);
      Object.assign(out, { mode: 'text', text: d, equal: d.equal });
    } else Object.assign(out, { mode: 'binary', equal: a.body === b.body });
    out.identical = out.equal && out.statusSame;
    return out;
  }

  // ---------- rendering ----------
  const short = (v) => {
    if (v === undefined) return '—';
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    return s.length > 140 ? s.slice(0, 139) + '…' : s;
  };
  const full = (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  function controls(tab) {
    const c = cfg(tab), id = tab.id;
    const running = PW.running[id];
    const chips = h('div', { class: 'cmp-envs' }, envChoices().map((e) => {
      const on = c.envs.includes(e.id);
      const box = h('input', { type: 'checkbox', checked: on, onchange: () => {
        c.envs = box.checked ? c.envs.concat(e.id) : c.envs.filter((x) => x !== e.id);
        PW.save(); PW.renderResponse();
      } });
      return h('label', { class: 'cmp-env' + (on ? ' on' : ''), title: e.vars.length + ' variable' + (e.vars.length === 1 ? '' : 's') }, box, e.name);
    }));
    const runs = h('input', { type: 'number', min: 1, max: MAX_RUNS, value: c.runs, title: 'Requests per environment (rounds)' });
    runs.addEventListener('change', () => { c.runs = Math.min(MAX_RUNS, Math.max(1, parseInt(runs.value, 10) || 1)); runs.value = c.runs; PW.save(); });
    const ignore = h('input', { class: 'in cmp-ignore', value: c.ignore, placeholder: 'Ignore fields: timestamp, requestId, meta.traceId', spellcheck: 'false' });
    let tm; ignore.addEventListener('input', () => { c.ignore = ignore.value; PW.save(); clearTimeout(tm); tm = setTimeout(() => { if (PW.compares[id]) PW.renderResponse(); }, 450); });
    const go = h('button', { class: 'btn primary', onclick: () => { if (PW.running[id]) PW.running[id].ctl.abort(); else PW.compare(id); } },
      running && running.compare ? 'Stop ■' : 'Compare ▸');
    if (running && !running.compare) go.disabled = true;
    const n = selectedEnvs(tab).length;
    return h('div', null,
      h('div', { class: 'benchbar' }, h('span', null, 'Environments'), chips),
      h('div', { class: 'benchbar' }, h('span', null, 'Rounds'), runs, ignore, go),
      h('p', { class: 'hint', style: { margin: '-4px 0 12px' } }, n + ' selected · each round sends the request to every selected environment at the same moment (Globals are shared). ' +
        'Compare runs don’t touch Latency stats or captures. Only call servers you own.'));
  }

  function perfTable(result) {
    const multi = result.runs > 1;
    const rows = result.envs.map((er) => ({ er, p: perfOf(er) }));
    const key = (r) => (r.p.sum && r.p.sum.timed ? (multi ? r.p.sum.p50 : r.p.sum.avg) : null);
    const timed = rows.filter((r) => key(r) != null);
    const best = timed.length ? Math.min(...timed.map(key)) : null;
    const worst = timed.length ? Math.max(...timed.map(key)) : null;

    const cols = multi ? ['Environment', 'Status', 'p50', 'Avg', 'p95', 'Min', 'Max', 'TTFB', 'Size', 'vs fastest', ''] : ['Environment', 'Status', 'Time', 'TTFB', 'Size', 'vs fastest', ''];
    const t = h('table', { class: 'cmp' }, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))));
    const tb = h('tbody');
    rows.forEach(({ er, p }) => {
      const s = p.sum;
      const name = h('td', { class: 'env' }, er.name);
      if (er.error && !er.samples.length) {
        tb.append(h('tr', { class: 'err' }, name, h('td', { colspan: cols.length - 1 }, h('span', { class: 'chip s0' }, er.error.code), ' ', er.error.error)));
        return;
      }
      const k = key({ p });
      const isBest = k != null && k === best && timed.length > 1;
      const status = h('td', null, p.statuses.map((st) => h('span', { class: 'chip ' + (st === 'ERR' ? 's0' : PW.clsOf(st)), style: { marginRight: '4px' } }, st)));
      const num = (v) => h('td', { class: 'num' }, PW.fmtMs(v));
      const delta = k == null ? '—' : isBest ? 'fastest' : best ? '+' + PW.fmtMs(k - best) + ' (' + (k / best).toFixed(2) + '×)' : '—';
      const barW = k != null && worst ? Math.max(2, (k / worst) * 100) : 0;
      const view = h('td', { class: 'act' }, er.last && er.last.ok ? h('button', { class: 'btn ghost', onclick: () => viewBody(er) }, 'Body') : null);
      const sizeTd = h('td', { class: 'num' }, er.last && er.last.ok ? PW.fmtBytes(er.last.size) : '—');
      const deltaTd = h('td', { class: 'num delta' + (isBest ? ' best' : '') }, delta, h('div', { class: 'cmpbar' }, h('i', { style: { width: barW + '%' } })));
      const cells = multi
        ? [name, status, num(s.p50), num(s.avg), num(s.p95), num(s.min), num(s.max), num(p.ttfb), sizeTd, deltaTd, view]
        : [name, status, num(s.avg), num(p.ttfb), sizeTd, deltaTd, view];
      tb.append(h('tr', { class: isBest ? 'best' : '' }, cells));
      if (s.errors) cells[1].append(h('span', { class: 'hint' }, s.errors + ' failed'));
    });
    t.append(tb);
    return h('div', { class: 'cmp-scroll' }, t);
  }

  function viewBody(er) {
    const res = er.last, j = PW.jsonOf(res);
    const text = res.isText ? (j ? JSON.stringify(j.v, null, 2) : res.body) : '(binary ' + (res.contentType || '') + ', ' + PW.fmtBytes(res.size) + ')';
    PW.modal({
      title: er.name + ' — ' + res.status + ' ' + res.statusText, wide: true,
      body: h('div', null, h('div', { class: 'hint', style: { marginBottom: '8px', fontFamily: 'var(--mono)' } }, res.reqMethod + ' ' + res.reqUrl),
        h('pre', { class: 'code cmp-pre' }, text.length > 2e6 ? text.slice(0, 2e6) + '\n… (truncated for display)' : text)),
      buttons: [{ label: 'Copy', onclick: () => PW.copy(text, 'Body copied') }, { label: 'Close', primary: true }],
    });
  }

  function dataSection(tab, result) {
    const id = tab.id;
    const usable = result.envs.filter((e) => e.last && e.last.ok);
    const box = h('div', { style: { marginTop: '18px' } });
    if (usable.length < 2) {
      box.append(h('h4', null, 'Data'), h('p', { class: 'hint' }, 'Need successful responses from at least two environments to compare data.'));
      return box;
    }
    if (!usable.some((e) => e.id === baseSel[id])) baseSel[id] = usable[0].id;
    const base = usable.find((e) => e.id === baseSel[id]);
    const sel = h('select', { class: 'in cmp-base', onchange: () => { baseSel[id] = sel.value; PW.renderResponse(); } },
      usable.map((e) => h('option', { value: e.id, selected: e.id === base.id }, e.name)));
    const ignore = Diff.parseIgnore(cfg(tab).ignore);
    box.append(h('div', { class: 'cmp-head' }, h('h4', { style: { margin: 0 } }, 'Data vs baseline'), sel,
      ignore.size ? h('span', { class: 'hint' }, 'ignoring ' + [...ignore].join(', ')) : null,
      result.runs > 1 ? h('span', { class: 'hint' }, 'compares the last successful response of each environment') : null));

    usable.filter((e) => e !== base).forEach((other) => {
      const d = compareData(base, other, ignore);
      const key = id + ':' + base.id + ':' + other.id;
      const notes = [];
      if (!d.statusSame) notes.push('status ' + base.last.status + ' → ' + other.last.status);
      if (!d.typeSame) notes.push('content-type differs');
      let verdict, cls;
      if (d.identical && d.typeSame) { verdict = '✓ Identical'; cls = 'same'; }
      else if (d.mode === 'json') { verdict = d.diffs.length ? d.diffs.length + (d.capped ? '+' : '') + ' difference' + (d.diffs.length === 1 ? '' : 's') : 'Same data'; cls = d.diffs.length ? 'diff' : 'same'; }
      else if (d.mode === 'text') { verdict = d.equal ? 'Same body' : d.text.changedLines + ' line' + (d.text.changedLines === 1 ? '' : 's') + ' differ'; cls = d.equal ? 'same' : 'diff'; }
      else { verdict = d.equal ? 'Same bytes' : 'Binary bodies differ'; cls = d.equal ? 'same' : 'diff'; }
      if (cls === 'same' && notes.length) cls = 'warn';

      const card = h('details', { class: 'cmp-card ' + cls, open: openDiff[key] != null ? openDiff[key] : cls !== 'same' });
      card.addEventListener('toggle', () => { openDiff[key] = card.open; });
      card.append(h('summary', null, h('b', null, base.name), ' ⇄ ', h('b', null, other.name), h('span', { class: 'verdict' }, verdict),
        notes.length ? h('span', { class: 'hint' }, notes.join(' · ')) : null,
        h('span', { class: 'hint', style: { marginLeft: 'auto' } }, PW.fmtBytes(d.sizeA) + ' vs ' + PW.fmtBytes(d.sizeB))));

      if (d.mode === 'json' && d.diffs.length) {
        const t = h('table', { class: 'cmp diffs' }, h('thead', null, h('tr', null, h('th', null, 'Path'), h('th', null, ''), h('th', null, base.name), h('th', null, other.name))));
        const tb = h('tbody');
        d.diffs.forEach((x) => tb.append(h('tr', null,
          h('td', { class: 'path', title: 'Click to copy path', onclick: () => PW.copy(x.path, 'Path copied') }, x.path),
          h('td', null, h('span', { class: 'kind k-' + x.kind }, x.kind)),
          h('td', { class: 'va', title: full(x.a) }, short(x.a)),
          h('td', { class: 'vb', title: full(x.b) }, short(x.b)))));
        t.append(tb);
        card.append(h('div', { class: 'cmp-body' }, t,
          h('div', { class: 'cmp-actions' },
            h('button', { class: 'btn ghost', onclick: () => PW.copy(d.diffs.map((x) => x.path).join('\n'), 'Paths copied') }, 'Copy paths'),
            h('span', { class: 'hint' }, 'Tip: add noisy fields (ids, timestamps) to Ignore fields above.'),
            d.capped ? h('span', { class: 'hint' }, 'Showing the first 500 differences.') : null)));
      } else if (d.mode === 'text' && !d.equal) {
        card.append(h('div', { class: 'cmp-body' }, h('div', { class: 'hint' }, 'First difference on line ' + d.text.firstLine + ':'),
          h('table', { class: 'cmp diffs' }, h('tbody', null,
            h('tr', null, h('td', { class: 'env' }, base.name), h('td', { class: 'va' }, d.text.a == null ? '(no line)' : d.text.a.slice(0, 400))),
            h('tr', null, h('td', { class: 'env' }, other.name), h('td', { class: 'vb' }, d.text.b == null ? '(no line)' : d.text.b.slice(0, 400)))))));
      }
      box.append(card);
    });
    return box;
  }

  PW.compareTab = function (tab) {
    const root = h('div');
    if (envChoices().length < 2) {
      root.append(h('div', { class: 'placeholder', style: { height: 'auto', padding: '30px 0' } }, h('div', null,
        h('div', { style: { fontSize: '30px' } }, '⇆'), h('h3', null, 'Compare needs two or more environments'),
        h('div', null, 'Create environments such as Dev, QA and Prod with the same variable names (e.g. {{baseUrl}}).'),
        h('button', { class: 'btn primary', style: { marginTop: '12px' }, onclick: () => PW.openEnv() }, 'Edit environments'))));
      return root;
    }
    root.append(controls(tab));
    const run = PW.running[tab.id];
    if (run && run.compare) {
      root.append(PW.loader('Comparing ' + run.envs + ' environments…', 'Same request, fired simultaneously', run.started,
        h('div', { class: 'ld-prog' }, h('div', { class: 'progress', id: 'cmpProg' }, h('i', { style: { width: (run.done / run.n * 100) + '%' } })),
          h('div', { class: 'hint', id: 'cmpProgTxt' }, 'Round ' + run.round + ' of ' + run.rounds + ' · ' + run.done + ' / ' + run.n + ' responses'))));
      return root;
    }
    const result = PW.compares[tab.id];
    if (!result) {
      root.append(h('div', { class: 'placeholder', style: { height: 'auto', padding: '30px 0' } }, h('div', null, h('div', { style: { fontSize: '30px' } }, '⇆'),
        h('h3', null, 'Press Compare ▸'), h('div', null, 'See which environment is faster and exactly which fields differ.'))));
      return root;
    }
    root.append(h('div', { class: 'cmp-head' }, h('h4', { style: { margin: 0 } }, 'Performance'),
      h('span', { class: 'hint' }, result.method + ' ' + result.url + ' · ' + result.runs + ' round' + (result.runs > 1 ? 's' : '') + ' · ' + new Date(result.at).toLocaleTimeString() + (result.aborted ? ' · stopped early' : ''))),
    perfTable(result), dataSection(tab, result));
    return root;
  };

  PW.on('env', () => { const id = PW.state.activeTabId; if (PW.$('.cmp-envs') && !PW.running[id]) PW.renderResponse(); });
})();
