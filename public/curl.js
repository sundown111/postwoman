// curl <-> request converter. Pure functions, works in browser and Node (for tests).
(function (root) {
  'use strict';

  // ---- shell-ish tokenizer: '..', "..", $'..', backslash escapes, line continuations ----
  function tokenize(input) {
    const s = String(input).replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
    const tokens = [];
    let cur = '', inTok = false, i = 0;
    const push = () => { if (inTok) { tokens.push(cur); cur = ''; inTok = false; } };
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { push(); i++; continue; }
      inTok = true;
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end === -1) { cur += s.slice(i + 1); i = s.length; break; }
        cur += s.slice(i + 1, end); i = end + 1;
      } else if (c === '$' && s[i + 1] === "'") { // ANSI-C quoting
        i += 2;
        while (i < s.length && s[i] !== "'") {
          if (s[i] === '\\' && i + 1 < s.length) {
            const n = s[i + 1];
            const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
            if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.substr(i + 2, 4))) { cur += String.fromCharCode(parseInt(s.substr(i + 2, 4), 16)); i += 6; continue; }
            if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 2, 2))) { cur += String.fromCharCode(parseInt(s.substr(i + 2, 2), 16)); i += 4; continue; }
            cur += (n in map) ? map[n] : n; i += 2;
          } else { cur += s[i]; i++; }
        }
        i++; // closing '
      } else if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; }
          else { cur += s[i]; i++; }
        }
        i++;
      } else if (c === '\\' && i + 1 < s.length) {
        cur += s[i + 1]; i += 2;
      } else { cur += c; i++; }
    }
    push();
    return tokens;
  }

  const SHORT_WITH_ARG = new Set(['X', 'H', 'd', 'u', 'A', 'b', 'e', 'F', 'm', 'o', 'T', 'x', 'w', 'K', 'c']);
  const LONG_WITH_ARG = new Set([
    'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'user',
    'user-agent', 'cookie', 'referer', 'form', 'form-string', 'max-time', 'output', 'upload-file', 'url',
    'proxy', 'connect-timeout', 'write-out', 'config', 'cookie-jar', 'retry', 'cacert', 'cert', 'key', 'resolve',
    'oauth2-bearer', 'range', 'compressed-ssh', 'http-version',
  ]);

  function looksLikeCurl(text) {
    return /^\s*curl(?:\.exe)?(\s|$)/i.test(String(text));
  }

  // returns { method, url, headers:[{key,value}], body, followRedirects, insecure, timeout, warnings[] }
  function parseCurl(text) {
    let toks = tokenize(text);
    if (toks[0] && /^curl(\.exe)?$/i.test(toks[0])) toks = toks.slice(1);
    const out = {
      method: null, url: '', headers: [], body: '', followRedirects: false, insecure: false,
      timeout: null, warnings: [],
    };
    const dataParts = [];
    let urlencodeParts = [];
    let forceGet = false, head = false, sawJson = false, user = null, cookie = null;
    const positional = [];

    const apply = (name, val) => {
      switch (name) {
        case 'X': case 'request': out.method = String(val).toUpperCase(); break;
        case 'H': case 'header': {
          const idx = val.indexOf(':');
          if (idx > 0) out.headers.push({ key: val.slice(0, idx).trim(), value: val.slice(idx + 1).trim(), enabled: true });
          else if (val.endsWith(';')) out.headers.push({ key: val.slice(0, -1).trim(), value: '', enabled: true });
          break;
        }
        case 'd': case 'data': case 'data-ascii': case 'data-raw': case 'data-binary':
          if ((name === 'd' || name === 'data' || name === 'data-ascii') && val.startsWith('@')) out.warnings.push(`File upload "${val}" is not supported; add the body manually.`);
          dataParts.push(val); break;
        case 'data-urlencode': {
          const eq = val.indexOf('=');
          if (eq === -1) urlencodeParts.push(encodeURIComponent(val));
          else if (eq === 0) urlencodeParts.push(encodeURIComponent(val.slice(1)));
          else urlencodeParts.push(val.slice(0, eq) + '=' + encodeURIComponent(val.slice(eq + 1)));
          break;
        }
        case 'json': sawJson = true; dataParts.push(val); break;
        case 'u': case 'user': user = val; break;
        case 'A': case 'user-agent': out.headers.push({ key: 'User-Agent', value: val, enabled: true }); break;
        case 'b': case 'cookie': cookie = val; break;
        case 'e': case 'referer': out.headers.push({ key: 'Referer', value: val, enabled: true }); break;
        case 'm': case 'max-time': { const n = parseFloat(val); if (n > 0) out.timeout = Math.round(n * 1000); break; }
        case 'url': positional.push(val); break;
        case 'F': case 'form': case 'form-string': out.warnings.push('Multipart form (-F) is not supported yet; the field was skipped.'); break;
        case 'T': case 'upload-file': out.warnings.push('File upload (-T) is not supported.'); break;
        case 'oauth2-bearer': out.headers.push({ key: 'Authorization', value: 'Bearer ' + val, enabled: true }); break;
        case 'L': case 'location': out.followRedirects = true; break;
        case 'k': case 'insecure': out.insecure = true; break;
        case 'I': case 'head': head = true; break;
        case 'G': case 'get': forceGet = true; break;
        default: break; // -s -S -i -v --compressed etc: harmless here
      }
    };

    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '--') { positional.push(...toks.slice(i + 1)); break; }
      if (t.startsWith('--')) {
        const eq = t.indexOf('=');
        const name = eq > -1 ? t.slice(2, eq) : t.slice(2);
        if (LONG_WITH_ARG.has(name)) {
          const val = eq > -1 ? t.slice(eq + 1) : toks[++i];
          if (val !== undefined) apply(name, val);
        } else apply(name, true);
      } else if (t.startsWith('-') && t.length > 1) {
        // cluster of short flags, e.g. -sSL or -XPOST or -H'..'
        for (let j = 1; j < t.length; j++) {
          const f = t[j];
          if (SHORT_WITH_ARG.has(f)) {
            const rest = t.slice(j + 1);
            const val = rest.length ? rest : toks[++i];
            if (val !== undefined) apply(f, val);
            break;
          }
          apply(f, true);
        }
      } else positional.push(t);
    }

    out.url = positional[0] || '';
    if (positional.length > 1) out.warnings.push('Multiple URLs found; using the first one.');

    let body = [...dataParts, ...urlencodeParts].join('&');
    if (sawJson) {
      if (!out.headers.some((h) => h.key.toLowerCase() === 'content-type')) out.headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
      if (!out.headers.some((h) => h.key.toLowerCase() === 'accept')) out.headers.push({ key: 'Accept', value: 'application/json', enabled: true });
    }
    if (forceGet && body) {
      out.url += (out.url.includes('?') ? '&' : '?') + body;
      body = '';
    }
    out.body = body;
    if (user != null) out.headers.push({ key: 'Authorization', value: 'Basic ' + b64(user), enabled: true });
    if (cookie != null && !/^[^=;]+$/.test(cookie)) out.headers.push({ key: 'Cookie', value: cookie, enabled: true });
    else if (cookie != null) out.warnings.push('Cookie file is not supported.');

    if (head) out.method = 'HEAD';
    else if (!out.method) out.method = body ? 'POST' : 'GET';
    if (body && !out.headers.some((h) => h.key.toLowerCase() === 'content-type') && !forceGet) {
      out.headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
    }
    return out;
  }

  function b64(s) {
    if (typeof btoa === 'function') {
      try { return btoa(unescape(encodeURIComponent(s))); } catch { /* fall through */ }
    }
    return Buffer.from(s, 'utf8').toString('base64');
  }

  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  // req: { method, url, headers:[{key,value,enabled}], body }
  function toCurl(req) {
    const m = (req.method || 'GET').toUpperCase();
    const first = ['curl'];
    if (m === 'HEAD') first.push('-I');
    else if (m !== 'GET') first.push('-X', m);
    first.push(shq(req.url || ''));
    const lines = [first.join(' ')];
    for (const h of req.headers || []) if (h.enabled !== false && h.key) lines.push('-H ' + shq(h.key + ': ' + h.value));
    if (req.body && m !== 'GET' && m !== 'HEAD') lines.push('--data-raw ' + shq(req.body));
    return lines.join(' \\\n  ');
  }

  const api = { tokenize, parseCurl, looksLikeCurl, toCurl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Curl = api;
})(typeof window !== 'undefined' ? window : globalThis);
