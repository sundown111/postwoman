'use strict';
// Generated snippets are executed for real (bash+curl, Node fetch, Python requests) and what the upstream received is compared with the spec.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Codegen = require('../public/codegen.js');
const { startUpstream } = require('./helpers');

let up, dir;
const have = (cmd, args) => { try { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0; } catch { return false; } };
const HAS = { curl: have('curl', ['--version']) && have('bash', ['-c', 'true']), js: true, python: have('python3', ['-c', 'import requests']) };

before(async () => { up = await startUpstream(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-codegen-')); });
after(async () => { await up.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const NASTY = '{"name":"O\'Brien \\"Q\\"","path":"C:\\\\temp\\\\new","t":"line1\\nline2\\ttab","raw":"a\nb\r\nc","u":"héllo 😀 \u2018x\u2019","sh":"$HOME `id` $(whoami) ${x} !!","pct":"100%","bs":"\\\\\\\\"}';
const cases = [
  { name: 'GET with query and headers', spec: () => ({ method: 'GET', url: up.url + '/echo?q=a%20b&x=%C3%A9', headers: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Custom', value: 'one' }, { key: 'x-custom', value: 'two' }] }), expectHeader: { 'x-custom': 'two' } },
  { name: 'POST JSON body full of quotes, backslashes, newlines, emoji and shell metacharacters', spec: () => ({ method: 'POST', url: up.url + '/echo', headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Custom', value: `it's "quoted" \\ and $x \`y\`` }], body: NASTY }), expectHeader: { 'content-type': 'application/json', 'x-custom': `it's "quoted" \\ and $x \`y\`` } },
  { name: 'PUT form body', spec: () => ({ method: 'PUT', url: up.url + '/echo', headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }], body: 'a=1&b=%20&c=%26' }), expectHeader: {} },
  { name: 'DELETE without a body', spec: () => ({ method: 'DELETE', url: up.url + '/echo?id=7', headers: [] }), expectHeader: {} },
  { name: 'PATCH with a multi-line text body', spec: () => ({ method: 'PATCH', url: up.url + '/echo', headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: 'line one\nline two\n\n  indented\ttab' }), expectHeader: {} },
];

// Async on purpose: the fixture upstream lives in this process, so a blocking spawnSync would starve it.
function run(lang, code, timeoutMs) {
  const file = path.join(dir, 'snippet-' + Math.random().toString(36).slice(2) + { curl: '.sh', js: '.mjs', python: '.py' }[lang]);
  fs.writeFileSync(file, code);
  const cmd = { curl: ['bash', [file]], js: [process.execPath, [file]], python: ['python3', [file]] }[lang];
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd[1]);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs || 20000);
    child.on('close', (status) => { clearTimeout(kill); resolve({ status, out, err }); });
  });
}

for (const lang of ['curl', 'js', 'python']) {
  for (const c of cases) {
    test(`${lang}: ${c.name} arrives exactly as specified`, { skip: HAS[lang] ? false : lang + ' runtime not available' }, async () => {
      const spec = c.spec();
      const before = up.hits.length;
      const r = await run(lang, Codegen.generate(lang, spec));
      assert.equal(r.status, 0, 'snippet failed:\n' + r.err + '\n' + Codegen.generate(lang, spec));
      assert.equal(up.hits.length, before + 1, 'exactly one request expected');
      const hit = up.hits[before];
      assert.equal(hit.method, spec.method);
      assert.equal(hit.url, new URL(spec.url).pathname + new URL(spec.url).search);
      assert.equal(hit.body.toString('utf8'), spec.body || '', 'body bytes must match');
      for (const [k, v] of Object.entries(c.expectHeader)) assert.equal(hit.headers[k], v, 'header ' + k);
    });
  }

  test(`${lang}: redirects follow by default and stop when followRedirects is false`, { skip: HAS[lang] ? false : lang + ' runtime not available' }, async () => {
    let n = up.hits.length;
    assert.equal((await run(lang, Codegen.generate(lang, { method: 'GET', url: up.url + '/r1', headers: [] }))).status, 0);
    assert.equal(up.hits.length - n, 3, 'followed /r1 -> /r2 -> /echo');
    n = up.hits.length;
    const r = await run(lang, Codegen.generate(lang, { method: 'GET', url: up.url + '/r1', headers: [], followRedirects: false }));
    assert.equal(up.hits.length - n, 1, 'must stop at the 302');
    if (lang !== 'curl') assert.match(r.out, /^302/m, 'prints the 302 status');
  });

  test(`${lang}: timeout is honoured`, { skip: HAS[lang] ? false : lang + ' runtime not available' }, async () => {
    const t0 = Date.now();
    const r = await run(lang, Codegen.generate(lang, { method: 'GET', url: up.url + '/slow?ms=4000', headers: [], timeout: 500 }));
    assert.notEqual(r.status, 0, 'the request should time out');
    assert.ok(Date.now() - t0 < 3500, 'gave up after ' + (Date.now() - t0) + ' ms');
  });
}

test('curl: HEAD uses -I, TLS and redirect flags are emitted only when asked', () => {
  assert.match(Codegen.generate('curl', { method: 'HEAD', url: 'http://x' }), /^curl -I /);
  const c = Codegen.generate('curl', { method: 'GET', url: 'https://x', insecure: true, followRedirects: true, timeout: 2500 });
  assert.match(c, /-L/); assert.match(c, /-k/); assert.match(c, /--max-time 2.5/);
  const n = Codegen.generate('curl', { method: 'GET', url: 'https://x', followRedirects: false });
  assert.ok(!/-L|-k|--max-time/.test(n));
});

test('python: insecure, timeout and non-ASCII bodies are encoded explicitly', () => {
  const p = Codegen.generate('python', { method: 'POST', url: 'https://x', body: 'héllo', insecure: true, timeout: 1500 });
  assert.match(p, /\.encode\("utf-8"\)/); assert.match(p, /verify=False/); assert.match(p, /timeout=1\.5/);
});

test('powershell: quoting (incl. curly quotes), header routing and UTF-8 bodies', () => {
  assert.equal(Codegen.quotePs("it's"), "'it''s'");
  assert.equal(Codegen.quotePs('a\u2019b'), "'a\u2019\u2019b'");
  const code = Codegen.generate('powershell', {
    method: 'POST', url: 'https://x/a?b=1', insecure: true, followRedirects: false, timeout: 4200,
    headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'User-Agent', value: 'me/1' }, { key: 'X-A', value: "it's" }],
    body: '{"n":"é"}',
  });
  assert.match(code, /-ContentType 'application\/json'/); assert.match(code, /-UserAgent 'me\/1'/);
  assert.ok(!/'Content-Type' =/.test(code), 'Content-Type must not be in the hashtable');
  assert.match(code, /'X-A' = 'it''s'/); assert.match(code, /GetBytes\('\{"n":"é"\}'\)/);
  assert.match(code, /-MaximumRedirection 0/); assert.match(code, /-SkipCertificateCheck/); assert.match(code, /-TimeoutSec 4/);
  const plain = Codegen.generate('powershell', { method: 'GET', url: 'https://x' });
  assert.ok(!/-Body|-Headers|\$body/.test(plain));
});

test('javascript: output is valid syntax and unknown languages are rejected', () => {
  const code = Codegen.generate('js', { method: 'POST', url: 'http://x', headers: [{ key: 'A', value: '"q"' }], body: 'x\ny', timeout: 100 });
  new (Object.getPrototypeOf(async function () {}).constructor)(code.replace(/^\/\/.*\n/gm, '')); // compiles as an async function body
  assert.throws(() => Codegen.generate('cobol', { url: 'x' }), /Unknown language/);
});
