// AI agents: live sync of agent changes into this page, activity toasts, and the "Connect AI agents" setup screen.
(function () {
  'use strict';
  const { h } = PW;
  let syncing = false, again = false, es = null, lastToast = 0;
  const activity = [];

  // ---------- live sync ----------
  PW.syncNow = async function () {
    if (syncing) { again = true; return; }
    syncing = true;
    try {
      do {
        again = false;
        let j;
        try { j = await (await fetch('/api/changes?since=' + (PW.rev || 0) + '&boot=' + encodeURIComponent(PW.boot || ''), { cache: 'no-store' })).json(); }
        catch { return; }
        if (!j || !j.ok) return;
        PW.boot = j.boot;
        if (j.items.length) apply(j.items);
        PW.rev = j.rev;
      } while (again);
    } finally { syncing = false; }
  };

  function apply(items) {
    const st = PW.state;
    const activeBefore = st.activeTabId;
    const t = Sync.applyItems(st, items);
    st.tabs = st.tabs.map((x) => (t.whole.has(x.id) ? Object.assign(x, PW.makeTab(Object.assign({}, x))) : x)); // fill defaults in place
    if (!st.tabs.length) st.tabs.push(PW.makeTab({ name: 'New request' }));
    if (!st.tabs.some((x) => x.id === st.activeTabId)) st.activeTabId = st.tabs[0].id;
    if (st.activeEnvId && !st.envs.some((e) => e.id === st.activeEnvId)) st.activeEnvId = null;
    if (!st.envs.some((e) => e.id === 'globals')) st.envs.unshift({ id: 'globals', name: 'Globals', vars: [] });
    try { localStorage.setItem('postwoman.state', JSON.stringify(st)); } catch { /* ignore */ }
    if (t.kinds.has('tab') || t.kinds.has('group')) PW.emit('tabs');
    if (t.kinds.has('env')) { PW.renderEnvSelect(); PW.emit('env'); }
    const a = st.activeTabId;
    if (a !== activeBefore || t.whole.has(a) || t.deleted.has(activeBefore)) PW.renderWork();
    else if (t.fields.has(a)) PW.renderResponse();
  }

  // ---------- server events ----------
  PW.connectAgents = function () {
    if (es || PW.serverStale || typeof EventSource === 'undefined') return;
    es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'hello' || m.type === 'state') { if (m.boot !== PW.boot || m.rev > (PW.rev || 0)) PW.syncNow(); }
      else if (m.type === 'activity') onActivity(m);
      else if (m.type === 'load' && m.origin === 'agent') PW.resumeLoad();
    };
  };

  function onActivity(m) {
    activity.unshift(m); activity.splice(50);
    const btn = PW.$('#btnAI');
    if (btn) { btn.classList.add('live'); clearTimeout(btn._t); btn._t = setTimeout(() => btn.classList.remove('live'), 60000); }
    const list = PW.$('#aiActivity');
    if (list) { list.prepend(actRow(m)); while (list.children.length > 30) list.lastChild.remove(); }
    if (Date.now() - lastToast > 1500 || !m.ok) { lastToast = Date.now(); PW.toast('🤖 ' + m.client + ': ' + m.text, null, null, 3500); }
  }
  const actRow = (m) => h('div', { class: 'ai-act' + (m.ok ? '' : ' bad') }, h('span', { class: 'hint' }, new Date(m.at).toLocaleTimeString()), h('b', null, m.client), h('span', null, m.text), m.ms != null ? h('span', { class: 'hint' }, PW.fmtMs(m.ms)) : null);

  // ---------- setup screen ----------
  const J = (o) => JSON.stringify(o, null, 2);
  const shq = (s) => (/[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s);

  function recipes(info) {
    const node = info.node, script = info.mcpScript, url = info.mcpUrl;
    const env = info.port !== 7777 ? { POSTWOMAN_PORT: String(info.port) } : undefined;
    const stdio = Object.assign({ command: node, args: [script] }, env ? { env } : {});
    const win = /^[A-Za-z]:\\/.test(script);
    const envFlag = env ? ' -e POSTWOMAN_PORT=' + info.port : '';
    return [
      { id: 'claude-code', name: 'Claude Code', steps: [
        ['Run once in a terminal (add --scope user to use it in every project):', 'claude mcp add postwoman' + envFlag + ' -- ' + shq(node) + ' ' + shq(script)],
        ['Or connect over HTTP while Postwoman is running:', 'claude mcp add --transport http postwoman ' + url],
        ['Check it in Claude Code with /mcp, then ask e.g.:', 'Load test my "Orders API" request with 20 users for 30 s and explain the p99'],
      ] },
      { id: 'claude-desktop', name: 'Claude Desktop', steps: [
        ['Settings → Developer → Edit Config (' + (win ? '%APPDATA%\\Claude\\claude_desktop_config.json' : '~/Library/Application Support/Claude/claude_desktop_config.json') + '), add:', J({ mcpServers: { postwoman: stdio } })],
        ['Restart Claude Desktop. Postwoman appears under the tools (🔨) menu.', null],
      ] },
      { id: 'vscode', name: 'GitHub Copilot (VS Code)', steps: [
        ['This project already ships .vscode/mcp.json, so opening the folder in VS Code is enough. For other workspaces add .vscode/mcp.json (or run “MCP: Add Server”):', J({ servers: { postwoman: Object.assign({ type: 'stdio' }, stdio) } })],
        ['Or over HTTP while Postwoman is running:', J({ servers: { postwoman: { type: 'http', url } } })],
        ['Open Copilot Chat in Agent mode and enable the Postwoman tools (🔧).', null],
      ] },
      { id: 'copilot-cli', name: 'GitHub Copilot CLI', steps: [
        ['Add to ~/.copilot/mcp-config.json (or use /mcp add inside copilot):', J({ mcpServers: { postwoman: Object.assign({ type: 'local' }, stdio, { tools: ['*'] }) } })],
      ] },
      { id: 'cursor', name: 'Cursor / Windsurf', steps: [
        ['Cursor: ~/.cursor/mcp.json (or .cursor/mcp.json in a project). Windsurf: ~/.codeium/windsurf/mcp_config.json:', J({ mcpServers: { postwoman: stdio } })],
      ] },
      { id: 'gemini', name: 'Gemini CLI', steps: [
        ['Add to ~/.gemini/settings.json:', J({ mcpServers: { postwoman: stdio } })],
      ] },
      { id: 'codex', name: 'OpenAI Codex CLI', steps: [
        ['Add to ~/.codex/config.toml:', '[mcp_servers.postwoman]\ncommand = ' + JSON.stringify(node) + '\nargs = [' + JSON.stringify(script) + ']' + (env ? '\nenv = { POSTWOMAN_PORT = "' + info.port + '" }' : '')],
      ] },
      { id: 'other', name: 'Other agents / REST', steps: [
        ['Any MCP client: stdio command', shq(node) + ' ' + shq(script)],
        ['…or Streamable HTTP endpoint', url],
        ['No MCP? Every tool is plain HTTP + JSON (OpenAPI at ' + url.replace('/mcp', '/openapi.json') + '):', 'curl -X POST ' + url.replace('/mcp', '/api/tools/list_requests') + ' -H "Content-Type: application/json" -d "{}"'],
        ['Cloud agents (e.g. Copilot coding agent on github.com, ChatGPT) cannot reach this machine; Postwoman only listens on 127.0.0.1.', null],
      ] },
    ];
  }

  PW.openAgents = async function () {
    let info;
    try { info = await (await fetch('/api/agent/info', { cache: 'no-store' })).json(); } catch { info = null; }
    if (!info || !info.ok) { PW.toast('The running Postwoman server has no AI-agent support yet. Restart `node server.js`.', null, null, 6000); return; }
    const list = recipes(info);
    let cur = PW._aiSel && list.some((r) => r.id === PW._aiSel) ? PW._aiSel : 'claude-code';
    const pane = h('div', { class: 'ai-pane' });
    const nav = h('div', { class: 'ai-nav' });
    const draw = () => {
      nav.textContent = ''; pane.textContent = '';
      list.forEach((r) => nav.append(h('button', { class: r.id === cur ? 'on' : '', onclick: () => { cur = PW._aiSel = r.id; draw(); } }, r.name)));
      const r = list.find((x) => x.id === cur);
      r.steps.forEach(([text, code]) => {
        pane.append(h('p', null, text));
        if (code) pane.append(h('div', { class: 'ai-code' }, h('pre', null, code), h('button', { class: 'btn ghost', onclick: () => PW.copy(code, 'Copied') }, 'Copy')));
      });
    };
    draw();
    const clients = info.clients.length
      ? h('div', { class: 'ai-clients' }, info.clients.map((c) => h('span', { class: 'chip s2', title: c.calls + ' tool calls · last seen ' + new Date(c.lastSeen).toLocaleTimeString() }, '● ' + c.name)))
      : h('span', { class: 'hint' }, 'No agent connected in the last hour');
    const acts = h('div', { id: 'aiActivity', class: 'ai-acts' }, (activity.length ? activity : info.activity).slice(0, 30).map(actRow));
    PW.modal({
      title: '🤖 Connect AI agents', wide: true,
      body: h('div', null,
        h('p', { class: 'hint', style: { marginTop: 0 } }, 'Postwoman is an MCP server. Connected agents can list, send, compare and load-test your saved requests, read environments (secrets stay masked), and create or edit requests. Their changes show up here live.'),
        h('div', { class: 'ai-status' }, h('b', null, 'Connected: '), clients),
        h('div', { class: 'ai-wrap' }, nav, pane),
        h('details', { class: 'lt-more' }, h('summary', null, info.tools.length + ' tools'),
          h('div', { class: 'ai-tools' }, info.tools.map((t) => h('div', null, h('code', null, t.name), t.readOnly ? h('span', { class: 'hint' }, ' read-only') : null, h('div', { class: 'hint' }, t.description))))),
        h('details', { class: 'lt-more', open: true }, h('summary', null, 'Recent agent activity'), acts),
        h('p', { class: 'hint' }, '⚠ Agents act with your access: they can reach anything this machine can and load-test it. Approve tool calls you don’t expect.')),
      buttons: [{ label: 'Close', primary: true }],
    });
  };
})();
