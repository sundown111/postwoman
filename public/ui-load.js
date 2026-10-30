// Load test mode (JMeter-style): virtual users, ramp-up/hold/ramp-down or loop count, think time, throughput cap,
// CSV data, assertions, SLA verdict, live dashboard, full report (p50 … p99.99, Apdex, charts), JTL/CSV/JSON/HTML export, run history.
(function () {
  'use strict';
  const { h } = PW;
  const K = window.LoadKit;
  PW.loads = {};                 // tabId -> live run
  const viewSel = {}, sampleSel = {}, fullReports = {};
  const MAX_HISTORY = 8;

  const DEFAULTS = { users: 10, rampUp: 5, mode: 'duration', hold: 30, rampDown: 0, iterations: 10, thinkMs: 0, jitterMs: 0, maxRps: 0, keepAlive: true,
    status: '200-399', contains: '', maxMs: 0, apdexT: 500, sla: { p95: '', p99: '', p9999: '', errPct: '', minRps: '' }, csv: '' };
  function cfgOf(tab) {
    const c = tab.load = Object.assign({}, DEFAULTS, tab.load || {});
    c.sla = Object.assign({}, DEFAULTS.sla, c.sla || {});
    return c;
  }
  const runsOf = (tab) => (tab.loadRuns = Array.isArray(tab.loadRuns) ? tab.loadRuns : []);
  const ms = (v) => PW.fmtMs(v);
  const n0 = (v) => (v == null ? '—' : Math.round(v).toLocaleString());
  const pct = (v, d) => (v == null ? '—' : v.toFixed(d == null ? (v > 0 && v < 1 ? 2 : 1) : d) + '%');
  const rate = (v) => (v == null ? '—' : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const sleep = (t) => new Promise((r) => setTimeout(r, t));
  const isLive = (L) => L && L.state !== 'done';

  // fetch + JSON that never throws; explains the "server started before this feature existed" case
  async function api(path, opts) {
    let r;
    try { r = await fetch(path, opts); } catch (e) { return { ok: false, net: true, error: 'Cannot reach the Postwoman server (' + e.message + '). Is `node server.js` running?' }; }
    const text = await r.text();
    try { return JSON.parse(text); } catch {
      if (r.status === 404 || r.status === 405) return { ok: false, stale: true, error: 'The running Postwoman server is an older version without load testing. Restart it: stop `node server.js` (Ctrl+C) and start it again.' };
      return { ok: false, error: 'Unexpected response from the Postwoman server (HTTP ' + r.status + ')' };
    }
  }

  // ---------- start / stop / poll ----------
  PW.startLoad = async function (tabId) {
    const tab = PW.tab(tabId);
    if (!tab) return;
    if (Object.values(PW.loads).some(isLive)) { PW.toast('A load test is already running'); return; }
    if (Curl.looksLikeCurl(tab.url) && PW.applyCurl(tab, tab.url) === false) return;
    if (!tab.url.trim()) { PW.toast('Enter a URL first'); return; }
    const c = cfgOf(tab);
    const rule = K.parseStatusRule(c.status);
    if (rule.error) { PW.toast(rule.error); return; }
    const csv = K.parseCsv(c.csv);
    const bad = csv.headers.find((x) => !/^[A-Za-z_][\w.-]*$/.test(x));
    if (bad != null) { PW.toast('CSV column "' + bad + '" is not a valid variable name (letters, digits, _ . -)'); return; }
    if (csv.headers.length && !csv.rows.length) { PW.toast('The CSV has a header row but no data rows'); return; }

    // Leave per-request values as {{placeholders}} for the server: dynamic vars, user/iteration numbers, CSV columns.
    const map = PW.varMap();
    ['$vu', '$iteration'].concat(PW.DYNAMIC).forEach((k) => { if (!Object.prototype.hasOwnProperty.call(map, k)) map[k] = '{{' + k + '}}'; });
    csv.headers.forEach((k) => { map[k] = '{{' + k + '}}'; });
    const missing = new Set();
    const spec = PW.buildSpec(tab, map, missing, { forLoad: true });
    if (missing.size) { PW.toast('Undefined variable' + (missing.size > 1 ? 's' : '') + ': ' + [...missing].map((m) => '{{' + m + '}}').join(', '), null, null, 5000); return; }

    const env = PW.activeEnv();
    const L = PW.loads[tabId] = { id: null, state: 'starting', timeline: [], startedAt: Date.now(), cfg: JSON.parse(JSON.stringify(c)) };
    PW.showResponseTab(tabId, 'load');
    const r = await api('/api/load/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, c, { spec, label: PW.tabTitle(tab), urlTemplate: tab.url, env: env ? env.name : null, tabId })) });
    if (!r.ok) { delete PW.loads[tabId]; PW.toast(r.error || 'Could not start the load test', null, null, 8000); rerender(tabId); return; }
    L.id = r.id;
    poll(tabId, L);
  };

  PW.stopLoad = async function (tabId) {
    const L = PW.loads[tabId];
    if (!L || !L.id) return;
    L.stopping = true; updateLive(tabId);
    await api('/api/load/stop?id=' + L.id, { method: 'POST' }); // poll notices the outcome
  };

  async function poll(tabId, L) {
    let fails = 0;
    while (PW.loads[tabId] === L) {
      const st = await api('/api/load/status?id=' + L.id + '&since=' + L.timeline.length);
      if (st.net) { if (++fails > 8) { delete PW.loads[tabId]; PW.toast('Lost contact with the server; the load test result is unavailable'); rerender(tabId); return; } await sleep(1000); continue; }
      fails = 0;
      if (!st.ok) { delete PW.loads[tabId]; PW.toast(st.error || 'Load test not found', null, null, 6000); rerender(tabId); return; }
      const tl = st.timeline; delete st.timeline;
      L.timeline.push(...tl); Object.assign(L, st);
      if (st.state === 'done') {
        const j = await api('/api/load/report?id=' + L.id);
        delete PW.loads[tabId];
        if (j.report) saveRun(tabId, j.report);
        else PW.toast(j.error || 'Load test finished, but the report could not be loaded', null, null, 6000);
        rerender(tabId);
        return;
      }
      updateLive(tabId);
      await sleep(1000);
    }
  }

  function saveRun(tabId, rep) {
    fullReports[rep.id] = rep;
    const tab = PW.tab(tabId);
    const verdict = rep.verdict === 'pass' ? ' — PASS ✓' : rep.verdict === 'fail' ? ' — FAIL ✗' : '';
    PW.toast('Load test ' + (rep.reason === 'stopped' ? 'stopped' : 'finished') + ': ' + rep.count.toLocaleString() + ' samples, p95 ' + ms(rep.el.p95) + verdict, null, null, 6000);
    if (!tab) return;
    const stored = Object.assign({}, rep, { timeline: K.downsample(rep.timeline, 300), downsampled: rep.timeline.length > 300 });
    const runs = runsOf(tab);
    if (!runs.some((r) => r.id === rep.id)) runs.unshift(stored); // the server also saves finished runs
    runs.splice(MAX_HISTORY);
    viewSel[tabId] = rep.id;
    PW.save();
  }

  PW.resumeLoad = async function () {
    const a = await api('/api/load/active');
    if (a.stale) { PW.serverStale = true; return; }
    if (!a.id || !a.tabId || !PW.tab(a.tabId) || PW.loads[a.tabId]) return;
    const L = PW.loads[a.tabId] = { id: a.id, state: 'running', timeline: [], startedAt: Date.now(), cfg: cfgOf(PW.tab(a.tabId)) };
    poll(a.tabId, L);
    rerender(a.tabId);
  };

  function rerender(tabId) { if (tabId === PW.state.activeTabId) PW.renderResponse(); }

  function updateLive(tabId) {
    if (tabId !== PW.state.activeTabId) return;
    const L = PW.loads[tabId];
    const chip = PW.$('#loadChip');
    if (chip && L) chip.replaceWith(PW.loadChip(tabId));
    const box = PW.$('#loadLive');
    if (box && L) { box.textContent = ''; box.append(liveBody(L)); }
  }

  // ---------- response-bar chip ----------
  PW.loadChip = function (tabId) {
    const L = PW.loads[tabId];
    if (!L) return null;
    const s = L.summary;
    return h('span', { class: 'metric loadchip', id: 'loadChip' }, PW.spin(), ' Load test ',
      L.state === 'starting' ? 'starting…' : L.state === 'finishing' ? 'finishing…' : h('b', null, (L.active || 0) + ' users'),
      s ? [' · ', h('b', null, rate(s.curRps)), ' req/s · ', h('b', null, ms(s.el.p95)), ' p95'] : null);
  };

  // ---------- config form ----------
  function numIn(obj, key, o) {
    o = o || {};
    const inp = h('input', { type: 'number', class: 'lt-num', min: o.min != null ? o.min : 0, max: o.max, step: o.step || 'any', value: obj[key], placeholder: o.placeholder || '', title: o.title || '' });
    inp.addEventListener('change', () => {
      if (inp.value === '' && o.blank) obj[key] = '';
      else {
        let v = Number(inp.value);
        if (!Number.isFinite(v)) v = o.def != null ? o.def : 0;
        if (o.min != null) v = Math.max(o.min, v);
        if (o.max != null) v = Math.min(o.max, v);
        if (o.int) v = Math.round(v);
        obj[key] = v; inp.value = v;
      }
      PW.save(); o.onchange && o.onchange();
    });
    return inp;
  }
  const field = (label, ...kids) => h('label', { class: 'lt-f' }, h('span', null, label), h('div', null, kids));

  function configForm(tab) {
    const c = cfgOf(tab);
    const prev = h('div', { class: 'lt-prof' });
    const drawPrev = () => {
      prev.textContent = '';
      const total = K.plannedSeconds(c);
      prev.append(PW.chart.line({ height: 110, legend: false, xFmt: PW.fmtClock, yFmt: (v) => Math.round(v), tipX: (x) => PW.fmtClock(x),
        series: [{ label: 'Users', color: 'var(--accent)', fill: true, points: K.profilePoints(c, 160) }] }),
      h('div', { class: 'hint' }, c.mode === 'iterations'
        ? c.users + ' users × ' + c.iterations + ' iterations = ' + (c.users * c.iterations).toLocaleString() + ' requests · ends when every user is done'
        : 'Total ' + PW.fmtClock(total) + ' · up to ' + c.users + ' users' + (c.maxRps ? ' · capped at ' + c.maxRps + ' req/s' : '') + ' · in-flight requests finish after the end'));
    };
    const re = () => { drawPrev(); modeRows(); };
    const durRow = h('div', { class: 'lt-row' }), itRow = h('div', { class: 'lt-row' });
    const modeRows = () => { durRow.style.display = c.mode === 'duration' ? '' : 'none'; itRow.style.display = c.mode === 'iterations' ? '' : 'none'; };
    const mode = h('div', { class: 'seg' }, [['duration', 'Duration'], ['iterations', 'Loop count']].map(([v, l]) => h('button', { class: c.mode === v ? 'on' : '', onclick: (e) => {
      c.mode = v; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); PW.save(); re();
    } }, l)));

    durRow.append(field('Hold at peak', numIn(c, 'hold', { max: 86400, onchange: re }), 's'), field('Ramp-down', numIn(c, 'rampDown', { max: 3600, onchange: re }), 's'));
    itRow.append(field('Iterations per user', numIn(c, 'iterations', { min: 1, max: 1e7, int: true, onchange: re })));

    const ka = h('input', { type: 'checkbox', checked: c.keepAlive, onchange: () => { c.keepAlive = ka.checked; PW.save(); } });
    const statusIn = h('input', { class: 'in lt-text', value: c.status, placeholder: '200-399', spellcheck: 'false' });
    statusIn.addEventListener('change', () => { const r = K.parseStatusRule(statusIn.value); statusIn.classList.toggle('bad', !!r.error); c.status = statusIn.value.trim() || '200-399'; PW.save(); });
    const containsIn = h('input', { class: 'in lt-text', value: c.contains, placeholder: 'optional text', spellcheck: 'false' });
    containsIn.addEventListener('change', () => { c.contains = containsIn.value; PW.save(); });
    const csvTa = h('textarea', { class: 'in lt-csv', spellcheck: 'false', placeholder: 'id,email\n1,ada@example.com\n2,bob@example.com' }, c.csv);
    const csvInfo = h('span', { class: 'hint' });
    const csvRefresh = () => { const p = K.parseCsv(csvTa.value); csvInfo.textContent = p.headers.length ? p.rows.length.toLocaleString() + ' rows · variables: ' + p.headers.map((x) => '{{' + x + '}}').join(' ') : ''; };
    csvTa.addEventListener('input', () => { c.csv = csvTa.value; PW.save(); csvRefresh(); });
    const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', style: { display: 'none' } });
    file.addEventListener('change', () => { const f = file.files[0]; if (f) f.text().then((t) => { csvTa.value = t; c.csv = t; PW.save(); csvRefresh(); }); });
    csvRefresh();

    const env = PW.activeEnv();
    const running = Object.values(PW.loads).some(isLive);
    const start = h('button', { class: 'btn primary', disabled: running, onclick: () => PW.startLoad(tab.id) }, '▶ Start load test');
    const form = h('div', { class: 'lt-form' },
      h('div', { class: 'lt-cols' },
        h('div', null,
          h('h4', null, 'Thread group'),
          h('div', { class: 'lt-row' }, field('Users (threads)', numIn(c, 'users', { min: 1, max: 5000, int: true, onchange: re })), field('Ramp-up', numIn(c, 'rampUp', { max: 3600, onchange: re }), 's'), field('Mode', mode)),
          durRow, itRow,
          h('div', { class: 'lt-row' },
            field('Think time', numIn(c, 'thinkMs', { max: 600000 }), 'ms ±', numIn(c, 'jitterMs', { max: 600000, title: 'Random extra delay (uniform)' }), 'ms'),
            field('Max throughput', numIn(c, 'maxRps', { max: 100000, title: '0 = unlimited (Constant Throughput Timer)' }), 'req/s')),
          h('label', { class: 'chk', style: { marginTop: '4px' } }, ka, 'Keep-alive (each user reuses its connection, like JMeter)')),
        h('div', null, h('h4', null, 'Load profile'), prev)),
      h('details', { class: 'lt-more' }, h('summary', null, 'Assertions, pass/fail criteria (SLA) & Apdex'),
        h('div', { class: 'lt-row' },
          field('Success status', statusIn),
          field('Body contains', containsIn),
          field('Max response time', numIn(c, 'maxMs', { max: 600000, title: '0 = off (Duration Assertion)' }), 'ms'),
          field('Apdex T', numIn(c, 'apdexT', { min: 1, max: 60000 }), 'ms')),
        h('div', { class: 'lt-row' },
          field('p95 ≤', numIn(c.sla, 'p95', { blank: true, placeholder: 'off' }), 'ms'),
          field('p99 ≤', numIn(c.sla, 'p99', { blank: true, placeholder: 'off' }), 'ms'),
          field('p99.99 ≤', numIn(c.sla, 'p9999', { blank: true, placeholder: 'off' }), 'ms'),
          field('Error rate ≤', numIn(c.sla, 'errPct', { blank: true, max: 100, placeholder: 'off' }), '%'),
          field('Throughput ≥', numIn(c.sla, 'minRps', { blank: true, placeholder: 'off' }), 'req/s')),
        h('p', { class: 'hint' }, 'A sample fails when the status is outside “Success status”, the body lacks the text, or it is slower than the max. Leave criteria blank to skip them; any set criterion decides the PASS / FAIL verdict.')),
      h('details', { class: 'lt-more' }, h('summary', null, 'Test data (CSV)', c.csv.trim() ? h('span', { class: 'badge' }, '●') : null),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '6px 0' } }, h('button', { class: 'btn', onclick: () => file.click() }, '⬆ Load file'), csvInfo),
        csvTa,
        h('p', { class: 'hint' }, 'First row = variable names. Each request takes the next row (shared by all users, starts over at the end — like JMeter’s CSV Data Set). Also available: {{$vu}} (user number), {{$iteration}}, and fresh {{$uuid}} / {{$timestamp}} / {{$randomInt}} on every request.')),
      h('div', { class: 'lt-start' }, start,
        h('span', { class: 'hint' }, PW.fmtMs(tab.settings.timeout) + ' timeout · ' + (env ? 'env ' + env.name : 'no environment') + ' · runs in the local server, so browser connection limits don’t apply'),
        h('span', { class: 'hint', style: { marginLeft: 'auto' } }, '⚠ Only load-test systems you own or are allowed to test.')));
    re();
    return form;
  }

  // ---------- shared bits ----------
  function card(label, value, sub, extra) {
    return h('div', { class: 'card' + (extra && extra.hot ? ' hot' : '') }, h('small', null, label), h('b', null, value),
      sub ? h('div', { class: 'lt-sub' }, sub) : null, extra && extra.delta ? extra.delta : null);
  }
  function delta(cur, prev, lowerBetter) {
    if (cur == null || prev == null || !prev) return null;
    const d = ((cur - prev) / prev) * 100;
    if (Math.abs(d) < 1) return h('div', { class: 'lt-delta' }, '≈ prev');
    const good = lowerBetter ? d < 0 : d > 0;
    return h('div', { class: 'lt-delta ' + (good ? 'good' : 'bad'), title: 'vs previous run' }, (d > 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0) + '%');
  }
  const xs = (tl) => tl.map((b) => b.t);
  function timeCharts(tl, which) {
    const D = K.downsample(tl, 600);
    const per = (f) => D.map((b) => [b.t, f(b) / (b.span || 1)]);
    const val = (f) => D.map((b) => [b.t, b.n ? b[f] : null]);
    const out = {};
    if (which.includes('users')) out.users = PW.chart.line({ xFmt: PW.fmtClock, y2Fmt: PW.fmtNum, yFmt: PW.fmtNum,
      series: [{ label: 'Active users', color: 'var(--accent)', fill: true, points: D.map((b) => [b.t, b.users]) },
        { label: 'Throughput (req/s)', color: 'var(--accent2)', axis: 'r', points: per((b) => b.n) },
        { label: 'Errors/s', color: 'var(--bad)', axis: 'r', points: per((b) => b.err) }] });
    if (which.includes('rt')) out.rt = PW.chart.line({ xFmt: PW.fmtClock, yFmt: ms,
      series: [{ label: 'avg', color: 'var(--accent2)', points: val('avg') }, { label: 'p90', color: 'var(--info)', points: val('p90') },
        { label: 'p95', color: 'var(--warn)', points: val('p95') }, { label: 'p99', color: 'var(--bad)', points: val('p99') },
        { label: 'max', color: 'var(--faint)', dash: true, width: 1, points: val('max') }] });
    if (which.includes('codes')) out.codes = PW.chart.line({ xFmt: PW.fmtClock,
      series: [{ label: '2xx', color: 'var(--ok)', points: per((b) => b.c2) }, { label: '3xx', color: 'var(--info)', points: per((b) => b.c3) },
        { label: '4xx', color: 'var(--warn)', points: per((b) => b.c4) }, { label: '5xx', color: 'var(--bad)', points: per((b) => b.c5) },
        { label: 'No response', color: 'var(--bool)', points: per((b) => b.ce) }].filter((s) => s.points.some((p) => p[1] > 0)) });
    if (which.includes('net')) out.net = PW.chart.line({ xFmt: PW.fmtClock, yFmt: (v) => PW.fmtNum(v) + ' KB',
      series: [{ label: 'Received KB/s', color: 'var(--accent2)', fill: true, points: per((b) => b.kb) }, { label: 'Sent KB/s', color: 'var(--accent)', points: per((b) => b.kbs) }] });
    if (which.includes('vs')) {
      const pts = D.filter((b) => b.n);
      out.vs = PW.chart.line({ xFmt: (v) => Math.round(v) + ' users', yFmt: ms, tipX: (x) => x + ' active users',
        series: [{ label: 'avg', color: 'var(--accent2)', scatter: true, points: pts.map((b) => [b.users, b.avg]) },
          { label: 'p95', color: 'var(--warn)', scatter: true, points: pts.map((b) => [b.users, b.p95]) }] });
    }
    return out;
  }
  const panel = (title, node, hint) => h('div', { class: 'lt-panel' }, h('h4', null, title), node, hint ? h('div', { class: 'hint', style: { marginTop: '4px' } }, hint) : null);

  // ---------- live dashboard ----------
  function liveBody(L) {
    const root = h('div');
    const s = L.summary;
    if (!L.id || !s) { root.append(PW.loader('Starting virtual users…', 'Ramping up — first numbers arrive within a second', L.startedAt)); return root; }
    const planned = L.planned;
    const progress = L.state === 'finishing' ? 1 : planned ? Math.min(1, L.elapsed / planned) : L.plannedSamples ? Math.min(1, s.count / L.plannedSamples) : 0;
    const stateTxt = L.stopping ? 'Stopping…' : L.state === 'finishing' ? 'Finishing in-flight requests…' : 'Running';
    root.append(h('div', { class: 'lt-livebar' }, PW.spin(), h('b', null, stateTxt),
      h('span', { class: 'metric' }, PW.fmtClock(L.elapsed) + (planned ? ' / ' + PW.fmtClock(planned) : '')),
      h('div', { class: 'progress' }, h('i', { style: { width: progress * 100 + '%' } })),
      h('span', { class: 'metric' }, planned && L.state === 'running' ? PW.fmtClock(Math.max(0, planned - L.elapsed)) + ' left' : L.plannedSamples ? n0(s.count) + ' / ' + n0(L.plannedSamples) : ''),
      h('button', { class: 'btn danger', disabled: !!L.stopping, onclick: () => PW.stopLoad(PW.state.activeTabId) }, 'Stop ■')));
    const e = s.el;
    root.append(h('div', { class: 'cards' },
      card('Active users', (L.active || 0) + ' / ' + L.users), card('Samples', n0(s.count)),
      card('Throughput now', rate(s.curRps), 'avg ' + rate(s.rps) + ' req/s'), card('Errors', pct(s.errPct), n0(s.errors) + ' failed', { hot: s.errors > 0 }),
      card('Avg', ms(e.avg)), card('Median', ms(e.p50)), card('p90', ms(e.p90)), card('p95', ms(e.p95), null, { hot: true }), card('p99', ms(e.p99), null, { hot: true }),
      card('p99.9', ms(e.p999)), card('p99.99', ms(e.p9999)), card('Max', ms(e.max)),
      card('Apdex', s.apdex == null ? '—' : s.apdex.toFixed(3)), card('Received', PW.fmtNum(s.recvKBs) + ' KB/s')));
    if (L.health && L.health.saturated) root.append(healthWarn(L.health));
    const c = timeCharts(L.timeline, ['users', 'rt', 'codes']);
    root.append(h('div', { class: 'lt-grid' }, panel('Active users & throughput', c.users), panel('Response time (per second)', c.rt), panel('Response codes per second', c.codes)),
      h('p', { class: 'hint' }, 'Live percentiles come from a histogram (±0.1%); the final report uses exact nearest-rank values.'));
    return root;
  }
  function healthWarn(hl) {
    return h('div', { class: 'lt-warn' }, '⚠ The load generator itself was busy (main thread ' + Math.round(hl.elu) + '% busy, event-loop lag p99 ' + ms(hl.lagP99) + '). ',
      'Measured times include that queueing, so the server is probably faster than shown. Use fewer users, add think time, or set a max throughput.');
  }

  // ---------- report ----------
  function aggTable(rows) {
    const cols = [['avg', 'Avg'], ['min', 'Min'], ['p50', 'Median'], ['p75', 'p75'], ['p90', 'p90'], ['p95', 'p95'], ['p99', 'p99'], ['p999', 'p99.9'], ['p9999', 'p99.99'], ['max', 'Max'], ['sd', 'Std dev']];
    return h('div', { class: 'cmp-scroll' }, h('table', { class: 'cmp lt-agg' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Samples'), cols.map(([, l]) => h('th', null, l)))),
      h('tbody', null, rows.map(([label, s, title]) => h('tr', null, h('td', { class: 'env', title: title || '' }, label), h('td', { class: 'num' }, n0(s.count)),
        cols.map(([k]) => h('td', { class: 'num' + (k === 'p95' || k === 'p99' ? ' em' : '') }, ms(s[k]))))))));
  }

  function exportsBar(rep, node) {
    const full = !!fullReports[rep.id];
    const dl = (name, text, type) => PW.download(name, text, type);
    const stamp = new Date(rep.at).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const aggCsv = () => {
      const head = ['Label', '# Samples', 'Average', 'Median', '90% Line', '95% Line', '99% Line', '99.9% Line', '99.99% Line', 'Min', 'Max', 'Std. Dev.', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec', 'Apdex'];
      const e = rep.el, r = (v) => (v == null ? '' : Math.round(v * 100) / 100);
      const row = [rep.label, rep.count, r(e.avg), r(e.p50), r(e.p90), r(e.p95), r(e.p99), r(e.p999), r(e.p9999), r(e.min), r(e.max), r(e.sd), r(rep.errPct) + '%', r(rep.rps), r(rep.recvKBs), r(rep.sentKBs), rep.apdex.score == null ? '' : rep.apdex.score.toFixed(3)];
      const q = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
      dl('aggregate-' + stamp + '.csv', [head, row, ['TOTAL'].concat(row.slice(1))].map((x) => x.map(q).join(',')).join('\n') + '\n', 'text/csv');
    };
    const jtl = async () => {
      try {
        const r = await fetch('/api/load/jtl?id=' + rep.id, { method: 'HEAD' });
        if (!r.ok) throw new Error();
        const a = h('a', { href: '/api/load/jtl?id=' + rep.id, download: '' }); document.body.append(a); a.click(); a.remove();
      } catch { PW.toast('Raw samples are only kept in server memory for the last 3 runs (and are lost on restart).', null, null, 5000); }
    };
    const html = async () => {
      let css = '';
      try { css = await (await fetch('style.css')).text(); } catch { /* unstyled */ }
      const clone = node.cloneNode(true);
      clone.querySelectorAll('.lt-actions, .lt-history, .seg, button, .ctip').forEach((x) => x.remove());
      const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
      const doc = '<!doctype html><html lang="en" data-theme="' + (PW.state.ui.theme === 'light' ? 'light' : 'dark') + '"><head><meta charset="utf-8"><title>Load test — ' + esc(rep.label) + '</title><style>' + css.replace(/<\/style/gi, '<\\/style') +
        '\nbody{overflow:auto;padding:24px;max-width:1200px;margin:0 auto}</style></head><body><h2>⚡ Postwoman load test report</h2>' + clone.outerHTML + '</body></html>';
      dl('load-report-' + stamp + '.html', doc, 'text/html');
    };
    return h('div', { class: 'lt-actions' },
      h('button', { class: 'btn', title: 'Every sample, JMeter CSV/JTL format (open in JMeter or its HTML dashboard generator)', disabled: !full, onclick: jtl }, '⬇ Raw results (.jtl)'),
      h('button', { class: 'btn', onclick: aggCsv }, '⬇ Aggregate CSV'),
      h('button', { class: 'btn', onclick: () => dl('load-report-' + stamp + '.json', JSON.stringify(rep, null, 2), 'application/json') }, '⬇ JSON'),
      h('button', { class: 'btn', onclick: html }, '⬇ HTML report'));
  }

  function reportView(tab, rep, prev) {
    const id = tab.id;
    const only = sampleSel[id] === 'ok';
    const E = only ? rep.elOk : rep.el, P = prev ? (only ? prev.elOk : prev.el) : null;
    const c = rep.config;
    const node = h('div', { class: 'lt-report' });
    const v = rep.verdict;
    const profile = c.mode === 'iterations' ? c.users + ' users × ' + c.iterations + ' loops' : c.users + ' users · ramp ' + c.rampUp + 's · hold ' + c.hold + 's' + (c.rampDown ? ' · down ' + c.rampDown + 's' : '');
    node.append(h('div', { class: 'lt-verdict ' + (v || 'none') },
      h('b', null, v === 'pass' ? '✓ PASS' : v === 'fail' ? '✗ FAIL' : rep.reason === 'stopped' ? '■ Stopped' : 'Completed'),
      h('span', null, rep.method + ' ' + rep.url),
      h('span', { class: 'hint' }, profile + (c.thinkMs ? ' · think ' + c.thinkMs + (c.jitterMs ? '±' + c.jitterMs : '') + ' ms' : '') + (c.maxRps ? ' · ≤' + c.maxRps + ' req/s' : '') + (c.keepAlive ? ' · keep-alive' : ' · new connection per request') +
        (rep.env ? ' · env ' + rep.env : '') + (c.csvRows ? ' · CSV ' + c.csvRows + ' rows' : '') + ' · ' + new Date(rep.at).toLocaleString() + ' · ran ' + PW.fmtClock(rep.wall || rep.duration) + (rep.reason === 'stopped' ? ' · stopped early' : ''))));

    node.append(h('div', { class: 'lt-toolbar' },
      h('div', { class: 'seg' }, [['all', 'All samples'], ['ok', 'Successful only']].map(([k, l]) => h('button', { class: (only ? 'ok' : 'all') === k ? 'on' : '', title: k === 'all' ? 'Like JMeter: failed samples count in the response-time stats' : 'Ignore failed samples in response-time stats',
        onclick: () => { sampleSel[id] = k; PW.renderResponse(); } }, l))),
      exportsBar(rep, node)));

    const ap = rep.apdex;
    node.append(h('div', { class: 'cards' },
      card('Samples', n0(rep.count), rep.okCount.toLocaleString() + ' ok', { delta: prev && delta(rep.count, prev.count) }),
      card('Throughput', rate(rep.rps) + ' /s', 'peak ' + rate(rep.peakRps) + ' /s', { delta: prev && delta(rep.rps, prev.rps) }),
      card('Errors', pct(rep.errPct), n0(rep.errors) + ' failed', { hot: rep.errors > 0, delta: prev && delta(rep.errPct, prev.errPct, true) }),
      card('Apdex', ap.score == null ? '—' : ap.score.toFixed(3), 'T = ' + ap.T + ' ms · ' + (ap.score >= 0.94 ? 'excellent' : ap.score >= 0.85 ? 'good' : ap.score >= 0.7 ? 'fair' : ap.score >= 0.5 ? 'poor' : 'unacceptable')),
      card('Avg', ms(E.avg), 'σ ' + ms(E.sd), { delta: P && delta(E.avg, P.avg, true) }),
      card('Median', ms(E.p50), null, { delta: P && delta(E.p50, P.p50, true) }),
      card('p90', ms(E.p90), null, { delta: P && delta(E.p90, P.p90, true) }),
      card('p95', ms(E.p95), null, { hot: true, delta: P && delta(E.p95, P.p95, true) }),
      card('p99', ms(E.p99), null, { hot: true, delta: P && delta(E.p99, P.p99, true) }),
      card('p99.9', ms(E.p999), null, { delta: P && delta(E.p999, P.p999, true) }),
      card('p99.99', ms(E.p9999), null, { hot: true, delta: P && delta(E.p9999, P.p9999, true) }),
      card('Min / Max', ms(E.min), 'max ' + ms(E.max)),
      card('Received', PW.fmtNum(rep.recvKBs) + ' KB/s', 'avg ' + PW.fmtBytes(Math.round(rep.avgBytes)) + ' / response'),
      card('Sent', PW.fmtNum(rep.sentKBs) + ' KB/s'),
      card('Max users', n0(rep.maxUsers))));

    node.append(panel('Aggregate report', aggTable([['Response time', E, 'Elapsed: request start → last byte' + (only ? ' (successful samples only)' : ' (all samples)')],
      ['Latency (TTFB)', rep.lat, 'Request start → first response byte, incl. connect (JMeter “Latency”)'], ['Connect', rep.con, 'DNS + TCP + TLS. 0 when a kept-alive connection was reused']])));

    const notes = [];
    notes.push(rep.exact ? 'Percentiles are exact (nearest-rank over ' + rep.count.toLocaleString() + ' samples).' : 'More than 1,000,000 samples: percentiles come from a high-resolution histogram (±0.1%); raw export holds the first 1,000,000.');
    if (rep.count < 10000) notes.push('p99.99 needs ≥ 10,000 samples to differ from the max' + (rep.count < 1000 ? ' (p99.9 needs ≥ 1,000)' : '') + '.');
    if (rep.downsampled && !fullReports[rep.id]) notes.push('Charts of saved runs are downsampled; percentile lines show the worst second in each point.');
    if (rep.health) notes.push('Generator: main thread ' + Math.round(rep.health.elu) + '% busy · event-loop lag p99 ' + ms(rep.health.lagP99) + ' · process CPU ' + Math.round(rep.health.cpu) + '%.');
    node.append(h('div', { class: 'hint lt-notes' }, notes.map((x) => h('div', null, 'ⓘ ' + x))));
    if (rep.health && rep.health.saturated) node.append(healthWarn(rep.health));

    if (rep.sla && rep.sla.length) {
      const fmt = (x, v) => (x.fmt === 'ms' ? ms(v) : x.fmt === '%' ? pct(v, 2) : rate(v) + ' req/s');
      node.append(panel('Pass / fail criteria', h('table', { class: 'cmp' }, h('tbody', null, rep.sla.map((x) => h('tr', { class: x.pass ? 'best' : 'err' },
        h('td', { class: 'env' }, x.pass ? '✓' : '✗'), h('td', null, x.label), h('td', { class: 'num' }, fmt(x, x.actual)), h('td', { class: 'num hint' }, x.op === '<=' ? '≤ ' : '≥ ', fmt(x, x.limit))))))));
    }

    const T = timeCharts(rep.timeline, ['users', 'rt', 'codes', 'net', 'vs']);
    const cur = rep.curve;
    const nx = (p) => K.nines(p);
    const pctLabel = (x) => (x >= 4.99 ? 'max' : 'p' + (+K.fromNines(x).toFixed(3)));
    const curve = cur && cur.el.length ? PW.chart.line({ yFmt: ms, xTicks: [[0, 'p0'], [50, 'p50'], [90, 'p90'], [99, 'p99'], [99.9, 'p99.9'], [99.99, 'p99.99'], [100, 'max']].map(([p, l]) => ({ v: nx(p), label: l })), tipX: pctLabel,
      series: [{ label: 'Response time', color: 'var(--accent)', width: 2.2, points: cur.p.map((p, i) => [nx(p), cur.el[i]]) }, { label: 'Latency (TTFB)', color: 'var(--accent2)', dash: true, points: cur.p.map((p, i) => [nx(p), cur.lat[i]]) },
        { label: 'Connect', color: 'var(--warn)', points: cur.p.map((p, i) => [nx(p), cur.con[i]]) }] }) : h('div', { class: 'hint' }, 'No samples');
    const dist = PW.chart.bars({ bins: rep.hist.bins, xFmt: ms, color: 'var(--accent)', over: { n: rep.hist.over, from: rep.hist.overFrom, label: '> p99.9 (' + ms(rep.hist.overFrom) + ')' } });
    node.append(h('div', { class: 'lt-grid' },
      panel('Active users & throughput', T.users), panel('Response time over time', T.rt, 'Per-second avg / p90 / p95 / p99 / max'),
      panel('Response time percentiles', curve, 'The tail on a “nines” scale: each step right is 10× rarer'), panel('Response time distribution', dist, 'Red bar = slowest 0.1%'),
      panel('Response time vs active users', T.vs, 'One dot per second: does latency grow with load?'), panel('Response codes per second', T.codes),
      panel('Network throughput', T.net)));

    const tot = rep.count || 1;
    const codeRows = rep.codes.map((x) => h('tr', null,
      h('td', null, h('span', { class: 'chip ' + (/^\d+$/.test(x.code) ? PW.clsOf(+x.code) : 's0') }, x.code)), h('td', null, x.msg),
      h('td', { class: 'num' }, n0(x.n)), h('td', { class: 'num' }, pct((x.n / tot) * 100, 2))));
    const codesTable = h('table', { class: 'cmp' }, h('thead', null, h('tr', null, h('th', null, 'Code'), h('th', null, 'Message'), h('th', null, 'Count'), h('th', null, '%'))), h('tbody', null, codeRows));
    const errRows = rep.errorsList.map((x) => h('tr', null,
      h('td', { class: 'lt-errkey' }, x.key), h('td', { class: 'num' }, n0(x.n)),
      h('td', { class: 'num' }, pct((x.n / (rep.errors || 1)) * 100, 1)), h('td', { class: 'num' }, pct((x.n / tot) * 100, 2))));
    const errTable = errRows.length
      ? h('table', { class: 'cmp' }, h('thead', null, h('tr', null, h('th', null, 'Type'), h('th', null, 'Count'), h('th', null, '% of errors'), h('th', null, '% of all'))), h('tbody', null, errRows))
      : h('div', { class: 'hint' }, 'No errors 🎉');
    node.append(h('div', { class: 'grid2', style: { marginTop: '12px' } }, panel('Response codes', codesTable), panel('Errors', errTable)));
    return node;
  }

  function history(tab, selId) {
    const runs = runsOf(tab);
    if (!runs.length) return null;
    const t = h('table', { class: 'cmp' }, h('thead', null, h('tr', null, ['When', 'Profile', 'Samples', 'Req/s', 'Avg', 'p95', 'p99', 'p99.99', 'Errors', 'Verdict', ''].map((x) => h('th', null, x)))));
    const tb = h('tbody');
    runs.forEach((r, i) => {
      const c = r.config;
      tb.append(h('tr', { class: r.id === selId ? 'lt-sel' : '', style: { cursor: 'pointer' }, onclick: () => { viewSel[tab.id] = r.id; PW.renderResponse(); } },
        h('td', null, new Date(r.at).toLocaleString()),
        h('td', null, c.mode === 'iterations' ? c.users + 'u × ' + c.iterations : c.users + 'u · ' + PW.fmtClock(K.plannedSeconds(c))),
        h('td', { class: 'num' }, n0(r.count)), h('td', { class: 'num' }, rate(r.rps)), h('td', { class: 'num' }, ms(r.el.avg)),
        h('td', { class: 'num' }, ms(r.el.p95)), h('td', { class: 'num' }, ms(r.el.p99)), h('td', { class: 'num' }, ms(r.el.p9999)),
        h('td', { class: 'num' }, pct(r.errPct)),
        h('td', null, r.verdict ? h('span', { class: 'chip ' + (r.verdict === 'pass' ? 's2' : 's5') }, r.verdict.toUpperCase()) : '—'),
        h('td', { class: 'act' }, h('button', { class: 'rm-btn', title: 'Delete this run', onclick: (e) => {
          e.stopPropagation(); runs.splice(i, 1); if (viewSel[tab.id] === r.id) delete viewSel[tab.id]; PW.save(); PW.renderResponse();
        } }, '×'))));
    });
    t.append(tb);
    return h('div', { class: 'lt-history' }, panel('Run history (this request)', h('div', { class: 'cmp-scroll' }, t), 'Click a run to view it. Deltas on the cards compare with the run before it.'));
  }

  // ---------- tab ----------
  PW.loadTab = function (tab) {
    const root = h('div', { class: 'lt' });
    if (PW.serverStale) root.append(h('div', { class: 'lt-warn' }, '⚠ The running Postwoman server is an older version without load testing. Stop `node server.js` (Ctrl+C), start it again, then reload this page.'));
    const L = PW.loads[tab.id];
    const focus = h('button', { class: 'btn ghost', title: 'Give the results more room', onclick: () => {
      const ui = PW.state.ui;
      if (ui.reqh > 20) { PW._reqhBefore = ui.reqh; ui.reqh = 12; } else ui.reqh = PW._reqhBefore || 42;
      PW.save(); PW.renderWork();
    } }, PW.state.ui.reqh > 20 ? '⤢ Focus' : '⤡ Restore');

    if (L) {
      const c = L.cfg || {};
      root.append(h('div', { class: 'lt-head' }, h('h4', { style: { margin: 0 } }, 'Load test'),
        h('span', { class: 'hint' }, c.mode === 'iterations' ? c.users + ' users × ' + c.iterations + ' loops' : c.users + ' users · ramp ' + c.rampUp + 's · hold ' + c.hold + 's' + (c.rampDown ? ' · down ' + c.rampDown + 's' : '')),
        h('span', { style: { marginLeft: 'auto' } }), focus));
      root.append(h('div', { id: 'loadLive' }, liveBody(L)));
      return root;
    }
    const runs = runsOf(tab);
    const selId = viewSel[tab.id] && runs.some((r) => r.id === viewSel[tab.id]) ? viewSel[tab.id] : runs[0] && runs[0].id;
    const idx = runs.findIndex((r) => r.id === selId);
    const sel = idx >= 0 ? fullReports[selId] || runs[idx] : null;
    const prev = idx >= 0 ? runs[idx + 1] : null;

    const plan = h('details', { class: 'lt-plan', open: !runs.length || PW._ltPlanOpen === tab.id },
      h('summary', null, h('b', null, 'Test plan'), h('span', { class: 'hint' }, ' — users, ramp-up, duration, think time, assertions, CSV data')),
      configForm(tab));
    plan.addEventListener('toggle', () => { PW._ltPlanOpen = plan.open ? tab.id : null; });
    root.append(h('div', { class: 'lt-head' }, h('h4', { style: { margin: 0 } }, 'Load test'), h('span', { class: 'hint' }, 'JMeter-style virtual users, run by the local server'), h('span', { style: { marginLeft: 'auto' } }), focus), plan);
    if (!plan.open) root.append(h('div', { class: 'lt-start', style: { margin: '0 0 12px' } },
      h('button', { class: 'btn primary', disabled: Object.values(PW.loads).some(isLive), onclick: () => PW.startLoad(tab.id) }, '▶ Start load test'),
      h('span', { class: 'hint' }, (() => { const c = cfgOf(tab); return c.mode === 'iterations' ? c.users + ' users × ' + c.iterations + ' loops' : c.users + ' users · ' + PW.fmtClock(K.plannedSeconds(c)); })())));
    if (sel) root.append(reportView(tab, sel, prev));
    else root.append(h('div', { class: 'placeholder', style: { height: 'auto', padding: '16px 0' } }, h('div', null, h('div', { style: { fontSize: '30px' } }, '📈'),
      h('h3', null, 'No load test yet'), h('div', null, 'Set users and duration above, then press Start. You get throughput, errors, Apdex and p50 … p99.99.'))));
    const hist = history(tab, selId);
    if (hist) root.append(hist);
    return root;
  };
})();
