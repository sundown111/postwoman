// Load-test engine (JMeter-style thread group) that runs inside the local server.
// Browsers cap connections per origin (~6), so virtual users must live here, not in the page.
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const Stats = require('./public/stats.js');
const Kit = require('./public/loadkit.js');

const LIMITS = { users: 5000, rampUp: 3600, hold: 86400, rampDown: 3600, iterations: 1e7, thinkMs: 600000, maxRps: 100000, csvRows: 200000 };
const RAW_CAP = 1000000; // samples kept individually (exact percentiles + JTL export)
const KEEP_RUNS = 3;
const MAX_ERROR_KINDS = 50;

// ---------- log-bucket histogram: bounded memory, ~0.1% value precision ----------
const H_MIN = 0.01, H_LN = Math.log1p(0.001), H_N = Math.ceil(Math.log(3.6e6 / H_MIN) / H_LN) + 2;
class Hist {
  constructor() { this.b = new Uint32Array(H_N); this.n = 0; this.zero = 0; this.min = Infinity; this.max = -Infinity; this.sum = 0; this.sq = 0; }
  add(v) {
    this.n++; this.sum += v; this.sq += v * v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    if (v <= H_MIN) { this.zero++; return; }
    this.b[Math.min(H_N - 1, Math.floor(Math.log(v / H_MIN) / H_LN))]++;
  }
  pct(p) {
    if (!this.n) return null;
    if (p <= 0) return this.min;
    if (p >= 100) return this.max;
    const rank = Math.max(1, Math.ceil((p / 100) * this.n));
    let c = this.zero;
    if (c >= rank) return this.min;
    for (let i = 0; i < H_N; i++) {
      c += this.b[i];
      if (c >= rank) return Math.min(this.max, Math.max(this.min, H_MIN * Math.exp((i + 0.5) * H_LN)));
    }
    return this.max;
  }
  *entries() { // (value, count) pairs, ascending
    if (this.zero) yield [Math.max(0, this.min), this.zero];
    for (let i = 0; i < H_N; i++) if (this.b[i]) yield [Math.min(this.max, H_MIN * Math.exp((i + 0.5) * H_LN)), this.b[i]];
  }
}

function moments(h) {
  if (!h.n) return { count: 0, avg: null, min: null, max: null, sd: null };
  const avg = h.sum / h.n;
  const sd = h.n > 1 ? Math.sqrt(Math.max(0, (h.sq - (h.sum * h.sum) / h.n) / (h.n - 1))) : 0;
  return { count: h.n, avg, min: h.min, max: h.max, sd };
}
function summaryFromHist(h) {
  const s = moments(h);
  for (const [k, p] of Kit.PCTS) s[k] = h.pct(p);
  return s;
}
function summaryFromSorted(sorted, h) {
  const s = moments(h);
  for (const [k, p] of Kit.PCTS) s[k] = Stats.percentile(sorted, p);
  return s;
}

// ---------- chunked typed columns (raw samples) ----------
class Col {
  constructor(T) { this.T = T; this.chunks = []; this.len = 0; }
  push(v) { const i = this.len & 65535; if (i === 0) this.chunks.push(new this.T(65536)); this.chunks[this.chunks.length - 1][i] = v; this.len++; }
  get(i) { return this.chunks[i >>> 16][i & 65535]; }
  toArray() {
    const out = new this.T(this.len);
    let off = 0;
    for (const c of this.chunks) { const n = Math.min(65536, this.len - off); out.set(n === 65536 ? c : c.subarray(0, n), off); off += n; }
    return out;
  }
}

// ---------- dynamic + data variables ----------
const DYN = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $timestampMs: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $uuid: () => crypto.randomUUID(),
  $guid: () => crypto.randomUUID(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};
function subst(str, vars) {
  if (typeof str !== 'string' || str.indexOf('{{') === -1) return str;
  return str.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : Object.prototype.hasOwnProperty.call(DYN, name) ? DYN[name]() : all));
}

const num = (v, lo, hi, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
const int = (v, lo, hi, def) => Math.round(num(v, lo, hi, def));
const opt = (v, hi) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : num(v, 0, hi, null)); // blank = criterion off
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function validate(c) {
  if (!c || typeof c !== 'object' || !c.spec || typeof c.spec !== 'object') throw new Error('Missing request');
  const rule = Kit.parseStatusRule(c.status);
  if (rule.error) throw new Error(rule.error);
  const csv = Kit.parseCsv(c.csv);
  if (csv.rows.length > LIMITS.csvRows) throw new Error('CSV has more than ' + LIMITS.csvRows + ' rows');
  if (csv.headers.length && !csv.rows.length) throw new Error('CSV has a header row but no data rows');
  const sla = c.sla || {};
  const cfg = {
    users: int(c.users, 1, LIMITS.users, 10),
    rampUp: num(c.rampUp, 0, LIMITS.rampUp, 0),
    mode: c.mode === 'iterations' ? 'iterations' : 'duration',
    hold: num(c.hold, 0, LIMITS.hold, 30),
    rampDown: num(c.rampDown, 0, LIMITS.rampDown, 0),
    iterations: int(c.iterations, 1, LIMITS.iterations, 10),
    thinkMs: num(c.thinkMs, 0, LIMITS.thinkMs, 0),
    jitterMs: num(c.jitterMs, 0, LIMITS.thinkMs, 0),
    maxRps: num(c.maxRps, 0, LIMITS.maxRps, 0),
    keepAlive: c.keepAlive !== false,
    status: String(c.status || '200-399'),
    contains: String(c.contains || ''),
    maxMs: num(c.maxMs, 0, 600000, 0),
    apdexT: num(c.apdexT, 1, 60000, 500),
    sla: { p95: opt(sla.p95, 1e7), p99: opt(sla.p99, 1e7), p9999: opt(sla.p9999, 1e7), errPct: opt(sla.errPct, 100), minRps: opt(sla.minRps, 1e7) },
    csvRows: csv.rows.length,
    label: String(c.label || 'Request').slice(0, 200),
    urlTemplate: String(c.urlTemplate || c.spec.url || '').slice(0, 2000),
    env: c.env ? String(c.env).slice(0, 100) : null,
    tabId: c.tabId ? String(c.tabId) : null,
  };
  if (cfg.mode === 'duration' && Kit.plannedSeconds(cfg) <= 0) throw new Error('Set a hold time (or ramp-up) greater than 0 seconds');
  return { cfg, rule, csv };
}

module.exports = function createLoad(core) {
  const runs = new Map();
  let current = null;

  class Run {
    constructor(body) {
      const { cfg, rule, csv } = validate(body);
      this.id = crypto.randomUUID();
      this.cfg = cfg; this.rule = rule; this.csv = csv; this.csvIdx = 0;
      this.spec = body.spec;
      this.needBody = !!cfg.contains;
      // Templates without placeholders are validated and built once; otherwise per iteration.
      this.static = JSON.stringify(this.spec).indexOf('{{') === -1 ? core.prepare(this.materialize({})) : null;
      if (!this.static) core.prepare(this.materialize(this.sampleVars())); // fail fast on a broken template
      this.ctl = new AbortController();
      this.state = 'running'; this.reason = null;
      this.vus = new Set(); this.active = 0; this.started = 0; this.maxActive = 0; this.secUsers = 0;
      this.nextSlot = 0;
      this.h = { el: new Hist(), ok: new Hist(), lat: new Hist(), con: new Hist() };
      this.count = 0; this.okCount = 0; this.bytes = 0; this.sent = 0;
      this.apdex = { s: 0, t: 0 };
      this.codes = new Map(); this.errs = new Map(); this.msgByCode = new Map();
      this.firstTs = Infinity; this.lastEnd = 0;
      this.raw = { ts: new Col(Float64Array), el: new Col(Float32Array), lat: new Col(Float32Array), con: new Col(Float32Array), code: new Col(Uint16Array), bytes: new Col(Uint32Array), sent: new Col(Uint32Array), thr: new Col(Uint16Array), vu: new Col(Uint16Array), ok: new Col(Uint8Array), err: new Col(Uint16Array) };
      this.errKeys = ['']; this.errIdx = new Map();
      this.rawCapped = false;
      this.timeline = []; this.open = new Map(); this.nextClose = 0;
      this.startedAt = Date.now(); this.t0 = performance.now();
      this.cpu0 = process.cpuUsage(); this.elu0 = performance.eventLoopUtilization();
      this.eld = monitorEventLoopDelay({ resolution: 20 }); this.eld.enable();
      this.timer = setInterval(() => this.safeTick(), 100);
      this.safeTick();
    }

    // An engine bug must end this run, never crash the whole server.
    safeTick() {
      try { this.tick(); }
      catch (e) {
        console.error('Load test engine error:', e);
        this.state = 'done'; this.reason = 'error'; this.error = e.message;
        clearInterval(this.timer); clearTimeout(this.killTimer);
        this.ctl.abort();
        for (const vu of this.vus) this.stopVu(vu);
        try { this.eld.disable(); } catch { /* ignore */ }
        if (current === this) current = null;
        this.report = null;
      }
    }

    sampleVars() {
      const v = { $vu: '1', $iteration: '1' };
      if (this.csv.rows.length) this.csv.headers.forEach((k, i) => { v[k] = this.csv.rows[0][i] ?? ''; });
      return v;
    }

    materialize(vars) {
      const S = (s) => subst(s, vars);
      const s = this.spec;
      const headers = (s.headers || []).map((x) => ({ key: S(x.key), value: S(x.value) }));
      if (s.basicAuth && !headers.some((x) => String(x.key).toLowerCase() === 'authorization')) {
        headers.push({ key: 'Authorization', value: 'Basic ' + Buffer.from(S(s.basicAuth.user || '') + ':' + S(s.basicAuth.pass || ''), 'utf8').toString('base64') });
      }
      return { method: s.method, url: S(s.url), headers, body: s.body == null ? null : S(s.body), timeout: s.timeout, followRedirects: s.followRedirects, insecure: s.insecure };
    }

    elapsed() { return (performance.now() - this.t0) / 1000; }

    // ---------- scheduling ----------
    tick() {
      const t = this.elapsed(), cfg = this.cfg;
      if (this.state === 'running') {
        const planned = Kit.plannedSeconds(cfg);
        if (planned != null && t >= planned) this.beginFinish('completed');
        else {
          const target = Kit.targetUsers(cfg, t);
          if (cfg.mode === 'iterations') {
            while (this.started < Math.min(target, cfg.users)) this.spawn();
            if (this.started >= cfg.users && this.active === 0) this.beginFinish('completed');
          } else {
            const live = [...this.vus].filter((v) => !v.stop);
            for (let n = live.length; n < target; n++) this.spawn();
            for (let n = live.length; n > target; n--) this.stopVu(live[n - 1]); // newest users leave first
          }
        }
      }
      this.secUsers = Math.max(this.secUsers, this.active);
      this.closeBuckets(Math.floor(t));
      if (this.state === 'finishing' && this.active === 0) this.finish();
    }

    spawn() {
      const vu = { idx: ++this.started, stop: false, wake: null, iter: 0, agents: null };
      if (this.cfg.keepAlive) vu.agents = { http: new http.Agent({ keepAlive: true, maxSockets: 1 }), https: new https.Agent({ keepAlive: true, maxSockets: 1 }) };
      this.vus.add(vu); this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      this.runVu(vu).catch((e) => console.error('Load test user ' + vu.idx + ' failed:', e)).finally(() => {
        this.active--; this.vus.delete(vu);
        if (vu.agents) { vu.agents.http.destroy(); vu.agents.https.destroy(); }
      });
    }

    stopVu(vu) { vu.stop = true; if (vu.wake) vu.wake(); }

    sleep(vu, ms) {
      return new Promise((resolve) => {
        const done = () => { clearTimeout(tm); vu.wake = null; resolve(); };
        const tm = setTimeout(done, ms);
        vu.wake = done;
      });
    }

    async runVu(vu) {
      const cfg = this.cfg;
      while (!vu.stop && this.state === 'running') {
        if (cfg.mode === 'iterations' && vu.iter >= cfg.iterations) break;
        if (cfg.maxRps > 0) { // shared pacing: Constant Throughput Timer
          const now = performance.now();
          const slot = Math.max(now, this.nextSlot);
          this.nextSlot = slot + 1000 / cfg.maxRps;
          if (slot - now > 0.5) await this.sleep(vu, slot - now);
          if (vu.stop || this.state !== 'running') break;
        }
        vu.iter++;
        const s = await this.exec(vu);
        if (s) this.record(s);
        const think = cfg.thinkMs + (cfg.jitterMs ? Math.random() * cfg.jitterMs : 0);
        if (think > 0 && !vu.stop && this.state === 'running') await this.sleep(vu, think);
      }
    }

    async exec(vu) {
      const vars = { $vu: String(vu.idx), $iteration: String(vu.iter) };
      if (this.csv.rows.length) {
        const row = this.csv.rows[this.csvIdx++ % this.csv.rows.length]; // shared across users, recycled at EOF (JMeter default)
        this.csv.headers.forEach((k, i) => { vars[k] = row[i] ?? ''; });
      }
      const ts = Date.now(), t0 = performance.now();
      let p;
      try { p = this.static || core.prepare(this.materialize(vars)); }
      catch (e) { return { ts, el: 0, lat: 0, con: 0, code: 0, ok: false, err: (e.code || 'ERROR') + ': ' + e.message, bytes: 0, sent: 0, vu: vu.idx }; }
      try {
        const r = await core.runHops(p, { agents: vu.agents || false, signal: this.ctl.signal, discard: !this.needBody });
        if (this.ctl.signal.aborted) return null;
        const res = r.hop.res, T = r.hop.timings, el = r.totalWall;
        const con = (T.dns || 0) + (T.tcp || 0) + (T.tls || 0);
        const lat = Math.max(0, el - (T.download || 0));
        let hdrBytes = 17 + (res.statusMessage || '').length;
        for (let i = 0; i < res.rawHeaders.length; i++) hdrBytes += res.rawHeaders[i].length + 2;
        let err = null;
        if (!this.rule.test(res.statusCode)) err = 'Status ' + res.statusCode + ' not in ' + this.cfg.status;
        else if (this.needBody) {
          const text = core.decompress(r.hop.raw, res.headers['content-encoding']).toString('utf8');
          if (text.indexOf(this.cfg.contains) === -1) err = 'Body does not contain "' + this.cfg.contains.slice(0, 60) + '"';
        }
        if (!err && this.cfg.maxMs > 0 && el > this.cfg.maxMs) err = 'Slower than ' + this.cfg.maxMs + ' ms';
        if (!this.msgByCode.has(res.statusCode)) this.msgByCode.set(res.statusCode, res.statusMessage || '');
        return { ts, el, lat, con, code: res.statusCode, ok: !err, err, bytes: r.hop.wireSize + hdrBytes, sent: p.sentBytes, vu: vu.idx };
      } catch (e) {
        if (this.ctl.signal.aborted) return null;
        const fe = core.friendlyError(e);
        const el = performance.now() - t0;
        return { ts, el, lat: el, con: 0, code: 0, ok: false, err: fe.code + ': ' + fe.error, errCode: fe.code, bytes: 0, sent: 0, vu: vu.idx };
      }
    }

    // ---------- aggregation ----------
    record(s) {
      this.count++;
      if (s.ok) this.okCount++;
      this.bytes += s.bytes; this.sent += s.sent;
      this.h.el.add(s.el); this.h.lat.add(s.lat); this.h.con.add(s.con);
      if (s.ok) {
        this.h.ok.add(s.el);
        if (s.el <= this.cfg.apdexT) this.apdex.s++;
        else if (s.el <= 4 * this.cfg.apdexT) this.apdex.t++;
      }
      const ck = s.code ? String(s.code) : s.errCode || 'ERR';
      this.codes.set(ck, (this.codes.get(ck) || 0) + 1);
      let ei = 0;
      if (s.err) {
        let key = s.err;
        if (!this.errs.has(key) && this.errs.size >= MAX_ERROR_KINDS) key = 'Other errors';
        this.errs.set(key, (this.errs.get(key) || 0) + 1);
        ei = this.errIdx.get(key);
        if (ei == null) { ei = this.errKeys.length; this.errKeys.push(key); this.errIdx.set(key, ei); }
      }
      if (s.ts < this.firstTs) this.firstTs = s.ts;
      if (s.ts + s.el > this.lastEnd) this.lastEnd = s.ts + s.el;

      const idx = Math.floor(this.elapsed());
      let b = this.open.get(idx);
      if (!b) { b = { n: 0, err: 0, sum: 0, lats: [], kb: 0, kbs: 0, c2: 0, c3: 0, c4: 0, c5: 0, ce: 0 }; this.open.set(idx, b); }
      b.n++; b.sum += s.el; b.lats.push(s.el); b.kb += s.bytes / 1024; b.kbs += s.sent / 1024;
      if (!s.ok) b.err++;
      const cls = Math.floor(s.code / 100);
      if (cls >= 2 && cls <= 5) b['c' + cls]++; else b.ce++;

      if (this.count <= RAW_CAP) {
        const R = this.raw;
        R.ts.push(s.ts); R.el.push(s.el); R.lat.push(s.lat); R.con.push(s.con); R.code.push(s.code);
        R.bytes.push(s.bytes); R.sent.push(s.sent); R.thr.push(Math.min(65535, this.active)); R.vu.push(Math.min(65535, s.vu)); R.ok.push(s.ok ? 1 : 0); R.err.push(ei);
      } else this.rawCapped = true;
    }

    closeBuckets(upTo, partialSpan) {
      while (this.nextClose < upTo || (partialSpan != null && this.nextClose === upTo)) {
        const i = this.nextClose++;
        const b = this.open.get(i); this.open.delete(i);
        const span = partialSpan != null && i === upTo ? Math.max(0.05, partialSpan) : 1;
        const e = { t: i, span, users: this.secUsers, n: 0, err: 0, avg: null, min: null, p50: null, p90: null, p95: null, p99: null, max: null, kb: 0, kbs: 0, c2: 0, c3: 0, c4: 0, c5: 0, ce: 0 };
        if (b) {
          const L = Float64Array.from(b.lats).sort();
          Object.assign(e, { n: b.n, err: b.err, avg: b.sum / b.n, min: L[0], max: L[L.length - 1], p50: Stats.percentile(L, 50), p90: Stats.percentile(L, 90), p95: Stats.percentile(L, 95), p99: Stats.percentile(L, 99),
            kb: b.kb, kbs: b.kbs, c2: b.c2, c3: b.c3, c4: b.c4, c5: b.c5, ce: b.ce });
        }
        this.timeline.push(e);
        this.secUsers = this.active;
      }
    }

    beginFinish(reason) {
      if (this.state !== 'running') return;
      this.state = 'finishing'; this.reason = reason;
      for (const vu of this.vus) this.stopVu(vu);
      // in-flight requests finish normally (no survivorship bias); hard cap in case a target hangs
      const maxWait = Math.min(300000, (this.spec.timeout || 30000) + 2000);
      this.killTimer = setTimeout(() => this.ctl.abort(), maxWait);
    }

    stop() {
      if (this.state === 'done') return;
      if (this.state === 'running') this.beginFinish('stopped');
      this.reason = 'stopped';
      this.ctl.abort(); // user stop: cancel in-flight requests and discard them
      for (const vu of this.vus) this.stopVu(vu);
    }

    finish() {
      clearInterval(this.timer); clearTimeout(this.killTimer);
      const t = this.elapsed();
      this.closeBuckets(Math.floor(t), t - Math.floor(t));
      this.eld.disable();
      this.wall = t;
      this.health = this.healthNow();
      this.state = 'done';
      this.report = this.buildReport();
      if (current === this) current = null;
      const done = [...runs.values()].filter((r) => r.state === 'done');
      while (done.length > KEEP_RUNS) runs.delete(done.shift().id);
      if (core.onFinish) { try { core.onFinish(this); } catch (e) { console.error('Saving load test result failed:', e); } }
    }

    healthNow() {
      const cpu = process.cpuUsage(this.cpu0);
      const wallMs = Math.max(1, performance.now() - this.t0);
      const lagP99 = this.eld.percentile(99) / 1e6, lagMax = this.eld.max / 1e6;
      const cpuPct = ((cpu.user + cpu.system) / 1000 / wallMs) * 100; // all process threads, can exceed 100
      const elu = performance.eventLoopUtilization(this.elu0).utilization * 100; // main thread busy %: the real bottleneck
      return { cpu: cpuPct, elu, lagP99, lagMax, saturated: elu > 90 || lagP99 > 50 };
    }

    durationSec() {
      return this.count ? Math.max(0.001, (this.lastEnd - this.firstTs) / 1000) : this.elapsed();
    }

    live() {
      const last = this.timeline[this.timeline.length - 1];
      const dur = this.durationSec();
      return {
        count: this.count, errors: this.count - this.okCount,
        errPct: this.count ? ((this.count - this.okCount) / this.count) * 100 : 0,
        rps: this.count / dur, curRps: last ? last.n / last.span : 0,
        recvKBs: this.bytes / 1024 / dur, sentKBs: this.sent / 1024 / dur,
        el: summaryFromHist(this.h.el),
        apdex: this.count ? (this.apdex.s + this.apdex.t / 2) / this.count : null,
      };
    }

    status(since) {
      return {
        ok: true, id: this.id, tabId: this.cfg.tabId, state: this.state, reason: this.reason,
        elapsed: this.elapsed(), planned: Kit.plannedSeconds(this.cfg), active: this.active, started: this.started, users: this.cfg.users,
        mode: this.cfg.mode, plannedSamples: this.cfg.mode === 'iterations' ? this.cfg.users * this.cfg.iterations : null,
        summary: this.live(), health: this.state === 'done' ? this.health : this.healthNow(),
        timeline: this.timeline.slice(since || 0), tlLen: this.timeline.length,
      };
    }

    buildReport() {
      const cfg = this.cfg, n = this.count, exact = !this.rawCapped && n > 0;
      let el, elOk, lat, con, sortedEl = null;
      if (exact) {
        const R = this.raw;
        sortedEl = R.el.toArray().sort();
        const okFlags = R.ok.toArray(), elArr = R.el.toArray();
        const okVals = new Float32Array(this.okCount);
        for (let i = 0, j = 0; i < elArr.length; i++) if (okFlags[i]) okVals[j++] = elArr[i];
        el = summaryFromSorted(sortedEl, this.h.el);
        elOk = summaryFromSorted(okVals.sort(), this.h.ok);
        lat = summaryFromSorted(R.lat.toArray().sort(), this.h.lat);
        con = summaryFromSorted(R.con.toArray().sort(), this.h.con);
      } else {
        el = summaryFromHist(this.h.el); elOk = summaryFromHist(this.h.ok); lat = summaryFromHist(this.h.lat); con = summaryFromHist(this.h.con);
      }
      const dur = this.durationSec();
      const errors = n - this.okCount;
      const errPct = n ? (errors / n) * 100 : 0;
      const rps = n / dur;
      const peak = this.timeline.reduce((m, b) => (b.span >= 0.5 ? Math.max(m, b.n / b.span) : m), 0);

      // distribution: 40 linear bins from min to p99.9, plus an overflow bin
      const hist = { bins: [], over: 0, overFrom: null };
      if (n) {
        const lo = el.min, hi = Math.max(el.p999, lo + 0.001), bins = 40, w = (hi - lo) / bins;
        hist.bins = Array.from({ length: bins }, (_, i) => ({ from: lo + i * w, to: lo + (i + 1) * w, n: 0 }));
        hist.overFrom = hi;
        const put = (v, c) => { if (v > hi) hist.over += c; else hist.bins[Math.max(0, Math.min(bins - 1, Math.floor((v - lo) / w)))].n += c; }; // float32 raw values can sit a hair below the exact min
        if (sortedEl) for (let i = 0; i < sortedEl.length; i++) put(sortedEl[i], 1);
        else for (const [v, c] of this.h.el.entries()) put(v, c);
      }

      const P = [0, 10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 92.5, 95, 97.5, 99, 99.5, 99.9, 99.95, 99.99, 99.995, 100];
      const curve = { p: P, el: [], lat: [], con: [] };
      if (n) {
        if (exact) {
          const sl = this.raw.lat.toArray().sort(), sc = this.raw.con.toArray().sort();
          P.forEach((p) => { curve.el.push(Stats.percentile(sortedEl, p)); curve.lat.push(Stats.percentile(sl, p)); curve.con.push(Stats.percentile(sc, p)); });
        } else P.forEach((p) => { curve.el.push(this.h.el.pct(p)); curve.lat.push(this.h.lat.pct(p)); curve.con.push(this.h.con.pct(p)); });
      }

      const sla = [];
      const add = (label, actual, op, limit, fmt) => { if (limit != null) sla.push({ label, actual, op, limit, fmt, pass: actual != null && (op === '<=' ? actual <= limit : actual >= limit) }); };
      add('p95 response time', el.p95, '<=', cfg.sla.p95, 'ms');
      add('p99 response time', el.p99, '<=', cfg.sla.p99, 'ms');
      add('p99.99 response time', el.p9999, '<=', cfg.sla.p9999, 'ms');
      add('Error rate', errPct, '<=', cfg.sla.errPct, '%');
      add('Throughput', rps, '>=', cfg.sla.minRps, 'rps');

      return {
        id: this.id, tabId: cfg.tabId, label: cfg.label, method: String(this.spec.method || 'GET').toUpperCase(), url: cfg.urlTemplate, env: cfg.env,
        at: this.startedAt, endedAt: Date.now(), reason: this.reason, config: { ...cfg, tabId: undefined, label: undefined, urlTemplate: undefined, env: undefined },
        duration: dur, wall: this.wall, count: n, okCount: this.okCount, errors, errPct, rps, peakRps: peak,
        recvKBs: this.bytes / 1024 / dur, sentKBs: this.sent / 1024 / dur, avgBytes: n ? this.bytes / n : 0, maxUsers: this.maxActive,
        apdex: { T: cfg.apdexT, score: n ? (this.apdex.s + this.apdex.t / 2) / n : null, s: this.apdex.s, t: this.apdex.t, f: n - this.apdex.s - this.apdex.t },
        el, elOk, lat, con, exact, rawCapped: this.rawCapped,
        codes: [...this.codes.entries()].sort((a, b) => b[1] - a[1]).map(([code, c]) => ({ code, n: c, msg: this.msgByCode.get(Number(code)) || '' })),
        errorsList: [...this.errs.entries()].sort((a, b) => b[1] - a[1]).map(([key, c]) => ({ key, n: c })),
        timeline: this.timeline, hist, curve, sla, verdict: sla.length ? (sla.every((x) => x.pass) ? 'pass' : 'fail') : null,
        health: this.health,
      };
    }

    async writeJtl(res) {
      const R = this.raw, n = R.el.len;
      const label = csvCell(this.cfg.label), url = csvCell(this.static ? this.static.urlObj.href : this.cfg.urlTemplate);
      res.write('timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect\n');
      let buf = [];
      for (let i = 0; i < n; i++) {
        const code = R.code.get(i), err = R.err.get(i), thr = R.thr.get(i);
        const codeStr = code ? String(code) : 'Non HTTP response code';
        const msg = code ? this.msgByCode.get(code) || '' : this.errKeys[err] || '';
        buf.push([Math.round(R.ts.get(i)), Math.round(R.el.get(i)), label, codeStr, csvCell(msg), 'Thread Group 1-' + R.vu.get(i), 'text', R.ok.get(i) ? 'true' : 'false',
          csvCell(this.errKeys[err] || ''), R.bytes.get(i), R.sent.get(i), thr, thr, url, Math.round(R.lat.get(i)), 0, Math.round(R.con.get(i))].join(','));
        if (buf.length === 5000) { if (!res.write(buf.join('\n') + '\n')) await new Promise((r) => res.once('drain', r)); buf = []; }
      }
      if (buf.length) res.write(buf.join('\n') + '\n');
      res.end();
    }
  }

  // Programmatic API (used by the HTTP routes below and by the AI-agent tools).
  function start(body) {
    if (current && current.state !== 'done') throw Object.assign(new Error('A load test is already running (' + current.cfg.label + '). Stop it first.'), { status: 409 });
    let r;
    try { r = new Run(body); } catch (e) { throw Object.assign(e, { status: 400 }); }
    r.origin = body.origin === 'agent' ? 'agent' : 'ui';
    runs.set(r.id, r); current = r;
    if (core.onStart) { try { core.onStart(r); } catch (e) { console.error(e); } }
    return r;
  }
  const get = (id) => runs.get(id) || null;
  const active = () => (current && current.state !== 'done' ? current : null);

  async function route(req, res, u, h) {
    const id = u.searchParams.get('id');
    const run = id ? runs.get(id) : null;
    const p = u.pathname;
    if (p === '/api/load/start' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await h.readBody(req)).toString('utf8')); } catch { return h.sendJson(res, 400, { ok: false, error: 'Bad JSON' }); }
      try { return h.sendJson(res, 200, { ok: true, id: start(body).id }); }
      catch (e) { return h.sendJson(res, e.status || 400, { ok: false, error: e.message }); }
    }
    if (p === '/api/load/active' && req.method === 'GET') {
      return h.sendJson(res, 200, current && current.state !== 'done' ? { ok: true, id: current.id, tabId: current.cfg.tabId } : { ok: true, id: null });
    }
    if (!run) return h.sendJson(res, 404, { ok: false, error: 'Unknown load test (the server keeps only the last ' + KEEP_RUNS + ' runs in memory)' });
    if (p === '/api/load/status' && req.method === 'GET') return h.sendJson(res, 200, run.status(Number(u.searchParams.get('since')) || 0));
    if (p === '/api/load/stop' && req.method === 'POST') { run.stop(); return h.sendJson(res, 200, { ok: true }); }
    if (p === '/api/load/report' && req.method === 'GET') {
      if (run.state !== 'done') return h.sendJson(res, 409, { ok: false, error: 'Still running' });
      if (!run.report) return h.sendJson(res, 500, { ok: false, error: 'The load test failed: ' + (run.error || 'unknown error') });
      return h.sendJson(res, 200, { ok: true, report: run.report });
    }
    if (p === '/api/load/jtl' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (run.state !== 'done' || !run.report) return h.sendJson(res, 409, { ok: false, error: 'No results' });
      const name = 'postwoman-load-' + new Date(run.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.jtl';
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      return run.writeJtl(res);
    }
    return h.sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  return { route, start, get, active, _Hist: Hist };
};
