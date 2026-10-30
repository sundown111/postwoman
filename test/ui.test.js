'use strict';
// Browser tests (optional). Needs Playwright:  npm i -D playwright && npx playwright install chromium   then:  npm run test:ui
// Skipped automatically when Playwright (or its browser) is not installed.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { startApp, startUpstream } = require('./helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }

let app, up, browser, page, ctx;
const errors = [];
const skip = chromium ? false : 'Playwright is not installed (npm i -D playwright)';

const mk = (o) => Object.assign({
  id: '', name: '', groupId: null, tags: [], method: 'GET', url: '', headers: [], bodyType: 'none', body: '',
  auth: { type: 'none', token: '', user: '', pass: '' }, settings: { timeout: 60000, follow: true, insecure: false }, captures: [], tests: [], samples: [],
}, o);

before(async () => {
  if (!chromium) return;
  up = await startUpstream();
  const v = (key, value) => ({ key, value, secret: false, enabled: true });
  app = await startApp({
    state: {
      v: 1, groups: [{ id: 'g_flow', name: 'Flow', color: '#7c5cff', collapsed: false }], activeTabId: 't_echo', activeEnvId: 'eA',
      envs: [
        { id: 'globals', name: 'Globals', vars: [] },
        { id: 'eA', name: 'Alpha', vars: [v('baseUrl', up.url), v('version', '1')] },
        { id: 'eB', name: 'Beta', vars: [v('baseUrl', up.url), v('version', '2')] },
      ],
      tabs: [
        mk({ id: 't_echo', name: 'Echo', url: '{{baseUrl}}/echo?v={{version}}&k=same', tags: ['smoke'] }),
        mk({ id: 't_big', name: 'Big', url: up.url + '/big?mb=20' }),
        mk({ id: 'f_login', name: 'Login', groupId: 'g_flow', method: 'POST', url: up.url + '/token?n=1', captures: [{ key: 'tok', value: 'data.access_token' }], tests: [{ id: 'a1', enabled: true, type: 'status', op: 'is', target: '', value: '2xx' }, { id: 'a2', enabled: true, type: 'json', op: 'equals', target: 'data.user.id', value: '7' }] }),
        mk({ id: 'f_need', name: 'Needs token', groupId: 'g_flow', url: up.url + '/needs-token', headers: [{ key: 'Authorization', value: 'Bearer {{tok}}', enabled: true }], tests: [{ id: 'b1', enabled: true, type: 'json', op: 'equals', target: 'ok', value: 'true' }] }),
        mk({ id: 'f_pot', name: 'Teapot', groupId: 'g_flow', url: up.url + '/status?c=418', tests: [{ id: 'c1', enabled: true, type: 'status', op: 'is', target: '', value: '418' }] }),
        mk({ id: 'f_bad', name: 'Broken', groupId: 'g_flow', url: up.url + '/status?c=500', tests: [{ id: 'd1', enabled: true, type: 'status', op: 'is', target: '', value: '2xx' }] }),
        mk({ id: 'f_plain', name: 'No tests', groupId: 'g_flow', url: up.url + '/echo' }),
      ],
    },
  });
  try { browser = await chromium.launch(); } catch (e) { browser = null; return; }
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(app.base);
  await page.waitForSelector('#strip .tab');
});
after(async () => {
  if (browser) await browser.close();
  if (app) await app.stop();
  if (up) await up.close();
});
const need = (t) => { if (!browser) { t.skip('no browser available'); return false; } return true; };
const activate = async (id) => { await page.evaluate((i) => PW.activate(i), id); await page.waitForTimeout(150); };

test('the app boots and renders the saved tabs', { skip }, async (t) => {
  if (!need(t)) return;
  assert.equal(await page.locator('#strip .tab').count(), 7);
  assert.ok(await page.locator('#sendBtn').isVisible());
  assert.ok(await page.locator('#compareBtn').isVisible() && await page.locator('#loadBtn').isVisible() && await page.locator('#btnAI').isVisible());
});

test('pasting a curl command anywhere opens it as a new request', { skip }, async (t) => {
  if (!need(t)) return;
  const before = await page.evaluate(() => PW.state.tabs.length);
  await page.locator('.logo').click();
  await page.evaluate((u) => { const dt = new DataTransfer(); dt.setData('text/plain', `curl -X PUT '${u}/echo?anywhere=1' -H 'X-Hi: 1' -d 'a=b'`); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, up.url);
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({ n: PW.state.tabs.length, m: PW.tab().method, u: PW.tab().url, h: PW.tab().headers.map((x) => x.key) }));
  assert.equal(r.n, before + 1); assert.equal(r.m, 'PUT'); assert.match(r.u, /anywhere=1/); assert.ok(r.h.includes('X-Hi'));
  await page.evaluate(() => PW.closeTabs([PW.state.activeTabId])); await page.waitForTimeout(150);
  await activate('t_echo');
});

test('Send shows status, timing and a JSON tree that can be searched', { skip }, async (t) => {
  if (!need(t)) return;
  await page.locator('#sendBtn').click();
  await page.waitForSelector('.treebar', { timeout: 10000 });
  assert.match(await page.locator('#respane').innerText(), /200/);
  await page.locator('.treebar .search').fill('same');
  await page.waitForFunction(() => /\d+ match/.test(document.querySelector('.treebar').innerText), null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => PW.tab().samples.length), 1, 'the send was recorded for latency stats');
});

test('Compare: unchecking an environment sticks, and the diff finds the changed field', { skip }, async (t) => {
  if (!need(t)) return;
  await activate('t_echo');
  await page.locator('#compareBtn').click();
  await page.waitForSelector('table.cmp tbody tr', { timeout: 15000 });
  assert.match(await page.locator('.cmp-card').first().innerText(), /\$\.url|url/, 'v=1 vs v=2 shows up in the url field');
  // regression: the checkbox used to snap back because the handler mutated a throw-away copy of the config
  await page.locator('.cmp-env', { hasText: 'Beta' }).locator('input').uncheck();
  const kept = await page.evaluate(() => PW.tab().compare.envs.length);
  assert.equal(kept, 1, 'only Alpha should remain selected');
  assert.equal(await page.locator('.cmp-env', { hasText: 'Beta' }).locator('input').isChecked(), false);
  await page.locator('.cmp-env', { hasText: 'Beta' }).locator('input').check();
  assert.equal(await page.evaluate(() => PW.tab().compare.envs.length), 2);
  // rounds + ignore fields
  await page.locator('.benchbar input[type=number]').first().fill('3');
  await page.locator('.benchbar input[type=number]').first().dispatchEvent('change');
  await page.locator('.benchbar .btn.primary:has-text("Compare")').click();
  await page.waitForFunction(() => { const r = PW.compares[PW.state.activeTabId]; return r && !PW.running[PW.state.activeTabId] && r.envs && r.envs.every((e) => e.samples.length === 3); }, null, { timeout: 15000 });
  await page.locator('.cmp-ignore').fill('url');
  await page.locator('.cmp-ignore').dispatchEvent('input');
  await page.waitForFunction(() => /Same data|Identical/.test(document.querySelector('.cmp-card').innerText), null, { timeout: 4000 });
  assert.equal(await page.evaluate(() => PW.tab().samples.length), 1, 'compare runs must not add latency samples');
});

test('a 20 MB response: Tree stays quick, Pretty/Raw are sliced instead of freezing the page', { skip }, async (t) => {
  if (!need(t)) return;
  await activate('t_big');
  let t0 = Date.now();
  await page.locator('#sendBtn').click();
  await page.waitForSelector('.treebar', { timeout: 60000 });
  assert.ok(Date.now() - t0 < 15000, 'tree view took ' + (Date.now() - t0) + ' ms');
  const seg = (label) => page.locator('.treebar .seg button', { hasText: new RegExp('^' + label + '$') });
  t0 = Date.now();
  await seg('Pretty').click();
  await page.waitForSelector('pre.code', { timeout: 30000 });
  assert.ok(Date.now() - t0 < 10000, 'Pretty took ' + (Date.now() - t0) + ' ms (it used to take ~50 s)');
  const shown = await page.evaluate(() => document.querySelector('pre.code').textContent.length);
  assert.ok(shown < 2.6e6, 'only a slice is in the DOM, got ' + shown);
  const more = page.locator('button', { hasText: /^Show next/ });
  assert.equal(await more.count(), 1);
  await more.click();
  assert.ok(await page.evaluate(() => document.querySelector('pre.code').textContent.length) > shown, 'next slice appended');
  await seg('Raw').click();
  await page.waitForSelector('pre.code');
  await seg('Tree').click();
  await page.waitForSelector('.jt, .tree, .treebar .search');
  await activate('t_echo');
});

test('Load test from the UI: loop mode with SLA ends in a PASS report with 30 samples', { skip }, async (t) => {
  if (!need(t)) return;
  await activate('t_echo');
  await page.locator('#loadBtn').click();
  await page.waitForSelector('.lt-form');
  const field = (label) => page.locator('.lt-f', { hasText: label }).locator('input').first();
  await field('Users (threads)').fill('3'); await field('Users (threads)').dispatchEvent('change');
  await page.locator('.seg button', { hasText: 'Loop count' }).click();
  await field('Iterations per user').fill('10'); await field('Iterations per user').dispatchEvent('change');
  await page.locator('.lt-more summary', { hasText: 'Assertions' }).click();
  await field('p95 ≤').fill('5000'); await field('p95 ≤').dispatchEvent('change');
  await page.locator('button', { hasText: 'Start load test' }).first().click();
  await page.waitForSelector('.lt-verdict', { timeout: 30000 });
  assert.match(await page.locator('.lt-verdict').first().innerText(), /PASS/i);
  assert.match(await page.locator('#respane .cards').first().innerText(), /30/);
});

test('an agent-created request appears in the open page without a reload', { skip }, async (t) => {
  if (!need(t)) return;
  const n = await page.evaluate(() => PW.state.tabs.length);
  const r = await app.tool('create_request', { name: 'From the agent', url: up.url + '/echo?agent=1' }); assert.equal(r.ok, true);
  await page.waitForFunction((k) => PW.state.tabs.length > k, n, { timeout: 8000 });
  await page.waitForSelector('#list .item:has-text("From the agent")', { timeout: 4000 });
});

test('Tests tab: add checks, see pass/fail after Send, and a wrong expectation is reported', { skip }, async (t) => {
  if (!need(t)) return;
  await activate('t_echo');
  await page.locator('.pane .tabs button', { hasText: /^Tests/ }).click();
  await page.locator('button', { hasText: '＋ Status' }).click();
  await page.locator('button', { hasText: '＋ JSON path' }).click();
  const rows = page.locator('.test-row');
  assert.equal(await rows.count(), 2);
  await rows.nth(1).locator('input.in').first().fill('method');
  await rows.nth(1).locator('select.in').nth(1).selectOption('equals');
  await rows.nth(1).locator('input.in').nth(1).fill('GET');
  assert.equal(await page.evaluate(() => PW.tab().tests.length), 2, 'tests are stored on the request');
  await page.locator('#sendBtn').click();
  await page.waitForSelector('.testchip');
  assert.match(await page.locator('.testchip').innerText(), /2 tests passed/);
  await page.locator('.testchip').click();
  assert.equal(await page.locator('.test-res.ok').count(), 2);
  await rows.nth(1).locator('input.in').nth(1).fill('POST'); // wrong on purpose
  await page.locator('#sendBtn').click();
  await page.waitForFunction(() => /1 of 2 tests failed/.test((document.querySelector('.testchip') || {}).innerText || ''), null, { timeout: 8000 });
  await page.locator('.testchip').click();
  assert.match(await page.locator('.test-res.bad').innerText(), /JSON method equals POST[\s\S]*got "GET"/);
  await page.evaluate(() => { PW.tab().tests = []; PW.save(); });
});

test('Group runner: runs in order, captures chain, failures are flagged, stop-at-first-failure skips the rest', { skip }, async (t) => {
  if (!need(t)) return;
  await activate('t_echo');
  await page.evaluate(() => { PW.setVar('tok', ''); });
  await page.locator('.ghead', { hasText: 'Flow' }).locator('.run-group').click();
  await page.waitForSelector('.modal table.rn');
  assert.equal(await page.locator('table.rn tbody tr').count(), 5);
  assert.equal(await page.evaluate(() => PW.responses.f_login || null), null, 'nothing is sent until Run is pressed');
  await page.locator('#rn-run').click();
  await page.waitForFunction(() => /Run again/.test(document.querySelector('#rn-run').innerText), null, { timeout: 30000 });
  const verdicts = await page.locator('table.rn tbody tr').evaluateAll((trs) => trs.map((tr) => [tr.children[1].childNodes[1].textContent, tr.children[5].innerText]));
  assert.deepEqual(verdicts, [['Login', '✓ pass'], ['Needs token', '✓ pass'], ['Teapot', '✓ pass'], ['Broken', '✗ fail'], ['No tests', '✓ pass']]);
  assert.match(await page.locator('.rn-summary').innerText(), /4 passed · 1 failed/);
  assert.match(await page.locator('table.rn tbody tr.rn-fail').innerText(), /Status is 2xx \(got 500\)/);
  // stop at first failure: 'No tests' (after 'Broken') is skipped
  await page.locator('#rn-stop').check();
  await page.locator('#rn-run').click();
  await page.waitForFunction(() => /Run again/.test(document.querySelector('#rn-run').innerText), null, { timeout: 30000 });
  assert.match(await page.locator('.rn-summary').innerText(), /3 passed · 1 failed · 1 skipped/);
  assert.match(await page.locator('table.rn tbody tr').last().innerText(), /Stopped after a failure/);
  // clicking a row opens that request with its response
  await page.locator('table.rn tbody tr', { hasText: 'Teapot' }).click();
  await page.waitForFunction(() => PW.state.activeTabId === 'f_pot');
  assert.match(await page.locator('#respane').innerText(), /418/);
});

test('</> Code dialog shows cURL, JavaScript, Python and PowerShell with variables resolved', { skip }, async (t) => {
  if (!need(t)) return;
  await activate('t_echo');
  await page.locator('.namebar button', { hasText: '</> Code' }).click();
  await page.waitForSelector('.modal pre.snippet');
  const text = () => page.locator('.modal pre.snippet').innerText();
  let s = await text();
  assert.match(s, /^curl /); assert.ok(s.includes(up.url + '/echo?v=1&k=same'), 'variables resolved: ' + s); assert.match(s, /-L/);
  await page.locator('.modal .seg button', { hasText: 'Python' }).click();
  assert.match(await text(), /requests\.request\(/);
  await page.locator('.modal .seg button', { hasText: 'PowerShell' }).click();
  assert.match(await text(), /Invoke-WebRequest/);
  await page.locator('.modal .seg button', { hasText: 'JavaScript' }).click();
  assert.match(await text(), /await fetch\(/);
  assert.equal(await page.evaluate(() => PW.state.ui.codeLang), 'js', 'the chosen language is remembered');
  await page.locator('.modal button', { hasText: /^Close$/ }).click();
  await page.waitForFunction(() => !document.querySelector('.modal'));
});

test('"?" opens the shortcut list (not while typing) and Ctrl+K can run a group', { skip }, async (t) => {
  if (!need(t)) return;
  await activate('t_echo');
  await page.locator('.logo').click();
  await page.keyboard.press('Shift+?');
  await page.waitForSelector('.modal table.keys');
  assert.match(await page.locator('.modal table.keys').innerText(), /Send the request/);
  await page.keyboard.press('Escape');
  await page.locator('.urlbar input').focus();
  await page.keyboard.type('?');
  assert.equal(await page.locator('.modal').count(), 0, 'typing ? in a field must not open the dialog');
  assert.match(await page.evaluate(() => PW.tab().url), /\?$/);
  await page.evaluate(() => { PW.tab().url = '{{baseUrl}}/echo?v={{version}}&k=same'; PW.emit('active'); });
  await page.keyboard.press('Control+k');
  await page.locator('.pal-in').fill('run group flow');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.modal table.rn');
  assert.match(await page.locator('.modal h2').innerText(), /Run group “Flow”/);
  await page.keyboard.press('Escape');
});

test('no unexpected console or page errors during the whole run', { skip }, (t) => {
  if (!need(t)) return;
  assert.deepEqual(errors, []);
});
