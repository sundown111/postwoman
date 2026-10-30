// Group runner: sends every request of a group in order, runs each request's Tests, shows a pass/fail table.
(function () {
  'use strict';
  const { h } = PW;

  PW.runGroup = function (gid) {
    const g = PW.group(gid);
    if (!g) return;
    const tabs = PW.state.tabs.filter((t) => t.groupId === gid);
    if (!tabs.length) { PW.toast('This group has no requests yet'); return; }

    const rows = tabs.map((tab) => ({ tab, state: 'pending', status: null, ms: null, tests: null, note: '' }));
    let ctl = null, running = false, startedAt = 0, endedAt = 0;

    const stopOnFail = h('input', { type: 'checkbox', id: 'rn-stop' });
    const delay = h('input', { class: 'in', type: 'number', min: 0, max: 60000, value: 0, style: { width: '84px' }, title: 'Pause between requests (ms)' });
    const runBtn = h('button', { class: 'btn primary', id: 'rn-run', onclick: () => (running ? ctl.abort() : run()) }, '');
    const summary = h('div', { class: 'rn-summary' });
    const tbody = h('tbody');
    const table = h('table', { class: 'rn' }, h('thead', null, h('tr', null, ['#', 'Request', 'Status', 'Time', 'Tests', 'Result'].map((x) => h('th', null, x)))), tbody);

    const ICON = { pending: '·', running: '…', pass: '✓ pass', fail: '✗ fail', skipped: '– skipped' };
    const draw = () => {
      tbody.textContent = '';
      rows.forEach((r, i) => {
        const t = r.tab;
        tbody.append(h('tr', { class: 'rn-' + r.state, title: 'Open this request', onclick: () => { close(); PW.activate(t.id); } },
          h('td', null, i + 1),
          h('td', null, h('span', { class: 'm-' + t.method, style: { fontWeight: 700, marginRight: '6px' } }, t.method), PW.tabTitle(t), r.note ? h('div', { class: 'hint' }, r.note) : null),
          h('td', null, r.status ? h('span', { class: 'chip s' + Math.floor(r.status / 100) }, r.status) : r.state === 'fail' && r.note ? h('span', { class: 'chip s0' }, 'ERR') : ''),
          h('td', null, r.ms != null ? PW.fmtMs(r.ms) : ''),
          h('td', null, r.tests ? r.tests.passed + '/' + r.tests.total : ''),
          h('td', { class: 'rn-res' }, r.state === 'running' ? PW.spin() : ICON[r.state])));
      });
      const n = (s) => rows.filter((r) => r.state === s).length;
      const done = n('pass') + n('fail');
      const secs = startedAt ? ((endedAt || Date.now()) - startedAt) / 1000 : 0;
      summary.textContent = '';
      summary.append(h('b', null, n('pass') + ' passed'), ' · ', h('b', { class: n('fail') ? 'rn-bad' : '' }, n('fail') + ' failed'), n('skipped') ? ' · ' + n('skipped') + ' skipped' : '',
        startedAt ? ' · ' + (running ? done + ' of ' + rows.length + ' done · ' : '') + secs.toFixed(1) + ' s' : ' · ' + rows.length + ' request' + (rows.length === 1 ? '' : 's') + ' ready');
      runBtn.textContent = running ? 'Stop' : startedAt ? 'Run again' : '▶ Run ' + rows.length + ' request' + (rows.length === 1 ? '' : 's');
      runBtn.className = 'btn ' + (running ? 'danger' : 'primary');
    };

    function verdict(row, res) {
      row.ms = res.ok ? res.timings.total : null;
      row.status = res.ok ? res.status : null;
      if (!res.ok) { row.state = 'fail'; row.note = res.error || 'Request failed'; return; }
      if (res.tests) {
        const s = Checks.summarize(res.tests);
        row.tests = s;
        row.state = s.failed ? 'fail' : 'pass';
        const bad = res.tests.filter((x) => !x.pass);
        row.note = bad.length ? bad[0].label + (bad[0].error ? ' (' + bad[0].error + ')' : bad[0].actual !== undefined ? ' (got ' + bad[0].actual + ')' : '') + (bad.length > 1 ? ' +' + (bad.length - 1) + ' more' : '') : '';
      } else { // no tests defined: judged by the status code
        row.state = res.status < 400 ? 'pass' : 'fail';
        row.note = 'no tests; judged by status code';
      }
    }

    async function run() {
      running = true; startedAt = Date.now(); endedAt = 0;
      ctl = new AbortController();
      rows.forEach((r) => Object.assign(r, { state: 'pending', status: null, ms: null, tests: null, note: '' }));
      draw();
      const tick = setInterval(draw, 250);
      try {
        for (let i = 0; i < rows.length; i++) {
          if (ctl.signal.aborted) break;
          const row = rows[i], t = row.tab;
          if (!t.url.trim()) { row.state = 'skipped'; row.note = 'No URL'; draw(); continue; }
          row.state = 'running'; draw();
          const res = await PW.send(t.id, { signal: ctl.signal, quiet: true });
          if (res.code === 'ABORT') { row.state = 'pending'; break; }
          PW.responses[t.id] = res;
          verdict(row, res);
          draw();
          if (row.state === 'fail' && stopOnFail.checked) {
            rows.slice(i + 1).forEach((r) => { r.state = 'skipped'; r.note = 'Stopped after a failure'; });
            break;
          }
          const wait = Number(delay.value) || 0;
          if (wait && i < rows.length - 1) await new Promise((r) => setTimeout(r, wait));
        }
      } finally {
        clearInterval(tick);
        running = false; endedAt = Date.now();
        rows.forEach((r) => { if (r.state === 'pending' && ctl.signal.aborted && startedAt) { r.state = 'skipped'; r.note = 'Stopped'; } });
        draw();
        PW.emit('tabs');
        PW.renderResponse();
      }
    }

    const report = () => JSON.stringify({
      group: g.name, environment: (PW.activeEnv() || {}).name || null, at: new Date(startedAt || Date.now()).toISOString(), seconds: startedAt ? ((endedAt || Date.now()) - startedAt) / 1000 : 0,
      passed: rows.filter((r) => r.state === 'pass').length, failed: rows.filter((r) => r.state === 'fail').length,
      requests: rows.map((r) => ({ name: PW.tabTitle(r.tab), method: r.tab.method, url: r.tab.url, result: r.state, status: r.status, ms: r.ms == null ? null : Math.round(r.ms * 10) / 10, note: r.note || undefined,
        tests: (PW.responses[r.tab.id] && r.state !== 'pending' && PW.responses[r.tab.id].tests || []).map((x) => ({ check: x.label, pass: x.pass, got: x.actual, error: x.error })) })),
    }, null, 2);

    const body = h('div', null,
      h('div', { class: 'rn-opts' }, runBtn,
        h('label', { class: 'chk' }, stopOnFail, 'Stop at the first failure'),
        h('label', { class: 'chk', title: 'Pause between requests' }, 'Delay ', delay, ' ms')),
      summary,
      h('div', { class: 'rn-wrap' }, table),
      h('p', { class: 'hint' }, 'Requests are sent for real, in sidebar order, using the active environment. Captures run, so a login request can feed the ones after it. A request passes when all its Tests pass (or, with no tests, when the status is below 400). Click a row to open it.'));
    const { box, close } = PW.modal({
      title: '▶ Run group “' + g.name + '”', wide: true, body,
      buttons: [{ label: 'Copy report (JSON)', onclick: () => { if (!startedAt) { PW.toast('Run the group first'); return; } PW.copy(report(), 'Report copied'); } }, { label: 'Close', primary: true }],
    });
    draw();
    // closing the dialog (Esc, click outside, Close) cancels a run in progress
    const watch = setInterval(() => { if (!box.isConnected) { clearInterval(watch); if (running && ctl) ctl.abort(); } }, 300);
    setTimeout(() => runBtn.focus(), 30);
  };
})();
