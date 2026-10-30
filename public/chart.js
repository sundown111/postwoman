// Tiny SVG charts with hover tooltips: line / area / scatter (optionally dual axis) and bars.
(function () {
  'use strict';
  const { h } = PW;
  const NS = 'http://www.w3.org/2000/svg';
  const W = 640;
  const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const txt = (x, y, s, attrs) => { const t = svgEl('text', Object.assign({ x, y }, attrs || {})); t.textContent = s; return t; };

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }
  const fmtNum = (v) => (v == null ? '—' : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(0) + 'k' : Math.abs(v) >= 1000 ? (v / 1e3).toFixed(1) + 'k' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : (+v.toFixed(2)).toString());
  PW.fmtNum = fmtNum;
  PW.fmtClock = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };

  function legend(series) {
    return h('div', { class: 'clegend' }, series.filter((s) => !s.hideLegend).map((s) => h('span', null, h('i', { style: { background: s.color, opacity: s.dash ? 0.7 : 1 } }), s.label)));
  }

  function attachHover(wrap, svg, H, padL, pw, xsAll, X, render) {
    const tip = h('div', { class: 'ctip' });
    const vline = svgEl('line', { y1: 8, y2: H - 22, stroke: 'var(--dim)', 'stroke-dasharray': '3 3', opacity: 0, 'pointer-events': 'none' });
    svg.append(vline);
    wrap.append(tip);
    const hide = () => { tip.style.display = 'none'; vline.setAttribute('opacity', 0); };
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const vx = ((e.clientX - r.left) / r.width) * W;
      if (vx < padL - 6 || vx > padL + pw + 6 || !xsAll.length) { hide(); return; }
      let best = xsAll[0], bd = Infinity;
      for (const x of xsAll) { const d = Math.abs(X(x) - vx); if (d < bd) { bd = d; best = x; } }
      const content = render(best);
      if (!content) { hide(); return; }
      vline.setAttribute('x1', X(best)); vline.setAttribute('x2', X(best)); vline.setAttribute('opacity', 0.8);
      tip.textContent = ''; tip.append(content); tip.style.display = 'block';
      const wr = wrap.getBoundingClientRect();
      const px = (X(best) / W) * r.width + (r.left - wr.left);
      const tw = tip.offsetWidth;
      tip.style.left = (px + 12 + tw > wr.width ? Math.max(0, px - tw - 12) : px + 12) + 'px';
      tip.style.top = Math.max(0, e.clientY - wr.top - 20) + 'px';
    });
  }

  // o: { series:[{label,color,points:[[x,y]],axis:'l'|'r',fill,dash,scatter,width}], height, xFmt, yFmt, y2Fmt, xTicks:[{v,label}], xMin, xMax, yMax, empty }
  PW.chart = {};
  PW.chart.line = function (o) {
    const series = o.series.filter((s) => s.points && s.points.length);
    if (!series.length) return h('div', { class: 'hint cempty' }, o.empty || 'No data yet');
    const H = o.height || 180;
    const hasR = series.some((s) => s.axis === 'r');
    const padL = 46, padR = hasR ? 46 : 14, padT = 8, padB = 22;
    const pw = W - padL - padR, ph = H - padT - padB;
    let xMin = Infinity, xMax = -Infinity, yL = 0, yR = 0;
    const xsSet = new Set();
    for (const s of series) for (const [x, y] of s.points) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x; xsSet.add(x);
      if (y != null) { if (s.axis === 'r') yR = Math.max(yR, y); else yL = Math.max(yL, y); }
    }
    if (o.xMin != null) xMin = o.xMin;
    if (o.xMax != null) xMax = o.xMax;
    const yMaxL = o.yMax || niceMax(yL * 1.05), yMaxR = niceMax(yR * 1.05);
    const X = (x) => padL + (xMax === xMin ? pw / 2 : ((x - xMin) / (xMax - xMin)) * pw);
    const Y = (y, ax) => padT + ph - (y / (ax === 'r' ? yMaxR : yMaxL)) * ph;
    const yFmt = o.yFmt || fmtNum, y2Fmt = o.y2Fmt || fmtNum, xFmt = o.xFmt || fmtNum;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    for (let i = 0; i <= 4; i++) {
      const y = padT + ph - (ph * i) / 4;
      svg.append(svgEl('line', { x1: padL, x2: padL + pw, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
      svg.append(txt(padL - 6, y + 3, yFmt((yMaxL * i) / 4), { 'text-anchor': 'end' }));
      if (hasR) svg.append(txt(padL + pw + 6, y + 3, y2Fmt((yMaxR * i) / 4), { 'text-anchor': 'start' }));
    }
    const ticks = o.xTicks || Array.from({ length: 6 }, (_, i) => ({ v: xMin + ((xMax - xMin) * i) / 5 }));
    ticks.forEach((t) => {
      if (t.v < xMin - 1e-9 || t.v > xMax + 1e-9) return;
      svg.append(txt(X(t.v), H - 6, t.label != null ? t.label : xFmt(t.v), { 'text-anchor': 'middle' }));
      if (o.xTicks) svg.append(svgEl('line', { x1: X(t.v), x2: X(t.v), y1: padT, y2: padT + ph, stroke: 'var(--line)', 'stroke-dasharray': '2 4' }));
    });

    for (const s of series) {
      const w = s.width || 1.7;
      if (s.scatter) {
        for (const [x, y] of s.points) if (y != null) svg.append(svgEl('circle', { cx: X(x), cy: Y(y, s.axis), r: 2.6, fill: s.color, opacity: 0.75 }));
        continue;
      }
      let d = '', area = '', run = [];
      const flush = () => {
        if (run.length && s.fill) area += 'M' + X(run[0][0]) + ' ' + Y(0, s.axis) + run.map(([x, y]) => 'L' + X(x).toFixed(1) + ' ' + Y(y, s.axis).toFixed(1)).join('') + 'L' + X(run[run.length - 1][0]) + ' ' + Y(0, s.axis) + 'Z';
        run = [];
      };
      for (const [x, y] of s.points) {
        if (y == null) { flush(); d += ' '; continue; }
        d += (run.length ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(y, s.axis).toFixed(1);
        run.push([x, y]);
      }
      flush();
      if (area) svg.append(svgEl('path', { d: area, fill: s.color, opacity: 0.13, stroke: 'none' }));
      svg.append(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': w, 'stroke-linejoin': 'round', 'stroke-dasharray': s.dash ? '5 4' : 'none' }));
      if (s.points.length === 1) svg.append(svgEl('circle', { cx: X(s.points[0][0]), cy: Y(s.points[0][1] || 0, s.axis), r: 3, fill: s.color }));
    }

    const wrap = h('div', { class: 'cwrap' }, svg, o.legend === false ? null : legend(series));
    const xs = [...xsSet].sort((a, b) => a - b);
    attachHover(wrap, svg, H, padL, pw, xs, X, (x) => {
      const rows = [];
      for (const s of series) {
        let pt = null, bd = Infinity;
        for (const p of s.points) { const d = Math.abs(p[0] - x); if (d < bd) { bd = d; pt = p; } }
        if (!pt || pt[1] == null || (s.scatter && bd > 1e-9)) continue;
        rows.push(h('div', null, h('i', { style: { background: s.color } }), s.label + ': ', h('b', null, (s.axis === 'r' ? y2Fmt : yFmt)(pt[1]))));
      }
      return rows.length ? h('div', null, h('div', { class: 'ctip-h' }, (o.tipX || xFmt)(x)), rows) : null;
    });
    return wrap;
  };

  // o: { bins:[{from,to,n}], color, xFmt, over:{n,label} }
  PW.chart.bars = function (o) {
    const bins = o.bins || [];
    if (!bins.length) return h('div', { class: 'hint cempty' }, o.empty || 'No data yet');
    const H = o.height || 180, padL = 46, padR = 14, padT = 8, padB = 22;
    const all = o.over && o.over.n ? bins.concat([{ from: o.over.from, to: o.over.from, n: o.over.n, over: true }]) : bins;
    const pw = W - padL - padR, ph = H - padT - padB;
    const yMax = niceMax(Math.max(...all.map((b) => b.n)) * 1.05);
    const bw = pw / all.length;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    for (let i = 0; i <= 4; i++) {
      const y = padT + ph - (ph * i) / 4;
      svg.append(svgEl('line', { x1: padL, x2: padL + pw, y1: y, y2: y, stroke: 'var(--line)' }));
      svg.append(txt(padL - 6, y + 3, fmtNum((yMax * i) / 4), { 'text-anchor': 'end' }));
    }
    all.forEach((b, i) => {
      const bh = (b.n / yMax) * ph;
      svg.append(svgEl('rect', { x: padL + i * bw + 0.6, y: padT + ph - bh, width: Math.max(1, bw - 1.2), height: bh, rx: 2, fill: b.over ? 'var(--bad)' : o.color || 'var(--accent)', opacity: 0.85 }));
    });
    const xFmt = o.xFmt || fmtNum;
    [0, Math.floor(bins.length / 2), bins.length - 1].forEach((i) => svg.append(txt(padL + i * bw + bw / 2, H - 6, xFmt(bins[i].from), { 'text-anchor': 'middle' })));
    if (o.over && o.over.n) svg.append(txt(padL + bins.length * bw + bw / 2, H - 6, '>', { 'text-anchor': 'middle', fill: 'var(--bad)' }));
    const wrap = h('div', { class: 'cwrap' }, svg);
    const total = all.reduce((a, b) => a + b.n, 0) || 1;
    attachHover(wrap, svg, H, padL, pw, all.map((_, i) => i), (i) => padL + i * bw + bw / 2, (i) => {
      const b = all[i];
      return h('div', null, h('div', { class: 'ctip-h' }, b.over ? (o.over.label || '> ' + xFmt(b.from)) : xFmt(b.from) + ' – ' + xFmt(b.to)),
        h('div', null, h('b', null, b.n.toLocaleString()), ' samples (' + ((b.n / total) * 100).toFixed(2) + '%)'));
    });
    return wrap;
  };
})();
