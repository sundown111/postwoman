// Environments: quick switcher in the top bar + a fast editor (table or paste-a-.env bulk mode).
(function () {
  'use strict';
  const { h } = PW;

  PW.renderEnvSelect = function () {
    const sel = PW.$('#envSelect');
    sel.textContent = '';
    sel.append(h('option', { value: '' }, 'No environment'));
    PW.state.envs.filter((e) => e.id !== 'globals').forEach((e) => sel.append(h('option', { value: e.id, selected: e.id === PW.state.activeEnvId }, e.name)));
    sel.value = PW.state.activeEnvId || '';
    PW.$('#envDot').style.background = PW.state.activeEnvId ? 'var(--ok)' : 'var(--faint)';
    const n = Object.keys(PW.varMap()).length;
    PW.$('#btnEnv').textContent = '{{' + n + '}}';
    PW.$('#btnEnv').title = n + ' variable' + (n === 1 ? '' : 's') + ' available — click to edit environments';
  };

  // KEY=value lines  <->  var array
  function toBulk(vars) {
    return vars.map((v) => (v.enabled === false ? '# ' : '') + v.key + '=' + v.value).join('\n');
  }
  function fromBulk(text, old) {
    const prev = new Map(old.map((v) => [v.key, v]));
    const out = [];
    text.split(/\r?\n/).forEach((line) => {
      let l = line.trim(); if (!l) return;
      let enabled = true;
      if (l.startsWith('#')) { // "# key=value" = disabled var; other comments are ignored
        const m = /^#\s*([A-Za-z_][\w.\-]*)\s*=(.*)$/.exec(l);
        if (!m) return; l = m[1] + '=' + m[2]; enabled = false;
      }
      l = l.replace(/^export\s+/, '');
      const i = l.indexOf('='); if (i < 1) return;
      const key = l.slice(0, i).trim();
      let value = l.slice(i + 1).trim();
      if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
      out.push({ key, value, enabled, secret: prev.get(key) ? !!prev.get(key).secret : false });
    });
    return out;
  }
  PW._toBulk = toBulk; PW._fromBulk = fromBulk;

  PW.openEnv = function (focusId) {
    const st = PW.state;
    let selId = focusId || st.activeEnvId || (st.envs.find((e) => e.id !== 'globals') || st.envs[0]).id;
    let bulk = false;
    const listBox = h('div', { class: 'envlist' });
    const edit = h('div', { style: { minWidth: 0 } });

    const finish = () => { PW.save(); PW.emit('env'); PW.renderEnvSelect(); };

    const drawList = () => {
      listBox.textContent = '';
      st.envs.forEach((e) => listBox.append(h('div', { class: 'it' + (e.id === selId ? ' on' : ''), onclick: () => { selId = e.id; bulk = false; draw(); } },
        e.id === 'globals' ? '🌐 ' : '', e.name, h('span', { class: 'hint' }, ' ' + e.vars.length), e.id === st.activeEnvId ? h('span', { class: 'act' }, 'ACTIVE') : null)));
      listBox.append(h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => PW.prompt('New environment', '', (name) => {
        const e = { id: PW.uid(), name, vars: [] }; st.envs.push(e); selId = e.id; st.activeEnvId = e.id; finish(); draw();
      }, 'e.g. Staging, Prod, Local') }, '＋ New environment'));
    };

    const row = (env, v, ghost, tbody) => {
      const tr = h('tr');
      const key = h('input', { class: 'in', value: v.key, placeholder: 'variable', spellcheck: 'false', autocomplete: 'off' });
      const val = h('input', { class: 'in', type: v.secret ? 'password' : 'text', value: v.value, placeholder: 'value', spellcheck: 'false', autocomplete: 'off' });
      const chk = h('input', { type: 'checkbox', checked: v.enabled !== false, onchange: () => { v.enabled = chk.checked; finish(); } });
      const sec = h('button', { class: 'secretbtn' + (v.secret ? ' on' : ''), title: 'Mask value (UI only)', onclick: () => { v.secret = !v.secret; val.type = v.secret ? 'password' : 'text'; sec.classList.toggle('on', v.secret); finish(); } }, '🔒');
      const rm = h('button', { class: 'rm', onclick: () => { const i = env.vars.indexOf(v); if (i >= 0) env.vars.splice(i, 1); tr.remove(); finish(); drawList(); } }, '×');
      const touch = () => { v.key = key.value.trim(); v.value = val.value; if (ghost.v) { ghost.v = false; env.vars.push(v); addGhost(env, tbody); drawList(); } finish(); };
      key.addEventListener('input', touch); val.addEventListener('input', touch);
      tr.append(h('td', { style: { width: '24px' } }, chk), h('td', { style: { width: '38%' } }, key), h('td', null, val), h('td', { style: { width: '26px' } }, sec), h('td', { style: { width: '26px' } }, rm));
      return tr;
    };
    const addGhost = (env, tbody) => tbody.append(row(env, { key: '', value: '', secret: false, enabled: true }, { v: true }, tbody));

    const draw = () => {
      drawList();
      const env = PW.env(selId);
      edit.textContent = '';
      const head = h('div', { class: 'form-row', style: { marginBottom: '8px' } },
        h('b', { style: { fontSize: '14px' } }, env.name),
        env.id !== 'globals' && env.id !== st.activeEnvId ? h('button', { class: 'btn', onclick: () => { st.activeEnvId = env.id; finish(); draw(); } }, 'Set active') : null,
        h('span', { class: 'spacer' }),
        h('div', { class: 'seg' }, [[false, 'Table'], [true, 'Bulk / .env']].map(([v, l]) => h('button', { class: bulk === v ? 'on' : '', onclick: () => { bulk = v; draw(); } }, l))),
        env.id !== 'globals' ? h('button', { class: 'btn ghost', onclick: () => PW.prompt('Rename environment', env.name, (n) => { env.name = n; finish(); draw(); }) }, 'Rename') : null,
        env.id !== 'globals' ? h('button', { class: 'btn ghost', onclick: () => { const c = JSON.parse(JSON.stringify(env)); c.id = PW.uid(); c.name += ' copy'; st.envs.push(c); selId = c.id; finish(); draw(); } }, 'Duplicate') : null,
        env.id !== 'globals' ? h('button', { class: 'btn ghost danger', onclick: () => {
          const idx = st.envs.indexOf(env); st.envs.splice(idx, 1);
          if (st.activeEnvId === env.id) st.activeEnvId = null;
          selId = (st.envs.find((e) => e.id !== 'globals') || st.envs[0]).id; finish(); draw();
          PW.toast('Deleted “' + env.name + '”', 'Undo', () => { st.envs.splice(idx, 0, env); finish(); PW.openEnv(env.id); });
        } }, 'Delete') : null);
      edit.append(head);

      if (bulk) {
        const ta = h('textarea', { class: 'in', style: { height: '260px', resize: 'vertical', whiteSpace: 'pre' }, spellcheck: 'false', placeholder: 'baseUrl=https://api.example.com\ntoken=abc123\n# disabled=this line is off' });
        ta.value = toBulk(env.vars);
        ta.addEventListener('input', () => { env.vars = fromBulk(ta.value, env.vars); finish(); });
        ta.addEventListener('blur', () => drawList());
        edit.append(ta, h('p', { class: 'hint' }, 'Paste a .env file or one KEY=value per line. Lines starting with “# key=value” are disabled variables.'));
      } else {
        const tbody = h('tbody');
        env.vars.forEach((v) => tbody.append(row(env, v, { v: false }, tbody)));
        addGhost(env, tbody);
        edit.append(h('table', { class: 'kv' }, tbody));
        edit.append(h('p', { class: 'hint' }, env.id === 'globals' ? 'Globals apply everywhere; the active environment overrides them.' : 'Reference as {{name}} in URLs, headers, body and auth. Built-ins: ' + PW.DYNAMIC.map((d) => '{{' + d + '}}').join(' ')));
      }
    };

    const { close } = PW.modal({ title: 'Environments & variables', wide: true, body: h('div', { class: 'envgrid' }, listBox, edit), buttons: [{ label: 'Done', primary: true, onclick: (c) => { finish(); c(); } }] });
    draw();
    return close;
  };

  PW.on('env', PW.renderEnvSelect);
})();
