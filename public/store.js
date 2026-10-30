// Core: state, persistence, variables, tiny DOM + overlay helpers.
(function () {
  'use strict';
  const PW = (window.PW = {});

  PW.COLORS = ['#8b7bff', '#00e0b8', '#ffc857', '#ff6b81', '#5ab0ff', '#ff9f5a', '#c792ff', '#7be495'];
  PW.METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  PW.MAX_SAMPLES = 500;
  PW.uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

  // ---------- tiny event bus ----------
  const handlers = {};
  PW.on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); };
  PW.emit = (ev, ...a) => { (handlers[ev] || []).slice().forEach((fn) => { try { fn(...a); } catch (e) { console.error(ev, e); } }); };
  // Like on(), but tied to a DOM element: ignored until it is attached, dropped once it is detached.
  PW.bind = (ev, el, fn) => {
    let seen = false;
    const wrapper = (...a) => {
      if (el.isConnected) { seen = true; fn(...a); }
      else if (seen) { const l = handlers[ev]; const i = l.indexOf(wrapper); if (i >= 0) l.splice(i, 1); }
    };
    PW.on(ev, wrapper);
  };

  // ---------- DOM helper ----------
  PW.h = function (tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  };
  PW.$ = (sel, root) => (root || document).querySelector(sel);

  // ---------- state ----------
  function sampleState() {
    const gid = PW.uid(), eid = PW.uid();
    const mk = (o) => PW.makeTab(o);
    const t1 = mk({ name: 'Hello GET', groupId: gid, tags: ['demo'], method: 'GET', url: '{{baseUrl}}/get?hello=world' });
    const t2 = mk({
      name: 'Echo JSON', groupId: gid, tags: ['demo', 'json'], method: 'POST', url: '{{baseUrl}}/anything',
      bodyType: 'json', body: '{\n  "id": "{{$uuid}}",\n  "user": { "name": "Ada", "roles": ["admin", "dev"] },\n  "ts": {{$timestamp}}\n}',
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    });
    const t3 = mk({ name: 'Status 503', tags: ['errors'], method: 'GET', url: '{{baseUrl}}/status/503' });
    return {
      v: 1,
      groups: [{ id: gid, name: 'Demo', color: PW.COLORS[0], collapsed: false }],
      tabs: [t1, t2, t3],
      activeTabId: t1.id,
      envs: [
        { id: 'globals', name: 'Globals', vars: [] },
        { id: eid, name: 'Dev', vars: [{ key: 'baseUrl', value: 'https://httpbin.org', secret: false, enabled: true }] },
      ],
      activeEnvId: eid,
      ui: { side: true, theme: 'dark', reqh: 42 },
    };
  }

  PW.makeTab = function (o) {
    return Object.assign({
      id: PW.uid(), name: '', groupId: null, tags: [], method: 'GET', url: '',
      headers: [], bodyType: 'none', body: '',
      auth: { type: 'none', token: '', user: '', pass: '' },
      settings: { timeout: 30000, follow: true, insecure: false },
      captures: [], tests: [], samples: [],
    }, o || {});
  };

  // ---------- persistence ----------
  let saveTimer = null;
  PW.save = function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(PW.saveNow, 350);
  };
  PW.saveNow = function () {
    clearTimeout(saveTimer);
    const body = JSON.stringify(PW.state);
    try { localStorage.setItem('postwoman.state', body); } catch { /* quota or disabled */ }
    // X-PW-Rev tells the server which AI-agent changes this page has already seen, so it can merge newer ones in
    return fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PW-Rev': String(PW.rev || 0), 'X-PW-Boot': PW.boot || '' }, body })
      .catch(() => PW.toast('Could not save to disk (is the server running?)'));
  };
  window.addEventListener('beforeunload', () => {
    try { navigator.sendBeacon && localStorage.setItem('postwoman.state', JSON.stringify(PW.state)); } catch { /* ignore */ }
  });

  PW.normalize = function (s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.tabs)) return null;
    s.groups = Array.isArray(s.groups) ? s.groups : [];
    s.envs = Array.isArray(s.envs) ? s.envs : [];
    if (!s.envs.some((e) => e.id === 'globals')) s.envs.unshift({ id: 'globals', name: 'Globals', vars: [] });
    s.tabs = s.tabs.map((t) => PW.makeTab(t));
    s.ui = Object.assign({ side: true, theme: 'dark', reqh: 42 }, s.ui || {});
    if (!s.tabs.length) s.tabs.push(PW.makeTab({ name: 'New request' }));
    if (!s.tabs.some((t) => t.id === s.activeTabId)) s.activeTabId = s.tabs[0].id;
    if (s.activeEnvId && !s.envs.some((e) => e.id === s.activeEnvId)) s.activeEnvId = null;
    return s;
  };

  PW.load = async function () {
    let s = null;
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      PW.rev = Number(r.headers.get('X-PW-Rev')) || 0;
      PW.boot = r.headers.get('X-PW-Boot') || '';
      const j = await r.json();
      if (j && !j.empty) s = PW.normalize(j);
    } catch { /* server unreachable: fall back */ }
    if (!s) { try { s = PW.normalize(JSON.parse(localStorage.getItem('postwoman.state'))); } catch { /* ignore */ } }
    PW.state = s || sampleState();
    PW.responses = {};
  };

  // ---------- accessors ----------
  PW.tab = (id) => PW.state.tabs.find((t) => t.id === (id || PW.state.activeTabId));
  PW.group = (id) => PW.state.groups.find((g) => g.id === id);
  PW.env = (id) => PW.state.envs.find((e) => e.id === id);
  PW.activeEnv = () => PW.env(PW.state.activeEnvId);
  PW.globals = () => PW.env('globals');

  // ---------- variables ----------
  PW.varMap = function () {
    const m = {};
    const add = (env) => env && env.vars.forEach((v) => { if (v.enabled !== false && v.key) m[v.key] = v.value; });
    add(PW.globals()); add(PW.activeEnv());
    return m;
  };

  PW.DYNAMIC = ReqSpec.DYNAMIC;
  PW.interpolate = ReqSpec.interpolate; // {{name}}; unknown names are collected in `missing` and left untouched

  PW.setVar = function (name, value, envId) {
    const env = PW.env(envId) || PW.activeEnv() || PW.globals();
    let v = env.vars.find((x) => x.key === name);
    if (v) { v.value = value; v.enabled = true; } else env.vars.push({ key: name, value, secret: false, enabled: true });
    PW.save(); PW.emit('env');
    return env;
  };

  // ---------- toast / overlays ----------
  PW.toast = function (msg, actionLabel, action, ms) {
    const box = PW.$('#toasts');
    const t = PW.h('div', { class: 'toast' }, PW.h('span', null, msg));
    if (actionLabel) t.append(PW.h('button', { onclick: () => { t.remove(); action && action(); } }, actionLabel));
    box.append(t);
    setTimeout(() => t.remove(), ms || (actionLabel ? 6500 : 2600));
  };

  PW.closeOverlay = function () { PW.$('#overlay').textContent = ''; document.removeEventListener('keydown', PW._escClose, true); };
  PW._escClose = (e) => { if (e.key === 'Escape') { e.stopPropagation(); PW.closeOverlay(); } };

  // modal({title, body:Node, buttons:[{label, primary, onclick(close)}], wide})
  PW.modal = function (o) {
    PW.closeOverlay();
    const close = PW.closeOverlay;
    const box = PW.h('div', { class: 'modal' + (o.wide ? ' wide' : '') },
      o.title ? PW.h('h2', null, o.title) : null,
      PW.h('div', { class: 'mb' }, o.body),
      o.buttons ? PW.h('div', { class: 'mf' }, o.buttons.map((b) =>
        PW.h('button', { class: 'btn' + (b.primary ? ' primary' : ''), onclick: () => { if (b.onclick) b.onclick(close); else close(); } }, b.label))) : null);
    const scrim = PW.h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) close(); } }, box);
    PW.$('#overlay').append(scrim);
    document.addEventListener('keydown', PW._escClose, true);
    return { box, close };
  };

  // context menu: items = [{label, onclick, danger}|'-'|{custom:Node}]
  PW.ctx = function (x, y, items) {
    PW.closeCtx();
    const m = PW.h('div', { class: 'ctx', id: 'ctxmenu' });
    for (const it of items) {
      if (it === '-') m.append(PW.h('hr'));
      else if (it.custom) m.append(it.custom);
      else m.append(PW.h('div', { class: it.danger ? 'danger' : '', onclick: () => { PW.closeCtx(); it.onclick(); } }, it.label));
    }
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
    setTimeout(() => {
      document.addEventListener('mousedown', PW._ctxAway, true);
      document.addEventListener('keydown', PW._ctxKey, true);
    });
  };
  PW._ctxAway = (e) => { const m = PW.$('#ctxmenu'); if (m && !m.contains(e.target)) PW.closeCtx(); };
  PW._ctxKey = (e) => { if (e.key === 'Escape') PW.closeCtx(); };
  PW.closeCtx = function () {
    const m = PW.$('#ctxmenu'); if (m) m.remove();
    document.removeEventListener('mousedown', PW._ctxAway, true);
    document.removeEventListener('keydown', PW._ctxKey, true);
  };

  PW.prompt = function (title, value, cb, placeholder) {
    const inp = PW.h('input', { class: 'in', value: value || '', placeholder: placeholder || '', style: { fontFamily: 'var(--sans)', fontSize: '14px', padding: '9px 10px' } });
    const go = (close) => { const v = inp.value.trim(); close(); if (v) cb(v); };
    const { close } = PW.modal({ title, body: inp, buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onclick: go }] });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(close); });
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
  };

  // ---------- misc ----------
  PW.fmtMs = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : (n >= 100 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)) + ' ms');
  PW.fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
  PW.tabTitle = (t) => t.name || t.url.replace(/^https?:\/\//, '').replace(/^\{\{[^}]+\}\}/, '') || 'New request';
  PW.download = function (name, text, type) {
    const a = PW.h('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
  PW.copy = function (text, msg) {
    const ok = () => PW.toast(msg || 'Copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => PW.toast('Copy blocked by browser'));
    else { const ta = PW.h('textarea', { value: text }); document.body.append(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch { PW.toast('Copy failed'); } ta.remove(); }
  };
})();
