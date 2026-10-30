// Builds the outgoing request from a saved tab and resolves {{variables}}. Shared by the UI and the server
// (AI-agent tools), so both send exactly the same thing. Pure functions (browser + Node).
(function (root) {
  'use strict';

  const nodeCrypto = typeof window === 'undefined' && typeof require === 'function' ? require('crypto') : null;
  const uuid = () => {
    const c = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto : nodeCrypto;
    if (c && c.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16); });
  };

  const DYN = {
    $timestamp: () => String(Math.floor(Date.now() / 1000)),
    $timestampMs: () => String(Date.now()),
    $isoTimestamp: () => new Date().toISOString(),
    $uuid: uuid,
    $guid: uuid,
    $randomInt: () => String(Math.floor(Math.random() * 1001)),
  };
  const DYNAMIC = Object.keys(DYN);

  // Replaces {{name}}; unknown names are collected in `missing` and left untouched.
  function interpolate(str, map, missing) {
    if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
    return str.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, name) => {
      if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
      if (Object.prototype.hasOwnProperty.call(DYN, name)) return DYN[name]();
      if (missing) missing.add(name);
      return all;
    });
  }

  function b64(s) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
    return Buffer.from(s, 'utf8').toString('base64');
  }

  // opts.forLoad: basic auth is sent as parts so the load engine can fill per-iteration variables before encoding.
  function buildSpec(tab, map, missing, opts) {
    const forLoad = !!(opts && opts.forLoad);
    const I = (s) => interpolate(s, map, missing);
    const headers = (tab.headers || []).filter((x) => x.key && x.enabled !== false).map((x) => ({ key: I(x.key), value: I(x.value) }));
    const has = (n) => headers.some((x) => x.key.toLowerCase() === n);
    const a = tab.auth || { type: 'none' };
    let basicAuth = null;
    if (!has('authorization')) {
      if (a.type === 'bearer' && a.token) headers.push({ key: 'Authorization', value: 'Bearer ' + I(a.token) });
      if (a.type === 'basic' && forLoad) basicAuth = { user: I(a.user || ''), pass: I(a.pass || '') };
      else if (a.type === 'basic') headers.push({ key: 'Authorization', value: 'Basic ' + b64(I(a.user || '') + ':' + I(a.pass || '')) });
    }
    const method = String(tab.method || 'GET').toUpperCase();
    let body = null;
    if (tab.bodyType !== 'none' && tab.body && method !== 'GET' && method !== 'HEAD') {
      body = I(tab.body);
      if (!has('content-type')) {
        const ct = { json: 'application/json', form: 'application/x-www-form-urlencoded', text: 'text/plain; charset=utf-8' }[tab.bodyType];
        if (ct) headers.push({ key: 'Content-Type', value: ct });
      }
    }
    const s = tab.settings || {};
    return {
      method, url: I(tab.url || ''), headers, body, basicAuth,
      timeout: s.timeout, followRedirects: s.follow, insecure: s.insecure,
    };
  }

  function guessBodyType(body, headers) {
    if (!body) return 'none';
    const ct = ((headers || []).find((x) => String(x.key).toLowerCase() === 'content-type') || {}).value || '';
    if (/json/i.test(ct)) return 'json';
    if (/x-www-form-urlencoded/i.test(ct)) return 'form';
    try { JSON.parse(body); return 'json'; } catch { return 'text'; }
  }

  // dot / bracket path: a.b[0].c  or  ["key"]
  function pickPath(obj, path) {
    const parts = String(path).replace(/^\$\.?/, '').match(/[^.\[\]"']+/g) || [];
    let cur = obj;
    for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
    return cur;
  }

  const api = { interpolate, buildSpec, guessBodyType, pickPath, DYNAMIC, uuid };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReqSpec = api;
})(typeof window !== 'undefined' ? window : globalThis);
