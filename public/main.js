// Boot, layout, shortcuts, theme, export / import (own format + Postman v2.x collections & environments).
(function () {
  'use strict';
  const { h } = PW;

  // ---------- workspace skeleton ----------
  PW.renderWork = function () {
    const work = PW.$('#work');
    const tab = PW.tab();
    work.textContent = '';
    const p = PW.state.ui.reqh || 42;
    work.style.gridTemplateRows = `auto minmax(90px, ${p}fr) 6px minmax(120px, ${100 - p}fr)`;
    const split = h('div', { class: 'splitter', title: 'Drag to resize' });
    work.append(PW.buildTop(tab), h('div', { id: 'reqpane', style: { minHeight: 0, overflow: 'hidden' } }, PW.buildReqPane(tab)), split, h('div', { id: 'respane', class: 'pane' }));
    split.addEventListener('mousedown', (e) => {
      e.preventDefault(); split.classList.add('drag');
      const top = work.firstElementChild.getBoundingClientRect(), box = work.getBoundingClientRect();
      const move = (ev) => {
        const avail = box.height - top.height - 6;
        const pct = Math.min(80, Math.max(15, ((ev.clientY - box.top - top.height) / avail) * 100));
        PW.state.ui.reqh = pct;
        work.style.gridTemplateRows = `auto minmax(90px, ${pct}fr) 6px minmax(120px, ${100 - pct}fr)`;
      };
      const up = () => { split.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); PW.save(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    PW.renderResponse();
    PW.emit('running');
    if (!tab.url) { const i = PW.$('.urlbar input'); i && i.focus(); }
  };

  PW.toggleTheme = function () {
    const ui = PW.state.ui;
    ui.theme = ui.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = ui.theme;
    PW.save();
  };

  // ---------- import helpers ----------
  const hdrs = (arr) => (arr || []).filter((x) => x && x.key).map((x) => ({ key: x.key, value: x.value == null ? '' : String(x.value), enabled: !x.disabled }));
  const kvOf = (arr, k) => ((arr || []).find((x) => x.key === k) || {}).value || '';

  function fromPostmanCollection(c) {
    const groups = [], tabs = [], notes = new Set();
    const walk = (items, gid, path) => {
      for (const it of items || []) {
        if (it.item) {
          const name = path ? path + ' / ' + it.name : it.name;
          const hasReq = it.item.some((x) => x.request);
          let id = gid;
          if (hasReq) { id = PW.uid(); groups.push({ id, name, color: PW.COLORS[groups.length % PW.COLORS.length], collapsed: false }); }
          walk(it.item, id, name);
          continue;
        }
        const r = it.request; if (!r) continue;
        const req = typeof r === 'string' ? { method: 'GET', url: r } : r;
        const url = typeof req.url === 'string' ? req.url : (req.url && req.url.raw) || '';
        const t = PW.makeTab({ name: it.name || '', groupId: gid || null, method: (req.method || 'GET').toUpperCase(), url, headers: hdrs(req.header) });
        const b = req.body;
        if (b) {
          if (b.mode === 'raw') { t.body = b.raw || ''; t.bodyType = (b.options && b.options.raw && b.options.raw.language === 'json') || PW.guessBodyType(t.body, t.headers) === 'json' ? 'json' : 'text'; }
          else if (b.mode === 'urlencoded') { t.body = (b.urlencoded || []).filter((x) => !x.disabled).map((x) => x.key + '=' + x.value).join('&'); t.bodyType = 'form'; }
          else if (b.mode === 'graphql' && b.graphql) { t.body = JSON.stringify({ query: b.graphql.query, variables: b.graphql.variables ? safeJson(b.graphql.variables) : undefined }, null, 2); t.bodyType = 'json'; }
          else if (b.mode && b.mode !== 'none') notes.add('Body mode “' + b.mode + '” is not supported (skipped in some requests).');
        }
        const a = req.auth;
        if (a && a.type === 'bearer') t.auth = { type: 'bearer', token: kvOf(a.bearer, 'token'), user: '', pass: '' };
        else if (a && a.type === 'basic') t.auth = { type: 'basic', token: '', user: kvOf(a.basic, 'username'), pass: kvOf(a.basic, 'password') };
        tabs.push(t);
      }
    };
    walk(c.item, null, '');
    const vars = (c.variable || []).filter((v) => v.key).map((v) => ({ key: v.key, value: v.value == null ? '' : String(v.value), secret: false, enabled: !v.disabled }));
    return { groups, tabs, notes: [...notes], envs: vars.length ? [{ id: PW.uid(), name: (c.info && c.info.name || 'Collection') + ' variables', vars }] : [] };
  }
  const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

  function fromPostmanEnv(e) {
    return { id: PW.uid(), name: e.name || 'Imported', vars: (e.values || []).filter((v) => v.key).map((v) => ({ key: v.key, value: v.value == null ? '' : String(v.value), secret: v.type === 'secret', enabled: v.enabled !== false })) };
  }

  function mergeInto(st, add) {
    const gmap = {};
    (add.groups || []).forEach((g) => { const n = Object.assign({}, g, { id: PW.uid() }); gmap[g.id] = n.id; st.groups.push(n); });
    (add.tabs || []).forEach((t) => { const n = PW.makeTab(Object.assign({}, t, { id: PW.uid(), groupId: t.groupId ? (gmap[t.groupId] || null) : null })); st.tabs.push(n); });
    (add.envs || []).forEach((e) => {
      if (e.id === 'globals') { const g = PW.globals(); e.vars.forEach((v) => { if (!g.vars.some((x) => x.key === v.key)) g.vars.push(v); }); return; }
      const n = Object.assign({}, e, { id: PW.uid() });
      while (st.envs.some((x) => x.name === n.name)) n.name += ' (imported)';
      st.envs.push(n);
    });
  }

  function handleImport(text, close) {
    let j; try { j = JSON.parse(text); } catch { PW.toast('That file is not valid JSON'); return; }
    const st = PW.state;
    if (j && j.info && /collection/i.test(j.info.schema || '') || (j && j.info && Array.isArray(j.item))) {
      const r = fromPostmanCollection(j);
      mergeInto(st, r); PW.save(); close();
      PW.emit('tabs'); PW.emit('env'); PW.renderEnvSelect();
      PW.toast('Imported ' + r.tabs.length + ' requests from Postman' + (r.notes.length ? ' — ' + r.notes[0] : ''), null, null, 5000);
    } else if (j && Array.isArray(j.values)) {
      st.envs.push(fromPostmanEnv(j)); PW.save(); close(); PW.renderEnvSelect(); PW.toast('Environment imported');
    } else if (j && Array.isArray(j.tabs)) {
      const doc = PW.normalize(JSON.parse(text));
      PW.modal({
        title: 'Import Postwoman backup',
        body: h('p', null, doc.tabs.length + ' requests, ' + doc.groups.length + ' groups, ' + (doc.envs.length - 1) + ' environments.'),
        buttons: [
          { label: 'Cancel' },
          { label: 'Merge into current', onclick: (c) => { mergeInto(st, doc); PW.save(); c(); PW.emit('tabs'); PW.renderEnvSelect(); PW.toast('Merged'); } },
          { label: 'Replace everything', primary: true, onclick: (c) => { PW.state = doc; PW.responses = {}; document.documentElement.dataset.theme = doc.ui.theme; PW.save(); c(); PW.emit('tabs'); PW.renderEnvSelect(); PW.renderWork(); PW.toast('Replaced'); } },
        ],
      });
    } else PW.toast('Unrecognised file. Expected a Postwoman backup or a Postman collection/environment (v2.x JSON).');
  }

  PW.dataModal = function () {
    const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    file.addEventListener('change', () => { const f = file.files[0]; if (!f) return; f.text().then((t) => handleImport(t, PW.closeOverlay)); });
    PW.modal({
      title: 'Backup & import',
      body: h('div', null,
        h('p', { style: { marginTop: 0 } }, 'Everything lives in ', h('code', null, 'data.json'), ' next to the server, so it survives restarts. Backups include environment values (even masked ones), so treat the file like a password.'),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => { PW.download('postwoman-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(PW.state, null, 2), 'application/json'); } }, '⬇ Export everything'),
          h('button', { class: 'btn', onclick: () => file.click() }, '⬆ Import file…')),
        h('p', { class: 'hint' }, 'Import accepts Postwoman backups, Postman collections (v2.0 / v2.1) and Postman environments. Folders become groups, and {{variables}} keep working.'), file),
      buttons: [{ label: 'Close' }],
    });
  };

  // ---------- shortcuts ----------
  function wireShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); PW.sendActive(); }
      else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); PW.openPalette(); }
      else if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); const i = PW.$('.urlbar input'); i && (i.focus(), i.select()); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); PW.saveNow().then(() => PW.toast('Saved ✓')); }
      else if (e.key === '?' && !mod && !e.altKey && !(e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) && !PW.$('#overlay').firstChild) { e.preventDefault(); PW.shortcutsModal(); }
      else if (e.altKey && !mod && e.key.toLowerCase() === 't') { e.preventDefault(); PW.addTab(); }
      else if (e.altKey && !mod && e.key.toLowerCase() === 'w') { e.preventDefault(); PW.closeTabs([PW.state.activeTabId]); }
      else if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
        const ids = [...document.querySelectorAll('#strip .tab')].map((x) => x.dataset.id);
        const id = e.key === '9' ? ids[ids.length - 1] : ids[Number(e.key) - 1];
        if (id) { e.preventDefault(); PW.activate(id); }
      }
    });
  }

  PW.shortcutsModal = function () {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    const M = mac ? '⌘' : 'Ctrl';
    const rows = [
      [M + ' + Enter', 'Send the request (press again to cancel)'], [M + ' + K', 'Command palette: jump to a request, #tag, group or action'],
      [M + ' + L', 'Focus the URL bar'], [M + ' + S', 'Save now (changes are also saved automatically)'],
      ['Alt + T', 'New request'], ['Alt + W', 'Close the current request'], ['Alt + 1 … 9', 'Switch to the 1st … 9th open request (9 = last)'],
      ['Esc', 'Close a dialog'], ['?', 'Show this help (when not typing in a field)'],
    ];
    PW.modal({
      title: 'Keyboard shortcuts',
      body: PW.h('div', null, PW.h('table', { class: 'keys' }, rows.map(([k, d]) => PW.h('tr', null, PW.h('td', null, k.split(' + ').map((x, i) => [i ? ' + ' : '', PW.h('kbd', null, x)])), PW.h('td', null, d)))),
        PW.h('p', { class: 'hint' }, 'Tip: paste a cURL command anywhere to import it as a new request.')),
      buttons: [{ label: 'Close', primary: true }],
    });
  };

  function wireCurlPaste() {
    document.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!Curl.looksLikeCurl(text)) return;

      const target = e.target;
      const isUrlInput = target instanceof Element && target.closest('.urlbar input');
      const isCurlModal = target instanceof Element && target.closest('.ta-import');
      const current = PW.tab();
      const empty = current && !current.url && !current.body && !current.headers.length;
      const tab = isUrlInput || empty ? current : PW.addTab({}, { groupId: current ? current.groupId : null });

      e.preventDefault();
      if (isCurlModal) PW.closeOverlay();
      PW.applyCurl(tab, text);
    }, true);
  }

  // ---------- boot ----------
  (async function boot() {
    await PW.load();
    const app = PW.$('#app');
    document.documentElement.dataset.theme = PW.state.ui.theme;
    const applySide = () => app.classList.toggle('with-side', !!PW.state.ui.side);
    applySide();
    PW.$('#btnSide').addEventListener('click', () => { PW.state.ui.side = !PW.state.ui.side; applySide(); PW.save(); });
    PW.$('#btnPalette').addEventListener('click', PW.openPalette);
    PW.$('#btnCurl').addEventListener('click', PW.importCurlModal);
    PW.$('#btnAI').addEventListener('click', PW.openAgents);
    PW.$('#btnEnv').addEventListener('click', () => PW.openEnv());
    PW.$('#btnData').addEventListener('click', PW.dataModal);
    PW.$('#btnTheme').addEventListener('click', PW.toggleTheme);
    PW.$('#envSelect').addEventListener('change', (e) => { PW.state.activeEnvId = e.target.value || null; PW.save(); PW.emit('env'); });
    PW.$('#q').addEventListener('input', (e) => { PW.filter.q = e.target.value; PW.renderSide(); });
    PW.on('active', PW.renderWork);
    wireCurlPaste();
    wireShortcuts();
    PW.renderEnvSelect();
    PW.emit('tabs');
    PW.renderWork();
    PW.resumeLoad && PW.resumeLoad().then(() => PW.connectAgents && PW.connectAgents());
  })();
})();
