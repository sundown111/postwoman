// Tab strip with Chrome-style groups + searchable sidebar with tag filters.
(function () {
  'use strict';
  const { h } = PW;
  PW.filter = { q: '', tags: new Set() };
  const sideClosed = new Set(); // group ids collapsed in the sidebar (UI-only)

  const ABBR = { DELETE: 'DEL', PATCH: 'PATCH', OPTIONS: 'OPT', HEAD: 'HEAD' };

  // ---------- operations ----------
  PW.activate = function (id) {
    const t = PW.tab(id); if (!t) return;
    const g = PW.group(t.groupId);
    if (g && g.collapsed) g.collapsed = false;
    PW.state.activeTabId = id;
    PW.save(); PW.emit('tabs'); PW.emit('active');
  };

  PW.addTab = function (partial, opts) {
    opts = opts || {};
    const t = PW.makeTab(partial);
    const cur = PW.tab();
    if (opts.groupId !== undefined) t.groupId = opts.groupId;
    else if (cur && cur.groupId && !partial) t.groupId = cur.groupId; // new tab inherits group of the current one
    // place right after the current tab (or last tab of target group) for locality
    let idx = PW.state.tabs.length;
    if (t.groupId) {
      const last = PW.state.tabs.map((x, i) => (x.groupId === t.groupId ? i : -1)).filter((i) => i >= 0).pop();
      if (last !== undefined) idx = last + 1;
    }
    PW.state.tabs.splice(idx, 0, t);
    PW.activate(t.id);
    return t;
  };

  PW.duplicateTab = function (id) {
    const src = PW.tab(id); if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = PW.uid(); copy.name = (src.name || PW.tabTitle(src)) + ' copy'; copy.samples = [];
    const i = PW.state.tabs.indexOf(src);
    PW.state.tabs.splice(i + 1, 0, copy);
    PW.activate(copy.id);
  };

  function undoToast(label, restore) {
    PW.toast(label, 'Undo', restore, 7000);
  }

  PW.closeTabs = function (ids, label) {
    const st = PW.state;
    const snap = ids.map((id) => ({ tab: PW.tab(id), index: st.tabs.findIndex((t) => t.id === id) })).filter((s) => s.tab);
    if (!snap.length) return;
    const wasActive = ids.includes(st.activeTabId);
    const firstIdx = Math.min(...snap.map((s) => s.index));
    st.tabs = st.tabs.filter((t) => !ids.includes(t.id));
    if (!st.tabs.length) st.tabs.push(PW.makeTab({ name: '' }));
    if (wasActive) st.activeTabId = (st.tabs[Math.min(firstIdx, st.tabs.length - 1)] || st.tabs[0]).id;
    snap.forEach((s) => delete PW.responses[s.tab.id]);
    PW.save(); PW.emit('tabs'); PW.emit('active');
    undoToast(label || 'Closed ' + (snap.length > 1 ? snap.length + ' tabs' : '“' + PW.tabTitle(snap[0].tab) + '”'), () => {
      snap.sort((a, b) => a.index - b.index).forEach((s) => st.tabs.splice(Math.min(s.index, st.tabs.length), 0, s.tab));
      st.tabs = st.tabs.filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i);
      PW.activate(snap[0].tab.id);
    });
  };

  PW.addGroup = function (name, color) {
    const g = { id: PW.uid(), name: name || 'Group', color: color || PW.COLORS[PW.state.groups.length % PW.COLORS.length], collapsed: false };
    PW.state.groups.push(g);
    return g;
  };

  PW.moveToGroup = function (tabId, groupId) {
    const t = PW.tab(tabId); if (!t) return;
    t.groupId = groupId || null;
    // keep group members contiguous in the underlying order
    if (groupId) {
      const st = PW.state;
      st.tabs = st.tabs.filter((x) => x.id !== t.id);
      const last = st.tabs.map((x, i) => (x.groupId === groupId ? i : -1)).filter((i) => i >= 0).pop();
      st.tabs.splice(last === undefined ? st.tabs.length : last + 1, 0, t);
    }
    PW.save(); PW.emit('tabs');
  };

  PW.newGroupWithTab = function (tabId) {
    PW.prompt('Group name', '', (name) => {
      const g = PW.addGroup(name);
      PW.moveToGroup(tabId, g.id);
    }, 'e.g. Auth, Payments, Smoke tests');
  };

  PW.deleteGroup = function (gid) {
    PW.state.tabs.forEach((t) => { if (t.groupId === gid) t.groupId = null; });
    PW.state.groups = PW.state.groups.filter((g) => g.id !== gid);
    PW.save(); PW.emit('tabs');
  };

  // ---------- context menus ----------
  function tabMenu(e, id) {
    e.preventDefault();
    const t = PW.tab(id);
    const groupItems = PW.state.groups.map((g) => ({
      custom: h('div', { onclick: () => { PW.closeCtx(); PW.moveToGroup(id, g.id); } },
        h('span', { class: 'dot', style: { background: g.color } }), 'Move to ' + g.name),
    }));
    const items = [
      { label: 'Rename…', onclick: () => PW.prompt('Rename request', t.name || PW.tabTitle(t), (v) => { t.name = v; PW.save(); PW.emit('tabs'); PW.emit('name'); }) },
      { label: 'Duplicate', onclick: () => PW.duplicateTab(id) },
      { label: 'Copy as cURL', onclick: () => PW.copyAsCurl(id) },
      { label: 'Copy as code…', onclick: () => PW.showCode(id) },
      '-', ...groupItems,
      { label: '＋ New group with this tab…', onclick: () => PW.newGroupWithTab(id) },
    ];
    if (t.groupId) items.push({ label: 'Remove from group', onclick: () => PW.moveToGroup(id, null) });
    items.push('-', { label: 'Close', onclick: () => PW.closeTabs([id]) },
      { label: 'Close others', danger: true, onclick: () => PW.closeTabs(PW.state.tabs.filter((x) => x.id !== id).map((x) => x.id)) });
    PW.ctx(e.clientX, e.clientY, items);
  }

  function groupMenu(e, gid) {
    e.preventDefault();
    const g = PW.group(gid);
    const sw = h('div', { class: 'swatches' }, PW.COLORS.map((c) =>
      h('i', { style: { background: c }, onclick: () => { g.color = c; PW.save(); PW.emit('tabs'); PW.closeCtx(); } })));
    PW.ctx(e.clientX, e.clientY, [
      { label: 'Rename group…', onclick: () => PW.prompt('Rename group', g.name, (v) => { g.name = v; PW.save(); PW.emit('tabs'); }) },
      { custom: sw },
      { label: '▶ Run group…', onclick: () => PW.runGroup(gid) },
      { label: g.collapsed ? 'Expand' : 'Collapse', onclick: () => { g.collapsed = !g.collapsed; PW.save(); PW.emit('tabs'); } },
      { label: 'New request in group', onclick: () => PW.addTab(null, { groupId: gid }) },
      '-',
      { label: 'Ungroup', onclick: () => PW.deleteGroup(gid) },
      { label: 'Close all tabs in group', danger: true, onclick: () => PW.closeTabs(PW.state.tabs.filter((t) => t.groupId === gid).map((t) => t.id), 'Closed group “' + g.name + '”') },
    ]);
  }
  PW.tabMenu = tabMenu;

  // ---------- strip ----------
  function sequence(tabs) {
    const out = [], seen = new Set();
    for (const t of tabs) {
      const g = t.groupId && PW.group(t.groupId);
      if (!g) { out.push({ tab: t }); continue; }
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ group: g, tabs: tabs.filter((x) => x.groupId === g.id) });
    }
    return out;
  }

  let dragId = null;
  function tabEl(t, color) {
    const active = t.id === PW.state.activeTabId;
    const el = h('div', {
      class: 'tab' + (active ? ' active' : ''), draggable: 'true', 'data-id': t.id, title: (t.method + ' ' + t.url) + (t.tags.length ? '\n#' + t.tags.join(' #') : ''),
      style: color ? { '--gc': color } : null,
      onclick: () => PW.activate(t.id),
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); PW.closeTabs([t.id]); } },
      oncontextmenu: (e) => tabMenu(e, t.id),
      ondragstart: (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); },
      ondragend: () => { dragId = null; PW.$('#strip').querySelectorAll('.dragover').forEach((x) => x.classList.remove('dragover')); },
      ondragover: (e) => { if (dragId && dragId !== t.id) { e.preventDefault(); el.classList.add('dragover'); } },
      ondragleave: () => el.classList.remove('dragover'),
      ondrop: (e) => {
        e.preventDefault(); el.classList.remove('dragover');
        if (!dragId || dragId === t.id) return;
        const st = PW.state, src = PW.tab(dragId);
        st.tabs = st.tabs.filter((x) => x.id !== dragId);
        src.groupId = t.groupId || null;
        st.tabs.splice(st.tabs.findIndex((x) => x.id === t.id), 0, src);
        PW.save(); PW.emit('tabs');
      },
    },
      h('span', { class: 'm m-' + t.method }, ABBR[t.method] || t.method),
      h('span', { class: 't' }, PW.tabTitle(t)),
      t.tags.length ? h('span', { class: 'tdot', style: { background: 'var(--accent)' }, title: '#' + t.tags.join(' #') }) : null,
      h('button', { class: 'x', title: 'Close', onclick: (e) => { e.stopPropagation(); PW.closeTabs([t.id]); } }, '×'));
    return el;
  }

  PW.renderStrip = function () {
    const strip = PW.$('#strip');
    strip.textContent = '';
    for (const item of sequence(PW.state.tabs)) {
      if (item.tab) { strip.append(tabEl(item.tab)); continue; }
      const g = item.group;
      strip.append(h('div', {
        class: 'gpill' + (g.collapsed ? ' collapsed' : ''), style: { background: g.color }, title: 'Click to ' + (g.collapsed ? 'expand' : 'collapse') + ' · right-click for options',
        onclick: () => { g.collapsed = !g.collapsed; PW.save(); PW.emit('tabs'); },
        oncontextmenu: (e) => groupMenu(e, g.id),
        ondragover: (e) => { if (dragId) e.preventDefault(); },
        ondrop: (e) => { e.preventDefault(); if (dragId) { g.collapsed = false; PW.moveToGroup(dragId, g.id); } },
      }, (g.collapsed ? '▸ ' : '▾ ') + g.name, h('span', { class: 'n' }, item.tabs.length)));
      if (!g.collapsed) item.tabs.forEach((t) => strip.append(tabEl(t, g.color)));
    }
    strip.append(h('button', { class: 'newtab', title: 'New request (Alt+T)', onclick: () => PW.addTab() }, '+'));
    // drop on the empty strip tail => ungroup + move to end
    strip.ondragover = (e) => { if (dragId) e.preventDefault(); };
    strip.ondrop = (e) => {
      if (!dragId || e.target !== strip) return;
      const src = PW.tab(dragId); src.groupId = null;
      PW.state.tabs = PW.state.tabs.filter((x) => x.id !== dragId).concat(src);
      PW.save(); PW.emit('tabs');
    };
    const act = strip.querySelector('.tab.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // ---------- sidebar ----------
  function matches(t) {
    const f = PW.filter;
    for (const tag of f.tags) if (!t.tags.includes(tag)) return false;
    const q = f.q.trim().toLowerCase();
    if (!q) return true;
    const g = PW.group(t.groupId);
    const hay = [t.name, t.url, t.method, g ? g.name : '', ...t.tags.map((x) => '#' + x)].join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }

  function item(t) {
    return h('div', {
      class: 'item' + (t.id === PW.state.activeTabId ? ' active' : ''), onclick: () => PW.activate(t.id), oncontextmenu: (e) => tabMenu(e, t.id),
    },
      h('div', { class: 'l1' }, h('b', { class: 'm-' + t.method }, t.method), h('span', null, PW.tabTitle(t))),
      t.name ? h('div', { class: 'l2' }, t.url || ' ') : null,
      t.tags.length ? h('div', { class: 'tags' }, t.tags.map((x) => h('em', null, '#' + x))) : null);
  }

  PW.renderSide = function () {
    const st = PW.state;
    // tag chips
    const counts = {};
    st.tabs.forEach((t) => t.tags.forEach((x) => { counts[x] = (counts[x] || 0) + 1; }));
    for (const k of [...PW.filter.tags]) if (!counts[k]) PW.filter.tags.delete(k);
    const tf = PW.$('#tagFilter'); tf.textContent = '';
    Object.keys(counts).sort().forEach((k) => tf.append(h('button', {
      class: 'tagchip' + (PW.filter.tags.has(k) ? ' on' : ''),
      onclick: () => { PW.filter.tags.has(k) ? PW.filter.tags.delete(k) : PW.filter.tags.add(k); PW.renderSide(); },
    }, '#' + k + ' ' + counts[k])));

    const list = PW.$('#list'); list.textContent = '';
    const filtering = PW.filter.q.trim() || PW.filter.tags.size;
    const buckets = st.groups.map((g) => ({ g, tabs: st.tabs.filter((t) => t.groupId === g.id && matches(t)) }));
    buckets.push({ g: null, tabs: st.tabs.filter((t) => !PW.group(t.groupId) && matches(t)) });
    let shown = 0;
    for (const b of buckets) {
      if (filtering && !b.tabs.length) continue;
      if (!b.g && !b.tabs.length) continue;
      const id = b.g ? b.g.id : '_';
      const closed = !filtering && sideClosed.has(id);
      list.append(h('div', {
        class: 'ghead',
        onclick: () => { closed ? sideClosed.delete(id) : sideClosed.add(id); PW.renderSide(); },
        oncontextmenu: b.g ? (e) => groupMenu(e, b.g.id) : null,
      }, h('span', { class: 'dot', style: { background: b.g ? b.g.color : 'var(--faint)' } }), (closed ? '▸ ' : '▾ ') + (b.g ? b.g.name : 'Ungrouped'),
        h('span', { class: 'c' }, b.tabs.length),
        b.g ? h('button', { class: 'btn ghost run-group', style: { padding: '0 6px' }, title: 'Run every request in this group, in order', onclick: (e) => { e.stopPropagation(); PW.runGroup(b.g.id); } }, '▶') : null,
        b.g ? h('button', { class: 'btn ghost', style: { padding: '0 6px' }, title: 'New request in this group', onclick: (e) => { e.stopPropagation(); PW.addTab(null, { groupId: b.g.id }); } }, '+') : null));
      if (!closed) b.tabs.forEach((t) => { list.append(item(t)); shown++; });
    }
    if (!shown && filtering) list.append(h('div', { class: 'empty' }, 'No requests match.', h('br'), 'Try #tag, a group name or part of the URL.'));
  };

  PW.on('tabs', () => { PW.renderStrip(); PW.renderSide(); });
})();
