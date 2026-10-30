// "Copy as code": turns a resolved request spec (see reqspec.js buildSpec) into runnable snippets.
// Pure functions (browser + Node). spec = { method, url, headers:[{key,value}], body, followRedirects, insecure, timeout(ms) }
(function (root) {
  'use strict';

  // JSON.stringify output is a valid string literal in JavaScript and in Python 3.
  const q = (s) => JSON.stringify(String(s));
  const CurlLib = typeof module !== 'undefined' && module.exports ? require('./curl.js') : root.Curl;

  // Same rule the server applies when sending: header names are case-insensitive and the last one wins.
  function dedupe(headers) {
    const m = new Map();
    for (const h of headers || []) if (h && h.key) m.set(String(h.key).toLowerCase(), { key: String(h.key), value: String(h.value == null ? '' : h.value) });
    return [...m.values()];
  }
  const hasBody = (s) => s.body != null && s.body !== '';
  const follow = (s) => s.followRedirects !== false;
  const secs = (ms) => +(ms / 1000).toFixed(3);

  function curl(s) {
    let out = CurlLib.toCurl({ method: s.method, url: s.url, headers: dedupe(s.headers), body: hasBody(s) ? s.body : '' });
    const extra = [];
    if (follow(s)) extra.push('-L');
    if (s.insecure) extra.push('-k');
    if (s.timeout) extra.push('--max-time ' + secs(s.timeout));
    if (extra.length) out += ' \\\n  ' + extra.join(' ');
    return out;
  }

  function js(s) {
    const hd = dedupe(s.headers);
    const o = ['  method: ' + q(s.method) + ','];
    if (hd.length) o.push('  headers: {', ...hd.map((h) => '    ' + q(h.key) + ': ' + q(h.value) + ','), '  },');
    if (hasBody(s)) o.push('  body: ' + q(s.body) + ',');
    if (!follow(s)) o.push("  redirect: 'manual',");
    if (s.timeout) o.push('  signal: AbortSignal.timeout(' + Math.round(s.timeout) + '),');
    const lines = ['// Node 18+ or a browser console (top-level await: save as .mjs when using Node)'];
    if (s.insecure) lines.push('// fetch cannot skip TLS verification; for local testing only, run Node with NODE_TLS_REJECT_UNAUTHORIZED=0');
    lines.push('const response = await fetch(' + q(s.url) + ', {', ...o, '});', 'console.log(response.status);', 'console.log(await response.text());');
    return lines.join('\n');
  }

  function python(s) {
    const hd = dedupe(s.headers);
    const a = ['    ' + q(s.method) + ',', '    ' + q(s.url) + ','];
    if (hd.length) a.push('    headers={', ...hd.map((h) => '        ' + q(h.key) + ': ' + q(h.value) + ','), '    },');
    if (hasBody(s)) a.push('    data=' + q(s.body) + '.encode("utf-8"),');
    a.push('    allow_redirects=' + (follow(s) ? 'True' : 'False') + ',');
    if (s.insecure) a.push('    verify=False,  # skips TLS certificate checks: local testing only');
    if (s.timeout) a.push('    timeout=' + secs(s.timeout) + ',');
    return ['import requests', '', 'response = requests.request(', ...a, ')', 'print(response.status_code)', 'print(response.text)'].join('\n');
  }

  // PowerShell single-quoted strings: double every single quote, including the curly ones PowerShell also treats as quotes.
  const ps = (v) => "'" + String(v).replace(/['‘’‚‛]/g, (c) => c + c) + "'";

  function powershell(s) {
    let hd = dedupe(s.headers);
    // Windows PowerShell 5.1 only accepts these through dedicated parameters.
    const take = (name) => { const h = hd.find((x) => x.key.toLowerCase() === name); if (h) hd = hd.filter((x) => x !== h); return h; };
    const ct = take('content-type'), ua = take('user-agent');
    const lines = [];
    if (hd.length) lines.push('$headers = @{', ...hd.map((h) => '  ' + ps(h.key) + ' = ' + ps(h.value)), '}', '');
    let bodyExpr = null;
    if (hasBody(s)) bodyExpr = /[^\x00-\x7f]/.test(s.body) ? '[System.Text.Encoding]::UTF8.GetBytes(' + ps(s.body) + ')' : ps(s.body);
    if (bodyExpr) lines.push('$body = ' + bodyExpr, '');
    const p = ['-Uri ' + ps(s.url), '-Method ' + s.method];
    if (hd.length) p.push('-Headers $headers');
    if (ct) p.push('-ContentType ' + ps(ct.value));
    if (ua) p.push('-UserAgent ' + ps(ua.value));
    if (bodyExpr) p.push('-Body $body');
    if (!follow(s)) p.push('-MaximumRedirection 0');
    if (s.timeout) p.push('-TimeoutSec ' + Math.max(1, Math.round(s.timeout / 1000)));
    if (s.insecure) p.push('-SkipCertificateCheck');
    const notes = [];
    if (s.insecure) notes.push('# -SkipCertificateCheck needs PowerShell 7+');
    if (!follow(s)) notes.push('# With redirects off, PowerShell throws on a 3xx reply; catch it to read the status');
    return [...notes, ...lines, '$response = Invoke-WebRequest ' + p.join(' `\n  '), '$response.StatusCode', '$response.Content'].join('\n');
  }

  const LANGS = [
    { id: 'curl', label: 'cURL', note: 'bash / zsh / Git Bash quoting. On Windows use the PowerShell tab.', gen: curl },
    { id: 'js', label: 'JavaScript', note: 'fetch (Node 18+ or browser)', gen: js },
    { id: 'python', label: 'Python', note: 'requests (pip install requests)', gen: python },
    { id: 'powershell', label: 'PowerShell', note: 'Invoke-WebRequest (Windows PowerShell 5.1 or 7+)', gen: powershell },
  ];

  function generate(id, spec) {
    const l = LANGS.find((x) => x.id === id);
    if (!l) throw new Error('Unknown language: ' + id);
    return l.gen(Object.assign({ method: 'GET', headers: [] }, spec, { method: String(spec.method || 'GET').toUpperCase() }));
  }

  const api = { LANGS, generate, dedupe, quotePs: ps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Codegen = api;
})(typeof window !== 'undefined' ? window : globalThis);
