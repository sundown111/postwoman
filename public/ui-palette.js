// Ctrl+K command palette: jump to any request (name / url / #tag / group) or run an action.
(function () {
  'use strict';
  const { h } = PW;

  function items() {
    const out = [];
    PW.state.tabs.forEach((t) => {
      const g = PW.group(t.groupId);
      out.push({
        kind: 'tab', hay: [t.name, t.url, t.method, g ? g.name : '', ...t.tags.map((x) => '#' + x)].join(' ').toLowerCase(),
        label: PW.tabTitle(t), method: t.method, sub: (g ? g.name + ' · ' : '') + t.url, color: g && g.color, run: () => PW.activate(t.id),
      });
    });
    const act = (label, run, extra) => out.push({ kind: 'act', hay: ('action ' + label + ' ' + (extra || '')).toLowerCase(), label, run });
    act('New request', () => PW.addTab());
    act('New group…', () => { const t = PW.addTab(); PW.newGroupWithTab(t.id); }, 'group tab');
    act('Import cURL…', () => PW.importCurlModal(), 'paste curl');
    act('Copy current request as cURL', () => PW.copyAsCurl(PW.state.activeTabId));
    act('Copy current request as code… (JavaScript, Python, PowerShell)', () => PW.showCode(PW.state.activeTabId), 'snippet fetch requests curl');
    PW.state.groups.forEach((g) => act('Run group → ' + g.name, () => PW.runGroup(g.id), 'collection runner tests'));
    act('Keyboard shortcuts', () => PW.shortcutsModal(), 'help keys hotkeys');
    act('Compare current request across environments', () => PW.compare(PW.state.activeTabId), 'compare envs diff performance');
    act('Load test current request…', () => PW.showResponseTab(PW.state.activeTabId, 'load'), 'load performance jmeter users stress p99');
    act('Edit environments & variables', () => PW.openEnv(), 'env variables');
    PW.state.envs.filter((e) => e.id !== 'globals').forEach((e) => act('Switch environment → ' + e.name, () => { PW.state.activeEnvId = e.id; PW.save(); PW.emit('env'); PW.toast('Environment: ' + e.name); }, 'env'));
    act('Switch environment → none', () => { PW.state.activeEnvId = null; PW.save(); PW.emit('env'); }, 'env');
    act('Close current tab', () => PW.closeTabs([PW.state.activeTabId]));
    act('Toggle light / dark theme', () => PW.toggleTheme());
    act('Export / import data…', () => PW.dataModal());
    return out;
  }

  PW.openPalette = function () {
    const all = items();
    let results = [], sel = 0;
    const input = h('input', { class: 'pal-in', placeholder: 'Jump to a request, #tag, group… or type an action', spellcheck: 'false', autocomplete: 'off' });
    const list = h('div', { class: 'pal-list' });
    const draw = () => {
      const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      results = all.filter((it) => words.every((w) => it.hay.includes(w)));
      // requests first, actions after; when nothing typed show requests then a few actions
      results = results.filter((r) => r.kind === 'tab').concat(results.filter((r) => r.kind === 'act')).slice(0, 40);
      sel = Math.min(sel, Math.max(0, results.length - 1));
      list.textContent = '';
      if (!results.length) list.append(h('div', { class: 'empty' }, 'Nothing found'));
      results.forEach((r, i) => list.append(h('div', { class: 'pal-item' + (i === sel ? ' sel' : ''), onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => pick(i) },
        r.kind === 'tab' ? h('b', { class: 'm m-' + r.method }, r.method) : h('b', { class: 'm' }, '⌘'),
        r.color ? h('span', { class: 'dot', style: { background: r.color } }) : null, r.label, r.sub ? h('small', null, r.sub) : null)));
      const s = list.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
    };
    const pick = (i) => { const r = results[i]; if (!r) return; PW.closeOverlay(); r.run(); };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    });
    const box = h('div', { class: 'modal' }, input, list);
    PW.closeOverlay();
    const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) PW.closeOverlay(); } }, box);
    PW.$('#overlay').append(scrim);
    document.addEventListener('keydown', PW._escClose, true);
    draw(); input.focus();
  };
})();
