// Request builder: name + tags, method + URL bar (curl-aware), params / headers / body / auth / settings.
(function () {
  'use strict';
  const { h } = PW;
  const subSel = {}; // tabId -> selected sub tab
  const HEADER_NAMES = ['Accept', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-None-Match', 'Origin', 'Referer', 'User-Agent', 'X-API-Key', 'X-Request-ID', 'X-Forwarded-For'];

  // ---------- URL <-> params ----------
  function splitUrl(u) {
    const hi = u.indexOf('#');
    const hash = hi >= 0 ? u.slice(hi) : '';
    const rest = hi >= 0 ? u.slice(0, hi) : u;
    const qi = rest.indexOf('?');
    return { base: qi >= 0 ? rest.slice(0, qi) : rest, query: qi >= 0 ? rest.slice(qi + 1) : null, hash };
  }
  function parseParams(u) {
    const { query } = splitUrl(u);
    if (!query) return [];
    return query.split('&').filter((s) => s !== '').map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? { key: p, value: '', noEq: true } : { key: p.slice(0, i), value: p.slice(i + 1) };
    });
  }
  function buildUrl(u, params) {
    const { base, hash } = splitUrl(u);
    const q = params.filter((p) => p.key !== '' || p.value !== '')
      .map((p) => (p.noEq && p.value === '' ? p.key : p.key + '=' + p.value)).join('&');
    return base + (q ? '?' + q : '') + hash;
  }

  // ---------- generic key/value editor ----------
  // list: array of {key,value,enabled?}; opts.checks -> show enable checkbox
  function kvEditor(list, opts) {
    opts = opts || {};
    const tbody = h('tbody');
    const table = h('table', { class: 'kv' }, tbody);
    const listId = opts.keyList ? 'dl-' + PW.uid() : null;
    const dl = listId ? h('datalist', { id: listId }, opts.keyList.map((k) => h('option', { value: k }))) : null;
    const changed = () => opts.onchange && opts.onchange(list);

    function row(item, isGhost) {
      const tr = h('tr');
      const key = h('input', { class: 'in', value: item.key, placeholder: opts.keyPh || 'key', list: listId, spellcheck: 'false', autocomplete: 'off' });
      const val = h('input', { class: 'in', value: item.value, placeholder: opts.valPh || 'value', spellcheck: 'false', autocomplete: 'off' });
      const chk = opts.checks ? h('input', { type: 'checkbox', checked: item.enabled !== false, onchange: () => { item.enabled = chk.checked; changed(); } }) : null;
      const rm = h('button', { class: 'rm', title: 'Remove', onclick: () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); tr.remove(); ensureGhost(); changed(); } }, '×');
      const touch = () => {
        item.key = key.value; item.value = val.value;
        if (opts.checks && item.enabled === undefined) item.enabled = true;
        if (isGhost.v) { isGhost.v = false; list.push(item); ensureGhost(); }
        changed();
      };
      key.addEventListener('input', touch); val.addEventListener('input', touch);
      tr.append(h('td', null, chk), h('td', null, key), h('td', null, val), h('td', { style: { width: '26px' } }, rm));
      return tr;
    }
    function ensureGhost() {
      const last = tbody.lastElementChild;
      if (last && last._ghost) return;
      const item = opts.checks ? { key: '', value: '', enabled: true } : { key: '', value: '' };
      const g = { v: true };
      const tr = row(item, g); tr._ghost = true;
      tbody.append(tr);
    }
    list.forEach((it) => tbody.append(row(it, { v: false })));
    ensureGhost();
    return h('div', null, table, dl);
  }

  // ---------- body helpers ----------
  PW.guessBodyType = function (body, headers) {
    if (!body) return 'none';
    const ct = (headers.find((x) => x.key.toLowerCase() === 'content-type') || {}).value || '';
    if (/json/i.test(ct)) return 'json';
    if (/x-www-form-urlencoded/i.test(ct)) return 'form';
    try { JSON.parse(body); return 'json'; } catch { return 'text'; }
  };

  PW.applyCurl = function (tab, text) {
    const r = Curl.parseCurl(text);
    if (!r.url) { PW.toast('That cURL has no URL'); return false; }
    tab.method = PW.METHODS.includes(r.method) ? r.method : r.method; // custom methods are kept as-is
    tab.url = r.url;
    tab.headers = r.headers;
    tab.body = r.body;
    tab.bodyType = PW.guessBodyType(r.body, r.headers);
    tab.settings.follow = r.followRedirects || tab.settings.follow;
    tab.settings.insecure = r.insecure;
    if (r.timeout) tab.settings.timeout = r.timeout;
    tab.auth = { type: 'none', token: '', user: '', pass: '' };
    if (!tab.name) { try { tab.name = new URL(/^[a-z]+:\/\//i.test(r.url) ? r.url : 'http://' + r.url).pathname.replace(/\/$/, '').split('/').pop() || ''; } catch { /* keep empty */ } }
    PW.save(); PW.emit('tabs'); PW.emit('active');
    PW.toast('cURL imported' + (r.warnings.length ? ' — ' + r.warnings[0] : ''));
    return true;
  };

  // The request as it would be sent now: variables resolved, and a scheme added the same way the server does.
  function resolvedSpec(id) {
    const missing = new Set();
    const sp = PW.buildSpec(PW.tab(id), PW.varMap(), missing);
    if (sp.url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(sp.url)) sp.url = 'http://' + sp.url;
    return { sp, missing: [...missing] };
  }

  PW.copyAsCurl = function (id) {
    PW.copy(Codegen.generate('curl', resolvedSpec(id).sp), 'Copied as cURL (variables resolved)');
  };

  // "Copy as code" dialog: cURL / JavaScript / Python / PowerShell
  PW.showCode = function (id) {
    const { sp, missing } = resolvedSpec(id);
    if (!sp.url.trim()) { PW.toast('Enter a URL first'); return; }
    const ui = PW.state.ui || (PW.state.ui = {});
    let lang = Codegen.LANGS.some((l) => l.id === ui.codeLang) ? ui.codeLang : 'curl';
    const seg = h('div', { class: 'seg' }), pre = h('pre', { class: 'code snippet' }), note = h('div', { class: 'hint' });
    const draw = () => {
      seg.textContent = '';
      Codegen.LANGS.forEach((l) => seg.append(h('button', { class: l.id === lang ? 'on' : '', onclick: () => { lang = l.id; ui.codeLang = l.id; PW.save(); draw(); } }, l.label)));
      pre.textContent = Codegen.generate(lang, sp);
      note.textContent = Codegen.LANGS.find((l) => l.id === lang).note.replace(/\.$/, '') + '. Variables are resolved from the active environment' +
        (missing.length ? '; not defined (left as-is): ' + missing.map((m) => '{{' + m + '}}').join(', ') : '') + '.';
    };
    draw();
    PW.modal({
      title: 'Copy as code', wide: true, body: h('div', null, seg, pre, note),
      buttons: [{ label: 'Close' }, { label: 'Copy', primary: true, onclick: (close) => { PW.copy(pre.textContent, 'Copied ' + Codegen.LANGS.find((l) => l.id === lang).label + ' code'); close(); } }],
    });
  };

  PW.importCurlModal = function () {
    const ta = h('textarea', { class: 'in ta-import', placeholder: "curl -X POST 'https://api.example.com/v1/users' \\\n  -H 'Authorization: Bearer {{token}}' \\\n  -d '{\"name\":\"Ada\"}'", spellcheck: 'false' });
    const go = (close) => {
      if (!ta.value.trim()) return;
      if (!Curl.looksLikeCurl(ta.value)) { PW.toast('That does not look like a cURL command'); return; }
      close();
      const cur = PW.tab();
      const empty = cur && !cur.url && !cur.body && !cur.headers.length;
      PW.applyCurl(empty ? cur : PW.addTab({}, { groupId: cur ? cur.groupId : null }), ta.value);
    };
    PW.modal({
      title: 'Import cURL', wide: true,
      body: h('div', null, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Paste a command from your terminal or browser DevTools (“Copy as cURL”). You can also paste it anywhere in the app to import it automatically.'), ta),
      buttons: [{ label: 'Cancel' }, { label: 'Import', primary: true, onclick: go }],
    });
    setTimeout(() => ta.focus(), 20);
  };

  // ---------- name + tags ----------
  function nameBar(tab) {
    const name = h('input', { class: 'nameinp', value: tab.name, placeholder: 'Untitled request', spellcheck: 'false' });
    name.addEventListener('input', () => { tab.name = name.value; PW.save(); PW.renderStrip(); PW.renderSide(); });
    PW.bind('name', name, () => { name.value = tab.name; });

    const wrap = h('div', { class: 'tagsedit' });
    const input = h('input', { placeholder: '+ tag', spellcheck: 'false', list: 'alltags' });
    const all = h('datalist', { id: 'alltags' });
    const draw = () => {
      wrap.textContent = '';
      tab.tags.forEach((tg) => wrap.append(h('span', { class: 'tg' }, '#' + tg, h('button', { title: 'Remove tag', onclick: () => { tab.tags = tab.tags.filter((x) => x !== tg); PW.save(); draw(); PW.renderStrip(); PW.renderSide(); } }, '×'))));
      const seen = new Set(tab.tags);
      all.textContent = '';
      PW.state.tabs.forEach((t) => t.tags.forEach((x) => { if (!seen.has(x)) { seen.add(x); all.append(h('option', { value: x })); } }));
      wrap.append(input, all);
    };
    const add = () => {
      const v = input.value.split(',').map((s) => s.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-')).filter(Boolean);
      if (!v.length) return;
      v.forEach((x) => { if (!tab.tags.includes(x)) tab.tags.push(x); });
      input.value = ''; PW.save(); draw(); input.focus(); PW.renderStrip(); PW.renderSide();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
      else if (e.key === 'Backspace' && !input.value && tab.tags.length) { tab.tags.pop(); PW.save(); draw(); input.focus(); PW.renderStrip(); PW.renderSide(); }
    });
    input.addEventListener('blur', add);
    draw();
    return h('div', { class: 'namebar' }, name, wrap,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', title: 'Copy as cURL, JavaScript, Python or PowerShell', onclick: () => PW.showCode(tab.id) }, '</> Code'));
  }

  // ---------- URL bar ----------
  function resolvedPreview(tab, box) {
    const url = tab.url || '';
    box.textContent = '';
    if (url.indexOf('{{') === -1) return;
    const map = PW.varMap();
    const parts = url.split(/(\{\{\s*[^{}\s]+\s*\}\})/);
    parts.forEach((p) => {
      const m = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(p);
      if (!m) { box.append(p); return; }
      const name = m[1];
      if (Object.prototype.hasOwnProperty.call(map, name)) box.append(map[name]);
      else if (PW.DYNAMIC.includes(name)) box.append(h('span', { title: 'Generated fresh on every send' }, '⟨' + name + '⟩'));
      else box.append(h('span', { class: 'miss', title: 'Not defined — click {{vars}} to add it' }, p));
    });
    box.prepend('→ ');
  }

  function urlRow(tab) {
    const method = h('select', { title: 'HTTP method' }, PW.METHODS.concat(PW.METHODS.includes(tab.method) ? [] : [tab.method]).map((m) => h('option', { value: m, selected: m === tab.method }, m)));
    const paintMethod = () => { method.className = 'm-' + method.value; };
    method.addEventListener('change', () => { tab.method = method.value; paintMethod(); PW.save(); PW.renderStrip(); PW.renderSide(); });
    paintMethod();

    const url = h('input', { value: tab.url, placeholder: 'Enter URL or paste a cURL command…   e.g. {{baseUrl}}/users', spellcheck: 'false', autocomplete: 'off' });
    const prev = h('div', { class: 'resolved' });
    const refresh = () => resolvedPreview(tab, prev);
    url.addEventListener('input', () => {
      tab.url = url.value; PW.save(); refresh(); PW.renderStrip(); PW.renderSide();
      if (Curl.looksLikeCurl(url.value) && /\s-{1,2}\w/.test(url.value)) { PW.applyCurl(tab, url.value); return; } // typed/dropped curl
      if ((subSel[tab.id] || 'params') === 'params') PW.emit('params');
    });
    // plain Enter sends; Ctrl/Cmd+Enter is handled once by the global shortcut (avoids double-fire = send + cancel)
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); PW.sendActive(); } });
    PW.bind('env', prev, refresh);
    refresh();

    const send = h('button', { class: 'btn primary sendbtn', id: 'sendBtn', title: 'Send (Ctrl+Enter)', onclick: () => PW.sendActive() }, 'Send ▸');
    const compare = h('button', { class: 'btn', id: 'compareBtn', title: 'Send to several environments at once and compare speed and data', onclick: () => PW.compare(tab.id) }, '⇆ Compare');
    const load = h('button', { class: 'btn', id: 'loadBtn', title: 'Load test: virtual users, ramp-up, throughput, p50 … p99.99', onclick: () => PW.showResponseTab(tab.id, 'load') }, '📈 Load');
    return h('div', null, h('div', { class: 'urlrow' }, h('div', { class: 'urlbar' }, method, url), send, compare, load), prev);
  }

  // ---------- sub panes ----------
  function paramsPane(tab) {
    const box = h('div');
    const draw = () => {
      box.textContent = '';
      const list = parseParams(tab.url);
      box.append(kvEditor(list, {
        keyPh: 'param', valPh: 'value',
        onchange: (l) => {
          tab.url = buildUrl(tab.url, l);
          const input = PW.$('.urlbar input'); if (input) input.value = tab.url;
          PW.save(); PW.renderStrip(); PW.renderSide(); PW.emit('env');
        },
      }), h('p', { class: 'hint' }, 'Synced with the URL. Use ', h('code', null, '{{variables}}'), ' anywhere.'));
    };
    PW.bind('params', box, draw);
    draw();
    return box;
  }

  function headersPane(tab) {
    return h('div', null,
      kvEditor(tab.headers, { checks: true, keyPh: 'Header', valPh: 'value', keyList: HEADER_NAMES, onchange: () => { PW.save(); PW.emit('subcount'); } }),
      h('p', { class: 'hint' }, 'Content-Type is added automatically for bodies, and gzip/br responses are decoded for you.'));
  }

  function bodyPane(tab) {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' } });
    const draw = () => {
      wrap.textContent = '';
      const seg = h('div', { class: 'seg' }, [['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['form', 'Form URL-encoded']].map(([v, l]) =>
        h('button', { class: tab.bodyType === v ? 'on' : '', onclick: () => { tab.bodyType = v; PW.save(); draw(); PW.emit('subcount'); } }, l)));
      const bar = h('div', { class: 'form-row', style: { margin: 0 } }, seg);
      if (tab.bodyType === 'json') {
        bar.append(h('button', { class: 'btn', onclick: () => {
          const resolvedOk = tab.body.indexOf('{{') === -1;
          try { tab.body = JSON.stringify(JSON.parse(tab.body), null, 2); PW.save(); draw(); }
          catch (e) { PW.toast(resolvedOk ? 'Invalid JSON: ' + e.message : 'Body has {{variables}}; can only prettify once they form valid JSON'); }
        } }, 'Prettify'));
        bar.append(h('button', { class: 'btn ghost', onclick: () => { try { tab.body = JSON.stringify(JSON.parse(tab.body)); PW.save(); draw(); } catch (e) { PW.toast('Invalid JSON: ' + e.message); } } }, 'Minify'));
      }
      wrap.append(bar);
      if (tab.bodyType === 'none') { wrap.append(h('div', { class: 'placeholder', style: { flex: 1 } }, h('div', null, 'This request has no body'))); return; }
      const ta = h('textarea', { class: 'in', spellcheck: 'false', placeholder: tab.bodyType === 'form' ? 'name=Ada&role=admin' : tab.bodyType === 'json' ? '{\n  "hello": "{{name}}"\n}' : '' }, tab.body);
      ta.value = tab.body;
      ta.addEventListener('input', () => { tab.body = ta.value; PW.save(); });
      ta.addEventListener('keydown', (e) => { // Tab inserts spaces
        if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
      });
      wrap.append(h('div', { style: { flex: 1, minHeight: 0 } }, ta));
    };
    draw();
    return wrap;
  }

  function authPane(tab) {
    const box = h('div');
    const draw = () => {
      box.textContent = '';
      const a = tab.auth;
      box.append(h('div', { class: 'form-row' }, h('label', null, 'Type'),
        h('div', { class: 'seg' }, [['none', 'None'], ['bearer', 'Bearer token'], ['basic', 'Basic']].map(([v, l]) =>
          h('button', { class: a.type === v ? 'on' : '', onclick: () => { a.type = v; PW.save(); draw(); PW.emit('subcount'); } }, l)))));
      const field = (label, key, type) => h('div', { class: 'form-row' }, h('label', null, label),
        h('input', { class: 'in', style: { maxWidth: '460px' }, type: type || 'text', value: a[key], spellcheck: 'false', placeholder: key === 'token' ? '{{token}}' : '', oninput: (e) => { a[key] = e.target.value; PW.save(); } }));
      if (a.type === 'bearer') box.append(field('Token', 'token'));
      if (a.type === 'basic') box.append(field('Username', 'user'), field('Password', 'pass', 'password'));
      box.append(h('p', { class: 'hint' }, 'Sent as an Authorization header unless you already set one in Headers.'));
    };
    draw();
    return box;
  }

  function settingsPane(tab) {
    const s = tab.settings;
    const num = h('input', { class: 'in', type: 'number', min: 1, style: { width: '110px' }, value: Math.round(s.timeout / 1000), oninput: (e) => { s.timeout = Math.max(100, (Number(e.target.value) || 30) * 1000); PW.save(); } });
    const chk = (label, key, hint) => h('div', { class: 'form-row' }, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: s[key], onchange: (e) => { s[key] = e.target.checked; PW.save(); } }), label), h('span', { class: 'hint' }, hint));
    const caps = h('div');
    const drawCaps = () => {
      caps.textContent = '';
      caps.append(kvEditor(tab.captures, { keyPh: 'variable name', valPh: 'JSON path, e.g. data.token or items[0].id', onchange: () => PW.save() }));
    };
    drawCaps();
    return h('div', null,
      h('div', { class: 'form-row' }, h('label', null, 'Timeout (s)'), num),
      chk('Follow redirects', 'follow', 'Up to 10 hops; auth/cookies are dropped on cross-origin redirects.'),
      chk('Ignore TLS errors', 'insecure', 'For self-signed dev certificates only.'),
      h('h4', { style: { marginTop: '18px' } }, 'Capture into the active environment after each response'),
      caps,
      h('p', { class: 'hint' }, 'Great for tokens: set ', h('code', null, 'token'), ' = ', h('code', null, 'access_token'), ' and use ', h('code', null, '{{token}}'), ' in the next request.'));
  }

  // ---------- tests (declarative checks run after every Send and in the group runner) ----------
  function testsPane(tab) {
    if (!Array.isArray(tab.tests)) tab.tests = [];
    const box = h('div');
    const changed = () => { PW.save(); PW.emit('subcount'); };
    const draw = () => {
      box.textContent = '';
      const list = h('div', { class: 'tests' });
      tab.tests.forEach((t) => {
        const info = Checks.TYPES[t.type] || Checks.TYPES.status;
        const type = h('select', { class: 'in', title: 'What to check', onchange: (e) => { t.type = e.target.value; t.op = Checks.TYPES[t.type].ops[0]; t.target = ''; if (t.type === 'status') t.value = '2xx'; else if (t.type === 'time') t.value = '500'; else t.value = ''; changed(); draw(); } },
          Object.entries(Checks.TYPES).map(([k, v]) => h('option', { value: k, selected: k === t.type }, v.label)));
        const target = info.target ? h('input', { class: 'in', value: t.target || '', placeholder: info.target, spellcheck: 'false', oninput: (e) => { t.target = e.target.value; changed(); } }) : null;
        const op = h('select', { class: 'in', onchange: (e) => { t.op = e.target.value; changed(); draw(); } }, info.ops.map((o) => h('option', { value: o, selected: o === t.op }, Checks.OPS[o])));
        const val = Checks.NO_VALUE.has(t.op) ? h('span') : h('input', { class: 'in', value: t.value || '', placeholder: info.value, spellcheck: 'false', oninput: (e) => { t.value = e.target.value; changed(); } });
        list.append(h('div', { class: 'test-row' + (info.target ? '' : ' nt') + (t.enabled === false ? ' off' : '') },
          h('input', { type: 'checkbox', checked: t.enabled !== false, title: 'Enabled', onchange: (e) => { t.enabled = e.target.checked; changed(); draw(); } }),
          ...[type, target, op, val].filter(Boolean),
          h('button', { class: 'rm', title: 'Remove', onclick: () => { tab.tests.splice(tab.tests.indexOf(t), 1); changed(); draw(); } }, '×')));
      });
      const add = (type) => h('button', { class: 'btn', onclick: () => { tab.tests.push(Checks.make(type)); changed(); draw(); } }, '＋ ' + Checks.TYPES[type].label);
      box.append(
        tab.tests.length ? list : h('p', { class: 'hint', style: { marginTop: 0 } }, 'No tests yet. Add checks that must hold after every Send; they also decide pass/fail in the group runner.'),
        h('div', { class: 'form-row', style: { gap: '6px', flexWrap: 'wrap' } }, add('status'), add('time'), add('json'), add('header'), add('body')),
        h('p', { class: 'hint' }, 'Values may use ', h('code', null, '{{variables}}'), '. “equals” treats ', h('code', null, '7'), ' as the number 7 or the text “7”; use ', h('code', null, '"7"'), ' for text only, or JSON like ', h('code', null, '["a","b"]'), '. Status accepts ', h('code', null, '2xx'), ', ', h('code', null, '200'), ', ', h('code', null, '200-299, 404'), '.'));
    };
    draw();
    return box;
  }

  // ---------- assemble ----------
  PW.buildTop = (tab) => h('div', null, nameBar(tab), urlRow(tab));

  PW.buildReqPane = function (tab) {
    const counts = () => ({
      params: parseParams(tab.url).length,
      headers: tab.headers.filter((x) => x.key && x.enabled !== false).length,
      body: tab.bodyType !== 'none' && tab.body ? '●' : 0,
      auth: tab.auth.type !== 'none' ? '●' : 0,
      tests: (tab.tests || []).filter((x) => x.enabled !== false).length,
      settings: tab.captures.filter((c) => c.key).length,
    });
    const defs = [['params', 'Params', paramsPane], ['headers', 'Headers', headersPane], ['body', 'Body', bodyPane], ['auth', 'Auth', authPane], ['tests', 'Tests', testsPane], ['settings', 'Settings', settingsPane]];
    const bar = h('div', { class: 'tabs' });
    const body = h('div', { class: 'body' });
    const draw = () => {
      const cur = subSel[tab.id] || 'params';
      const c = counts();
      bar.textContent = '';
      defs.forEach(([id, label]) => bar.append(h('button', { class: cur === id ? 'on' : '', onclick: () => { subSel[tab.id] = id; draw(); } }, label, c[id] ? h('span', { class: 'badge' }, c[id]) : null)));
      body.textContent = '';
      body.append(defs.find((d) => d[0] === cur)[2](tab));
    };
    PW.bind('subcount', bar, () => { { const c = counts(); const cur = subSel[tab.id] || 'params'; bar.querySelectorAll('button').forEach((b, i) => { const id = defs[i][0]; const old = b.querySelector('.badge'); if (old) old.remove(); if (c[id]) b.append(h('span', { class: 'badge' }, c[id])); b.className = cur === id ? 'on' : ''; }); } });
    draw();
    return h('div', { class: 'pane', style: { minHeight: 0, height: '100%' } }, bar, body);
  };

  PW._parseParams = parseParams; PW._buildUrl = buildUrl; // exposed for tests
})();
