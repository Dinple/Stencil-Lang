// Draws a resolved Stencil description (SPEC.md section 5).
// This file only reads the resolved form, the same way any consumer tool would.
//
// Layers are drawn the way textbook layout plates draw them: each layer has a
// colour and a hatch pattern, so overlapping layers stay readable.

import { expandSite } from '../core/template.js';

// ---- palettes ---------------------------------------------------------------------

const PALETTES = {
  light: {
    channel: '#2e7d32', gate: '#c62828', cut: '#1f1f1f',
    conductors: ['#1550a8', '#6a1b9a', '#a86b00', '#00796b', '#c43e00', '#33691e', '#ad1457', '#283593'],
    markers: ['#a66f00', '#7b1fa2', '#00838f', '#c2185b', '#558b2f'],
    bandN: '#edf3fc', bandP: '#fcefe9',
  },
  dark: {
    channel: '#66bb6a', gate: '#ef5350', cut: '#d6d2c8',
    conductors: ['#64a8f6', '#ce93d8', '#ffcc66', '#4dd0c1', '#ff8a65', '#aed581', '#f48fb1', '#9fa8da'],
    markers: ['#e3b341', '#b392f0', '#56d4dd', '#f778ba', '#a5d6a7'],
    bandN: 'rgba(100, 160, 255, 0.08)', bandP: 'rgba(255, 140, 100, 0.08)',
  },
};
const CONDUCTOR_PATTERNS = ['back', 'cross', 'horiz', 'vert', 'diag', 'grid'];

export function buildModel(res, theme = 'light') {
  const pal = PALETTES[theme] ?? PALETTES.light;
  const grid = parseQ(res.grid_nm) || 1;
  const objs = res.objects ?? [];
  const by = new Map();
  for (const o of objs) if (o.name) by.set(o.name, o);
  const of = (kind) => objs.filter((o) => o.kind === kind);
  const layers = of('layer').sort((a, b) => (a.attrs.order ?? 0) - (b.attrs.order ?? 0));
  const crosses = of('cross');
  const gateLayers = new Set(crosses.map((c) => refName(c.attrs.gate)).filter(Boolean));
  const style = new Map();
  // Routing metals (a pitch or tracks, not a gate, not in a stratum) are coloured in their own
  // order, so a metal keeps its colour whatever device tier sits under it; the other
  // conductors (local interconnect, contacts) take colours from the other end of the palette.
  const stratumLayers = new Set(of('stratum').flatMap((s) => (Array.isArray(s.attrs.layers) ? s.attrs.layers : []).map(refName)));
  const isMetal = (l) => (l.attrs.pitch !== undefined || l.attrs.tracks !== undefined) && !stratumLayers.has(l.name);
  let ci = 0, di = 0, mi = 0;
  for (const l of layers) {
    const role = l.attrs.role;
    if (gateLayers.has(l.name)) style.set(l.name, { color: pal.gate, pattern: 'diag' });
    else if (role === 'conductor' && isMetal(l)) { style.set(l.name, { color: pal.conductors[ci % 8], pattern: CONDUCTOR_PATTERNS[ci % 6] }); ci++; }
    else if (role === 'conductor') { style.set(l.name, { color: pal.conductors[(14 - (di % 8)) % 8], pattern: CONDUCTOR_PATTERNS[5 - (di % 6)] }); di++; }
    else if (role === 'channel') style.set(l.name, { color: pal.channel, pattern: 'dots' });
    else if (role === 'marker') style.set(l.name, { color: pal.markers[mi++ % 5], pattern: 'sparse' });
    else style.set(l.name, { color: pal.cut, pattern: 'xbox' });
  }
  const m = {
    pal, grid, by, objs, layers, crosses, gateLayers, style,
    color: new Map([...style].map(([k, v]) => [k, v.color])),
    arrays: of('array'), figures: of('figure'), sites: of('site'),
    strata: of('stratum'), connectors: of('connector'), rules: of('rule'), regions: of('region'),
    nm: (v) => (typeof v === 'number' ? v * grid : parseQ(v) * grid),
  };
  // Show the composite template if there is one (a site made of rows), else the first site.
  const sized = m.sites.filter((s) => typeof s.attrs.width === 'number' && typeof s.attrs.height === 'number');
  m.site = sized.find((s) => s.children.some((c) => c.kind === 'row')) ?? sized[0];
  // Bands, rails, tracks and edge features come from the same expansion every consumer uses.
  m.template = (units) => (m.site ? expandSite(res, m.site.name, { units }) : null);
  m.tpl = m.template(1);
  m.gateArray = m.arrays.find((a) => {
    const f = by.get(refName(a.attrs.of));
    return a.attrs.axis === 'x' && f && gateLayers.has(refName(f.attrs.layer));
  });
  m.cpp = m.gateArray ? m.nm(m.gateArray.attrs.pitch) : undefined;
  return m;
}

function parseQ(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+\/\d+$/.test(v)) { const [n, d] = v.split('/').map(Number); return n / d; }
  return NaN;
}

// Length options of a sized value: 12 -> [12]; one_of -> list; range -> [min, max].
function lenOptions(m, v) {
  if (v == null) return [];
  if (typeof v === 'number') return [m.nm(v)];
  if (typeof v !== 'object') return [];
  if (v.one_of) return v.one_of.map((x) => m.nm(x));
  if ('min' in v) return [m.nm(v.min), m.nm(v.max)];
  return [];
}
const isRange = (v) => v && typeof v === 'object' && 'min' in v;
const minLen = (m, v) => { const o = lenOptions(m, v); return o.length ? Math.min(...o) : undefined; };
const maxLen = (m, v) => { const o = lenOptions(m, v); return o.length ? Math.max(...o) : undefined; };

function countOf(v) {
  if (typeof v === 'number') return { n: v, min: v, max: v };
  if (v === 'fill') return { fill: true };
  if (v && typeof v === 'object' && 'min' in v) return { n: v.max, min: v.min, max: v.max };
  return { n: 1, min: 1, max: 1 };
}

const refName = (v) => (v && typeof v === 'object' && 'ref' in v ? v.ref : undefined);
const refList = (v) => (Array.isArray(v) ? v.map(refName) : [refName(v)]).filter(Boolean);
const fmt = (x) => `${+(+x).toFixed(2)}`;

// a/b as a small fraction when it is one (2/3, 3/2, 1), else a decimal.
function ratio(a, b) {
  if (!(a > 0 && b > 0)) return '';
  const r = a / b;
  for (let q = 1; q <= 8; q++) {
    const p = Math.round(r * q);
    if (p > 0 && Math.abs(r - p / q) < 1e-9) return q === 1 ? `${p}` : `${p}/${q}`;
  }
  return r.toFixed(2);
}

// ---- svg helpers -----------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function attrs(a) {
  return Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
}
// Top-view helpers use y-up layout coordinates.
function rect(x0, y0, x1, y1, a = {}, title) {
  const x = Math.min(x0, x1), w = Math.abs(x1 - x0);
  const yTop = -Math.max(y0, y1), h = Math.abs(y1 - y0);
  return `<rect${attrs({ x, y: yTop, width: w, height: h, ...a })}>${title ? `<title>${esc(title)}</title>` : ''}</rect>`;
}
function text(x, y, s, a = {}) { return `<text${attrs({ x, y: -y, ...a })}>${esc(s)}</text>`; }
function line(x0, y0, x1, y1, a = {}) { return `<line${attrs({ x1: x0, y1: -y0, x2: x1, y2: -y1, ...a })}/>`; }

const cssId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function patternSvg(id, kind, color, s) {
  const w = s * 0.13;
  const ln = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}"/>`;
  let body = '', rot = 0, bg = 0.1;
  switch (kind) {
    case 'diag': rot = 45; body = ln(0, 0, 0, s); break;
    case 'back': rot = -45; body = ln(0, 0, 0, s); break;
    case 'cross': rot = 45; body = ln(0, 0, 0, s) + ln(0, 0, s, 0); break;
    case 'horiz': body = ln(0, s / 2, s, s / 2); break;
    case 'vert': body = ln(s / 2, 0, s / 2, s); break;
    case 'grid': body = ln(0, 0, 0, s) + ln(0, 0, s, 0); break;
    case 'dots': body = `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.18}" fill="${color}"/>`; bg = 0.16; break;
    case 'sparse': body = `<circle cx="${s / 2}" cy="${s / 2}" r="${s * 0.13}" fill="${color}"/>`; bg = 0.06; break;
    default: body = ln(0, 0, s, s) + ln(s, 0, 0, s); bg = 0.18;
  }
  return `<pattern id="${id}" width="${s}" height="${s}" patternUnits="userSpaceOnUse"${rot ? ` patternTransform="rotate(${rot})"` : ''}>`
    + `<rect width="${s}" height="${s}" fill="${color}" fill-opacity="${bg}"/>${body}</pattern>`;
}

// Pixel-sized patterns for swatches, tables and cross-sections (ids sw-<layer>).
export function swatchDefs(m) {
  const defs = m.layers.map((l) => { const st = m.style.get(l.name); return patternSvg(`sw-${cssId(l.name)}`, st.pattern, st.color, 5); });
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${defs.join('')}</defs></svg>`;
}
const fillOf = (name) => `url(#sw-${cssId(name)})`;

export function swatch(m, name) {
  const st = m.style.get(name);
  if (!st) return '';
  return `<svg class="swatch" width="18" height="12" viewBox="0 0 18 12"><rect x="0.75" y="0.75" width="16.5" height="10.5" fill="${fillOf(name)}" stroke="${st.color}" stroke-width="1.5"/></svg>`;
}

// ---- geometry (template-level evaluation of `from` expressions) --------------

function geomRects(m, ctx, expr, depth = 0) {
  if (depth > 8 || expr == null) return null;
  if (typeof expr === 'object' && 'ref' in expr) {
    const o = m.by.get(expr.ref);
    if (!o) return null;
    if ((o.kind === 'layer' && o.attrs.from) || o.kind === 'region') return geomRects(m, ctx, o.attrs.from, depth + 1);
    if (o.kind === 'layer') {
      const stripes = ctx.stripes.filter((s) => s.layer === o.name && !s.outline);
      return stripes.length ? stripes.map((s) => ({ ...s })) : null;
    }
    return null;
  }
  if (typeof expr !== 'object' || !expr.call) return null;
  const args = expr.args ?? [];
  const sub = (i) => geomRects(m, ctx, args[i], depth + 1);
  switch (expr.call) {
    case 'band': return ctx.bands.filter((b) => b.pol === args[0]).map((b) => ({ x0: 0, y0: b.lo, x1: ctx.X, y1: b.hi }));
    case 'grow':
    case 'shrink': {
      const r = sub(0);
      const d = (expr.call === 'grow' ? 1 : -1) * m.nm(args[1]);
      if (!r || !Number.isFinite(d)) return null;
      return r.map((q) => ({ x0: q.x0 - d, y0: q.y0 - d, x1: q.x1 + d, y1: q.y1 + d })).filter((q) => q.x1 > q.x0 && q.y1 > q.y0);
    }
    case 'union': {
      const parts = args.map((_, i) => sub(i));
      return parts.some((p) => !p) ? null : parts.flat();
    }
    case 'intersect': {
      let acc = sub(0);
      for (let i = 1; acc && i < args.length; i++) {
        const b = sub(i);
        if (!b) return null;
        acc = acc.flatMap((p) => b.map((q) => ({ x0: Math.max(p.x0, q.x0), y0: Math.max(p.y0, q.y0), x1: Math.min(p.x1, q.x1), y1: Math.min(p.y1, q.y1) })))
          .filter((q) => q.x1 > q.x0 && q.y1 > q.y0);
      }
      return acc;
    }
    case 'gaps': {
      const r = sub(0);
      if (!r) return null;
      const axis = args[1] ?? 'x';
      const s = [...r].sort((a, b) => (axis === 'x' ? a.x0 - b.x0 : a.y0 - b.y0));
      const out = [];
      for (let i = 0; i + 1 < s.length; i++) {
        if (axis === 'x' && s[i + 1].x0 > s[i].x1) out.push({ x0: s[i].x1, y0: 0, x1: s[i + 1].x0, y1: ctx.H });
        if (axis === 'y' && s[i + 1].y0 > s[i].y1) out.push({ x0: 0, y0: s[i].y1, x1: ctx.X, y1: s[i + 1].y0 });
      }
      return out;
    }
    default: return null;
  }
}

export function formatExpr(m, e) {
  if (e == null) return '';
  if (typeof e === 'number') return `${fmt(m.nm(e))}nm`;
  if (typeof e !== 'object') return String(e);
  if (Array.isArray(e)) return `[${e.map((x) => formatExpr(m, x)).join(', ')}]`;
  if ('call' in e) return `${e.call}(${(e.args ?? []).map((x) => (typeof x === 'string' ? x : formatExpr(m, x))).join(', ')})`;
  if ('ref' in e) return e.attr ? `${e.ref}.${e.attr}` : e.ref;
  return JSON.stringify(e);
}

// ---- top view ------------------------------------------------------------------

function bandsOf(m) {
  return (m.tpl?.bands ?? []).map((b) => ({ pol: b.polarity, name: b.name, lo: m.nm(b.y0), hi: m.nm(b.y1), stratum: b.stratum, src: b.src }));
}

export function renderTop(m, hidden = new Set()) {
  const site = m.site;
  const pitches = m.layers.map((l) => m.nm(l.attrs.pitch)).filter((p) => p > 0);
  const W = site ? m.nm(site.attrs.width) : Math.max(40, ...pitches.map((p) => p * 2));
  const H = site ? m.nm(site.attrs.height) : Math.max(240, ...pitches.map((p) => p * 6));
  if (!(W > 0 && H > 0)) return { svg: emptySvg('site needs a positive width and height'), legend: [] };
  const cols = Math.max(1, Math.min(24, Math.round((1.5 * H) / W)));
  const X = cols * W;
  const fs = Math.max(H, X / 2) * 0.034;
  const ps = fs * 0.62;                                   // hatch pattern size
  const out = [];
  const legend = new Map();
  const use = (name) => { if (name && m.style.has(name)) legend.set(name, true); return !hidden.has(name); };
  const fill = (name) => `url(#tp-${cssId(name)})`;

  const bands = bandsOf(m);
  for (const b of bands) {
    const label = b.name === b.pol ? b.pol : `${b.name} (${b.pol})`;
    // bands of several strata may overlap: indent each stratum's labels
    const col = [...new Set(bands.map((x) => x.stratum))].indexOf(b.stratum);
    out.push(rect(0, b.lo, X, b.hi, { fill: b.pol === 'p' ? m.pal.bandP : m.pal.bandN, 'data-src': b.src, 'data-obj': `${site.name}.${b.name}` },
      `band ${label}, ${b.stratum ?? ''}, y ${fmt(b.lo)}-${fmt(b.hi)}nm`));
    out.push(text(X + fs * 0.8 + col * fs * 7, (b.lo + b.hi) / 2, label, { class: `band-label band-label-${b.pol}`, 'font-size': fs * (bands.length > 2 ? 1 : 1.5), 'dominant-baseline': 'middle' }));
  }

  // Stripes from arrays (gate grid, fins) and channel strips from crosses
  const stripes = [];
  for (const a of m.arrays) {
    const fig = m.by.get(refName(a.attrs.of));
    const layerName = refName(fig?.attrs.layer);
    const pitch = m.nm(a.attrs.pitch), off = m.nm(a.attrs.offset ?? 0);
    const w = maxLen(m, fig?.attrs.width);
    if (!fig || !layerName || !(pitch > 0) || !(w > 0)) continue;
    const c = countOf(a.attrs.count);
    if (a.attrs.axis === 'x') {
      const n = c.fill ? Math.floor((X - off) / pitch) + 1 : c.n;
      for (let k = 0; k < Math.min(n, 2000); k++) {
        const x = off + k * pitch;
        if (x > X + 1e-9) break;
        stripes.push({ layer: layerName, x0: x - w / 2, y0: 0, x1: x + w / 2, y1: H, obj: a.name, src: a.src, title: `${a.name}[${k}], ${fig.name} on ${layerName}, pitch ${fmt(pitch)}nm` });
      }
    } else if (a.attrs.axis === 'y') {
      for (const b of bands.length ? bands : [{ lo: 0, hi: H }]) {
        const n = c.fill ? Math.floor((b.hi - b.lo - off) / pitch) + 1 : c.max;
        for (let k = 0; k < Math.min(n, 500); k++) {
          const y = b.lo + off + k * pitch;
          if (y > b.hi) break;
          stripes.push({ layer: layerName, x0: 0, y0: y - w / 2, x1: X, y1: y + w / 2, obj: a.name, src: a.src, ghost: c.min !== undefined && k >= c.min,
            title: `${a.name}[${k}], ${fig.name}, count ${c.min === c.max ? c.n : `${c.min}..${c.max}`} (sizing knob)` });
        }
      }
    }
  }
  for (const x of m.crosses) {
    let ch = m.by.get(refName(x.attrs.channel));
    if (ch?.kind === 'array') { if (ch.attrs.axis !== 'z') continue; ch = m.by.get(refName(ch.attrs.of)); }
    if (ch?.kind !== 'figure') continue;
    const opts = lenOptions(m, ch.attrs.width).sort((a, b) => b - a);
    const layerName = refName(ch.attrs.layer);
    for (const b of bands.length ? bands : [{ lo: 0, hi: H }]) {
      const mid = (b.lo + b.hi) / 2;
      opts.forEach((w, i) => stripes.push({
        layer: layerName, x0: 0, y0: mid - w / 2, x1: X, y1: mid + w / 2, obj: ch.name, src: ch.src, outline: i > 0,
        title: `${ch.name} on ${layerName}, width ${fmt(w)}nm${opts.length > 1 ? ` (${isRange(ch.attrs.width) ? 'range' : 'one of'} ${opts.map(fmt).join(', ')})` : ''}`,
      }));
    }
  }

  const ctx = { X, H, bands, stripes };

  for (const l of m.layers) {
    const col = m.style.get(l.name).color;
    if (l.attrs.from) {
      const rects = geomRects(m, ctx, l.attrs.from);
      if (rects && use(l.name)) {
        for (const r of rects) {
          out.push(rect(r.x0, r.y0, r.x1, r.y1, { class: 'derived', fill: fill(l.name), stroke: col, 'data-src': l.src, 'data-obj': l.name },
            `${l.name} = ${formatExpr(m, l.attrs.from)} (derived)`));
        }
      }
      continue;
    }
    for (const s of stripes.filter((s) => s.layer === l.name)) {
      if (!use(l.name)) break;
      out.push(rect(s.x0, s.y0, s.x1, s.y1, {
        class: `stripe${s.ghost ? ' ghost' : ''}${s.outline ? ' outline' : ''}`, fill: s.outline ? 'none' : fill(l.name), stroke: col,
        'data-src': s.src, 'data-obj': s.obj,
      }, s.title));
    }
    const tr = trackSpec(m, l);
    const local = (m.tpl?.tracks ?? []).filter((t) => t.layer === l.name);
    // the cell's own grids take precedence, whether or not the layer has a global pitch
    if (local.length && use(l.name)) out.push(...drawLocalTracks(m, l, tr, local, X, H, col, fs, fill(l.name)));
    else if (tr && use(l.name)) out.push(...drawTracks(m, l, tr, X, H, col, fs, fill(l.name)));
  }

  for (const r of m.tpl?.rails ?? []) {
    const ln = r.layer;
    const w = r.width !== undefined ? m.nm(r.width) : H * 0.06;
    const y = m.nm(r.y);
    if (!use(ln)) continue;
    const short = r.name.split('.').pop();
    const label = r.net === short ? r.net : `${short} (${r.net})`;
    out.push(rect(0, y - w / 2, X, y + w / 2, { class: 'rail', fill: m.style.has(ln) ? fill(ln) : 'none', stroke: m.color.get(ln) ?? 'currentColor', 'data-src': r.src, 'data-obj': `${site.name}.${r.name}` },
      `rail ${r.name}, net ${r.net} on ${ln}, y ${fmt(y)}nm, width ${fmt(w)}nm${r.shared ? `, shared by ${r.shared.join(', ')}` : ''}`));
    out.push(text(-fs * 0.5, y, label, { class: 'rail-label', 'font-size': fs, 'text-anchor': 'end', 'dominant-baseline': 'middle' }));
  }
  // Cell-edge features, at the edges of the drawn row of sites
  for (const e of m.template(cols)?.edges ?? []) {
    if (!use(e.layer)) continue;
    out.push(rect(m.nm(e.x0), m.nm(e.y0), m.nm(e.x1), m.nm(e.y1), { class: 'edge-feature', fill: m.style.has(e.layer) ? fill(e.layer) : 'none', stroke: m.color.get(e.layer) ?? 'currentColor', 'data-src': e.src, 'data-obj': `${site.name}.${e.name}` },
      `edge feature ${e.name} on ${e.layer}, ${e.side}${e.shared ? ', shared with the neighbour' : ''}`));
  }

  if (site) {
    for (let k = 0; k < cols; k++) {
      out.push(rect(k * W, 0, (k + 1) * W, H, { class: k === 0 ? 'site site-first' : 'site', 'data-src': site.src, 'data-obj': site.name },
        `site ${site.name}, ${fmt(W)} x ${fmt(H)}nm`));
    }
    const dy = H + fs * 1.6;
    out.push(line(0, dy, W, dy, { class: 'dim' }), text(W / 2, dy + fs * 0.5, `${fmt(W)}nm`, { class: 'dim-label', 'font-size': fs, 'text-anchor': 'middle' }));
    const dx = -fs * 3.6;
    out.push(line(dx, 0, dx, H, { class: 'dim' }),
      `<text class="dim-label" font-size="${fs}" text-anchor="middle" transform="translate(${dx - fs * 0.5} ${-H / 2}) rotate(-90)">${fmt(H)}nm</text>`);
    out.push(text(0, H + fs * 3.2, site.name, { class: 'site-label', 'font-size': fs * 1.1 }));
  }

  const pad = fs * 5;
  const defs = m.layers.map((l) => { const st = m.style.get(l.name); return patternSvg(`tp-${cssId(l.name)}`, st.pattern, st.color, ps); }).join('');
  const vb = [-pad, -(H + pad), X + pad * 2, H + pad * 2];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" preserveAspectRatio="xMidYMid meet"><defs>${defs}</defs>${out.join('')}</svg>`;
  return { svg, legend: [...legend.keys()].map((name) => ({ name, color: m.color.get(name), swatch: swatch(m, name), src: m.by.get(name)?.src })), viewBox: vb };
}

function trackSpec(m, l) {
  const trRef = m.by.get(refName(l.attrs.tracks));
  if (trRef?.kind === 'array') {
    const fig = m.by.get(refName(trRef.attrs.of));
    return { axis: trRef.attrs.axis, pitch: m.nm(trRef.attrs.pitch), offset: m.nm(trRef.attrs.offset ?? 0), width: minLen(m, fig?.attrs.width), src: trRef.src, obj: trRef.name };
  }
  if (l.attrs.pitch === undefined) return null;
  const dir = l.attrs.direction;
  const axis = dir === 'horizontal' ? 'y' : dir === 'vertical' ? 'x' : 'both';
  return { axis, pitch: m.nm(l.attrs.pitch), offset: m.nm(l.attrs.offset ?? 0), width: minLen(m, l.attrs.width), src: l.src, obj: l.name };
}

// In-cell tracks from the expanded template (VOCABULARY.md: index k from 0, per row).
function drawLocalTracks(m, l, tr, grids, X, H, col, fs, fillUrl) {
  const out = [];
  const Wsite = m.nm(m.tpl.width);
  for (const g of grids) {
    const pts = g.positions.map((p) => m.nm(p));
    const gaps = pts.slice(1).map((p, i) => Math.abs(p - pts[i])).filter((d) => d > 0);
    // the declared wire width (track array figure, else the layer's); guess only when unknown
    const known = tr?.width > 0 ? tr.width : minLen(m, l.attrs.width);
    const w = known > 0 ? known : (gaps.length ? Math.min(...gaps) : H / 8) * 0.35;
    const used = new Set(g.use);
    pts.forEach((p, k) => {
      const on = used.has(k);
      const title = `${g.name} track ${k} on ${l.name}, ${g.axis} = ${fmt(p)}nm, width ${fmt(w)}nm${on ? ', signal track' : ', not a signal track'}`;
      const a = { class: `track${on ? '' : ' track-off'}`, fill: on ? fillUrl : 'none', stroke: col, 'data-src': g.src, 'data-obj': l.name };
      if (g.axis === 'y') out.push(rect(0, p - w / 2, X, p + w / 2, a, title));
      else {
        const [y0, y1] = (g.span ?? [0, m.tpl.height]).map((v) => m.nm(v));   // only across the row it belongs to
        for (let c = 0; c * Wsite < X - 1e-9; c++) out.push(rect(c * Wsite + p - w / 2, y0, c * Wsite + p + w / 2, y1, a, title));
      }
    });
    if (g.axis === 'y' && pts.length) out.push(text(X + fs * 2.4, pts[0], g.name, { class: 'track-label', fill: col, 'font-size': fs * 0.8, 'dominant-baseline': 'middle' }));
  }
  return out;
}
function usedTracks(m, layerName) {
  return m.tpl?.tracks.find((t) => t.layer === layerName)?.use;
}
function isUsed(used, idx) {
  if (used === undefined) return true;
  if (Array.isArray(used)) return used.includes(idx);
  return idx >= used.min && idx <= used.max;
}

function drawTracks(m, l, tr, X, H, col, fs, fillUrl) {
  if (!(tr.pitch > 0)) return [];
  const w = tr.width > 0 ? tr.width : tr.pitch * 0.35;
  const used = undefined;
  const out = [];
  for (const axis of tr.axis === 'both' ? ['x', 'y'] : [tr.axis]) {
    const extent = axis === 'y' ? H : X;
    for (let k = 0, p = tr.offset; p <= extent + 1e-9 && k < 4000; k++, p += tr.pitch) {
      const idx = k;
      const on = isUsed(used, idx);
      const title = `${l.name} track ${idx}, width ${fmt(w)}nm, pitch ${fmt(tr.pitch)}nm${used !== undefined ? (on ? ', signal track' : ', not a signal track') : ''}`;
      const a = { class: `track${on ? '' : ' track-off'}`, fill: on ? fillUrl : 'none', stroke: col, 'data-src': tr.src, 'data-obj': tr.obj };
      if (axis === 'y') {
        out.push(rect(0, p - w / 2, X, p + w / 2, a, title));
        if (k === 0) out.push(text(X + fs * 2.4, p, l.name, { class: 'track-label', fill: col, 'font-size': fs * 0.8, 'dominant-baseline': 'middle' }));
      } else {
        out.push(rect(p - w / 2, 0, p + w / 2, H, a, title));
        if (k === 0) out.push(text(p, -fs * 1.1, l.name, { class: 'track-label', fill: col, 'font-size': fs * 0.8, 'text-anchor': 'middle' }));
      }
    }
  }
  return out;
}

// ---- stack view (HTML table) ---------------------------------------------------

const RULE_SHORT = { width: 'width', spacing: 'space', enclosure: 'encl', extension: 'ext', area: 'area', eol_spacing: 'eol', cut_spacing: 'cut-space', min_length: 'min-len' };

function ruleText(m, r) {
  const v = (x) => (typeof x === 'number' ? fmt(m.nm(x)) : String(x ?? '?'));
  const cond = [];
  if (r.attrs.same_color) cond.push('same color');
  if (r.attrs.width_below !== undefined) cond.push(`w<${v(r.attrs.width_below)}`);
  if (r.attrs.width_above !== undefined) cond.push(`w>${v(r.attrs.width_above)}`);
  if (r.attrs.prl !== undefined) cond.push(`prl>=${v(r.attrs.prl)}`);
  if (r.attrs.within !== undefined) cond.push(`within ${v(r.attrs.within)}`);
  if (r.attrs.same_net) cond.push('same net');
  let val = r.attrs.value !== undefined ? v(r.attrs.value) : '';
  const cases = r.children.filter((c) => c.kind === 'case');
  if (cases.length) val = cases.map((c) => `${c.name.replace('_', ' ')} ${v(c.attrs.value)}`).join(' / ');
  if (r.children.some((c) => c.kind === 'table')) val = 'table';
  return `${RULE_SHORT[r.attrs.kind] ?? r.attrs.kind} ${val}${cond.length ? ` (${cond.join(', ')})` : ''}${r.attrs.intent === 'generator' ? ', gen' : ''}`;
}

export function renderStack(m) {
  const drawn = m.layers.filter((l) => !l.attrs.from);
  const derived = m.layers.filter((l) => l.attrs.from);
  if (!drawn.length) return `<p class="empty">No layers yet, try <code>layer M0 { role = conductor }</code></p>`;

  const order = new Map(drawn.map((l, i) => [l.name, i]));   // bottom = 0
  // Connector "subway" columns
  const cons = m.connectors.map((c) => {
    const lows = refList(c.attrs.lower).filter((n) => order.has(n));
    const up = refName(c.attrs.upper);
    const cut = refName(c.attrs.cut);
    if (!lows.length || !order.has(up)) return null;
    return { c, lows, up, cut, lo: Math.min(...lows.map((n) => order.get(n))), hi: order.get(up) };
  }).filter(Boolean);
  const cw = 12;
  const subwayW = Math.max(1, cons.length) * cw + 6;

  // Strata / sides
  const stratumOf = new Map();
  for (const s of m.strata) for (const n of refList(s.attrs.layers)) stratumOf.set(n, s);
  const devIdx = drawn.map((l, i) => (stratumOf.has(l.name) ? i : -1)).filter((i) => i >= 0);
  const devLo = devIdx.length ? Math.min(...devIdx) : -1, devHi = devIdx.length ? Math.max(...devIdx) : -1;
  const side = (i) => (devLo < 0 ? '' : i < devLo ? 'back side' : i > devHi ? 'front side' : 'device');

  const site = m.site;
  const H = site ? m.nm(site.attrs.height) : undefined;
  const Wsite = site ? m.nm(site.attrs.width) : undefined;
  const rows = [];
  let lastSide = null;
  for (let i = drawn.length - 1; i >= 0; i--) {
    const l = drawn[i];
    const sd = side(i);
    if (sd !== lastSide && sd) {
      const label = sd === 'device'
        ? `device tier, ${[...new Set(drawn.filter((d) => stratumOf.has(d.name)).map((d) => stratumOf.get(d.name).name))].map((n) => `${n} (${(m.by.get(n)?.attrs.polarity ?? []).join(' ')})`).join(', ')}`
        : sd;
      rows.push(`<tr class="group"><td colspan="11">${esc(label)}</td></tr>`);
      lastSide = sd;
    }
    const a = l.attrs;
    const dir = { horizontal: '↔', vertical: '↕', none: '✛' }[a.direction] ?? '';
    const pitch = a.pitch !== undefined ? m.nm(a.pitch) : (() => { const t = m.by.get(refName(a.tracks)); return t ? m.nm(t.attrs.pitch) : undefined; })();
    const pitchTxt = pitch ? `${fmt(pitch)}${m.cpp && a.direction === 'vertical' && !m.gateLayers.has(l.name) ? ` <span class="rel">${ratio(pitch, m.cpp)}*CPP</span>` : ''}` : '';
    const gateArr = m.gateLayers.has(l.name) && m.gateArray ? `${fmt(m.cpp)} <span class="rel">CPP</span>` : '';
    const ws = lenOptions(m, a.width);
    const widthTxt = ws.length ? ws.map(fmt).join(isRange(a.width) ? '-' : ' | ') : '';
    let tracks = '';
    if (pitch && site) {
      if (a.direction === 'horizontal') {
        const off = m.nm(a.offset ?? 0);
        const n = Math.floor((H - off) / pitch + 1e-9) + 1;
        const used = usedTracks(m, l.name);
        const sig = used === undefined ? '' : Array.isArray(used) ? `, ${used.length} signal` : `, ${used.max - used.min + 1} signal`;
        tracks = `${n} / row${sig}`;
      } else if (a.direction === 'vertical') {
        tracks = `${ratio(Wsite, pitch)} / site`;
      }
    }
    const vias = [];
    for (const k of cons) {
      if (k.lows.includes(l.name)) vias.push(`↑ ${k.c.name} -> ${k.up}`);
      if (k.cut === l.name) {
        const sz = k.c.attrs.size;
        const s = Array.isArray(sz) ? `${fmt(m.nm(sz[0]))}x${fmt(m.nm(sz[1]))}` : sz !== undefined ? `${fmt(m.nm(sz))}x${fmt(m.nm(sz))}` : '';
        vias.push(`${k.c.name} ${s}`);
      }
    }
    const rules = m.rules.filter((r) => refList(r.attrs.on).includes(l.name)).map((r) => ruleText(m, r));
    const gds = Array.isArray(a.gds) ? a.gds.join('/') : '';

    // subway cell
    const segs = cons.map((k, ci) => {
      const x = 4 + ci * cw + cw / 2;
      const col = 'var(--ink-2)';
      let s = '';
      if (i > k.lo && i < k.hi) s += `<line x1="${x}" y1="0" x2="${x}" y2="100%" stroke="${col}" stroke-width="2"/>`;
      if (i === k.hi) s += `<line x1="${x}" y1="50%" x2="${x}" y2="100%" stroke="${col}" stroke-width="2"/><circle cx="${x}" cy="50%" r="3.2" fill="${col}"/>`;
      if (i === k.lo || (k.lows.includes(l.name) && i !== k.hi)) {
        if (i === k.lo) s += `<line x1="${x}" y1="0" x2="${x}" y2="50%" stroke="${col}" stroke-width="2"/>`;
        s += `<circle cx="${x}" cy="50%" r="3.2" fill="var(--paper)" stroke="${col}" stroke-width="1.6"/>`;
      }
      if (k.cut === l.name) s += `<rect x="${x - 3.5}" y="50%" width="7" height="7" transform="translate(0 -3.5)" fill="${col}"/>`;
      return s ? `<g data-obj="${esc(k.c.name)}" data-src="${esc(k.c.src)}"><title>${esc(`${k.c.name}: ${k.lows.join(' | ')} -> ${k.cut ?? 'no cut'} -> ${k.up}`)}</title>${s}</g>` : '';
    }).join('');

    rows.push(`<tr data-obj="${esc(l.name)}" data-src="${esc(l.src)}" class="role-${esc(a.role)}${l.invalid ? ' invalid' : ''}">
      <td class="num">${a.order ?? ''}</td>
      <td class="subway" style="width:${subwayW}px;min-width:${subwayW}px"><svg width="${subwayW}">${segs}</svg></td>
      <td class="name">${swatch(m, l.name)}<b>${esc(l.name)}</b></td>
      <td>${esc(a.role ?? '')}</td>
      <td class="c">${dir}</td>
      <td class="r">${gateArr || pitchTxt}</td>
      <td class="r">${esc(widthTxt)}</td>
      <td>${esc(tracks)}</td>
      <td class="c">${a.masks > 1 ? `<b>${a.masks}</b>` : (a.role === 'conductor' ? '1' : '')}</td>
      <td class="c dim">${esc(gds)}</td>
      <td class="notes">${[...vias, ...rules].map((t) => `<span>${esc(t)}</span>`).join('')}</td>
    </tr>`);
  }

  const facts = [];
  if (m.cpp) {
    for (const l of drawn) {
      const p = l.attrs.pitch !== undefined ? m.nm(l.attrs.pitch) : undefined;
      if (l.attrs.direction === 'vertical' && p && !m.gateLayers.has(l.name)) {
        const r = ratio(m.cpp, p);
        facts.push(`gear ratio ${l.name} : gate = ${r.includes('/') ? r.replace('/', ' : ') : `${r} : 1`}`);
      }
    }
  }
  if (site) {
    const h = drawn.find((l) => l.attrs.direction === 'horizontal' && l.attrs.pitch !== undefined);
    if (h) facts.push(`row height ${fmt(H)}nm = ${ratio(H, m.nm(h.attrs.pitch))} x ${h.name} pitch`);
  }
  const derivedTxt = derived.map((l) => `<span data-obj="${esc(l.name)}" data-src="${esc(l.src)}">${swatch(m, l.name)}<b>${esc(l.name)}</b> = ${esc(formatExpr(m, l.attrs.from))}</span>`);
  const regionTxt = m.regions.map((r) => `<span data-obj="${esc(r.name)}" data-src="${esc(r.src)}"><b>${esc(r.name)}</b> = ${esc(formatExpr(m, r.attrs.from))} <i>(region)</i></span>`);

  return `<table class="stack-table">
    <thead><tr><th>#</th><th>vias</th><th>layer</th><th>role</th><th>dir</th><th class="r">pitch</th><th class="r">width</th><th>tracks</th><th>masks</th><th>gds</th><th>connections &amp; rules</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    ${facts.length ? `<p class="facts">${facts.map(esc).join(', ')}</p>` : ''}
    ${derivedTxt.length || regionTxt.length ? `<p class="derived-list">${[...derivedTxt, ...regionTxt].join('')}</p>` : ''}`;
}

// ---- device view (HTML cards with cross-sections) -------------------------------

export function renderDevice(m) {
  if (!m.crosses.length) return `<p class="empty">No transistors yet. Level 1 adds <code>figure</code>, <code>array</code> and <code>cross</code>, load "Level 1, nanosheet" from Examples.</p>`;
  return m.crosses.slice(0, 4).map((x) => deviceCard(m, x)).join('');
}

function channelOf(m, x) {
  let ch = m.by.get(refName(x.attrs.channel));
  let arr = null;
  if (ch?.kind === 'array') { arr = ch; ch = m.by.get(refName(arr.attrs.of)); }
  return ch?.kind === 'figure' ? { ch, arr } : null;
}

function deviceCard(m, x) {
  const got = channelOf(m, x);
  const head = `<h4 data-obj="${esc(x.name)}" data-src="${esc(x.src)}">cross <b>${esc(x.name)}</b> <span>gate ${esc(refName(x.attrs.gate) ?? '?')}, channel ${esc(refName(x.attrs.channel) ?? '?')}</span></h4>`;
  if (!got) return `<section class="device-card">${head}<p class="empty">channel must name a figure or an array of one</p></section>`;
  const { ch, arr } = got;
  const widths = lenOptions(m, ch.attrs.width);
  if (!widths.length) return `<section class="device-card">${head}<p class="empty">${esc(ch.name)} needs a width</p></section>`;
  const faces = x.attrs.faces === 'all' ? ['top', 'bottom', 'left', 'right'] : (Array.isArray(x.attrs.faces) ? x.attrs.faces : []);
  const hasT = ch.attrs.thickness !== undefined;
  const T = hasT ? m.nm(ch.attrs.thickness) : Math.max(...widths) * 0.12;
  const c = arr ? countOf(arr.attrs.count) : { n: 1, min: 1, max: 1 };
  const gateFig = m.gateArray ? m.by.get(refName(m.gateArray.attrs.of)) : m.figures.find((f) => refName(f.attrs.layer) === refName(x.attrs.gate));
  const Lg = minLen(m, gateFig?.attrs.width);

  const across = acrossView(m, x, ch, arr, widths, faces, T, c);
  const along = alongView(m, x, ch, arr, faces, T, c, Lg);

  // W_eff table
  const per = (w) => (faces.includes('top') ? w : 0) + (faces.includes('bottom') ? w : 0) + (faces.includes('left') ? T : 0) + (faces.includes('right') ? T : 0);
  const nw = ['top', 'bottom'].filter((f) => faces.includes(f)).length;
  const nt = ['left', 'right'].filter((f) => faces.includes(f)).length;
  const perTxt = [nw ? (nw > 1 ? `${nw}W` : 'W') : '', nt ? (nt > 1 ? `${nt}T` : 'T') : ''].filter(Boolean).join(' + ') || '0';
  const formula = arr ? `W<sub>eff</sub> = ${c.fill ? 'n' : c.min === c.max ? c.n : 'n'} x (${perTxt})` : `W<sub>eff</sub> = ${perTxt}`;
  const sizes = x.children.filter((k) => k.kind === 'size');
  const knobName = (ref, attr) => sizes.find((s) => s.attrs.sets?.ref === ref && s.attrs.sets?.attr === attr)?.name;
  const counts = c.fill ? [1] : Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i);
  let table;
  if (isRange(ch.attrs.width)) {
    const kn = knobName(ch.name, 'width') ?? 'W';
    table = `<tr><th>${esc(kn)} (nm)</th><td>${fmt(widths[0])}</td><td>...</td><td>${fmt(widths[1])}</td></tr>
             <tr><th>W<sub>eff</sub> (nm)</th><td>${fmt(counts[0] * per(widths[0]))}</td><td>...</td><td>${fmt(counts[counts.length - 1] * per(widths[1]))}</td></tr>`;
  } else if (counts.length > 1 && widths.length > 1) {
    const kc = knobName(arr.name, 'count') ?? 'n';
    const kw = knobName(ch.name, 'width') ?? 'W';
    table = `<tr><th>${esc(kc)} \\ ${esc(kw)}</th>${widths.map((w) => `<th>${fmt(w)}</th>`).join('')}</tr>`
      + counts.map((n) => `<tr><th>${n}</th>${widths.map((w) => `<td>${fmt(n * per(w))}</td>`).join('')}</tr>`).join('');
  } else if (counts.length > 1) {
    const kc = knobName(arr.name, 'count') ?? 'n';
    table = `<tr><th>${esc(kc)}</th>${counts.map((n) => `<td>${n}</td>`).join('')}</tr><tr><th>W<sub>eff</sub> (nm)</th>${counts.map((n) => `<td>${fmt(n * per(widths[0]))}</td>`).join('')}</tr>`;
  } else {
    const kw = knobName(ch.name, 'width') ?? 'W';
    table = `<tr><th>${esc(kw)} (nm)</th>${widths.map((w) => `<td>${fmt(w)}</td>`).join('')}</tr><tr><th>W<sub>eff</sub> (nm)</th>${widths.map((w) => `<td>${fmt(counts[0] * per(w))}</td>`).join('')}</tr>`;
  }

  // Checks against the cell template
  const checks = [];
  const ok = (cond, txt) => checks.push(`<li class="${cond ? 'ok' : 'bad'}">${cond ? 'OK' : 'NO'}: ${txt}</li>`);
  for (const b of bandsOf(m)) {
    const hb = b.hi - b.lo;
    const fins = arr?.attrs.axis === 'y' && !c.fill;
    const need = fins ? m.nm(arr.attrs.offset ?? 0) + (c.max - 1) * m.nm(arr.attrs.pitch) + Math.max(...widths) / 2 : Math.max(...widths);
    ok(need <= hb + 1e-9, `${fins ? `${c.max} fins fit` : `widest channel fits`} the ${b.pol} band (${fmt(need)} / ${fmt(hb)}nm)`);
  }
  if (Lg && m.cpp) ok(Lg < m.cpp, `gate ${fmt(Lg)}nm leaves ${fmt(m.cpp - Lg)}nm for S/D at CPP ${fmt(m.cpp)}nm`);
  for (const k of m.connectors) {
    if (!refList(k.attrs.lower).includes(refName(x.attrs.gate))) continue;
    const sz = Array.isArray(k.attrs.size) ? m.nm(k.attrs.size[0]) : k.attrs.size !== undefined ? m.nm(k.attrs.size) : undefined;
    if (sz && Lg) checks.push(`<li class="info">* gate contact ${esc(k.name)}: ${fmt(sz)}nm cut on a ${fmt(Lg)}nm gate${sz > Lg ? ' (wider than the gate)' : ''}</li>`);
  }
  const strata = m.strata.filter((s) => refList(s.attrs.layers).includes(refName(ch.attrs.layer)));
  if (strata.length) checks.push(`<li class="info">* polarities ${strata.map((s) => `${esc(s.name)}: ${(s.attrs.polarity ?? []).join(', ')}`).join('; ')}</li>`);

  return `<section class="device-card">${head}
    <div class="dev-figs">${across}${along}
      <div class="dev-data">
        <p class="formula">${formula}${hasT ? `, T = ${fmt(T)}nm` : ''}</p><table class="sizing">${table}</table>
        ${sizes.length ? `<p class="dim">netlist ${sizes.map((s) => `${esc(s.name)} -> ${esc(s.attrs.sets?.ref)}.${esc(s.attrs.sets?.attr)}`).join(', ')}</p>` : ''}
        <ul class="checks">${checks.join('')}</ul>
      </div>
    </div></section>`;
}

// Dimension lines in pixel space (y down).
function dimH(x1, x2, y, label) {
  return `<g class="dimline"><line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line x1="${x1}" y1="${y - 4}" x2="${x1}" y2="${y + 4}"/><line x1="${x2}" y1="${y - 4}" x2="${x2}" y2="${y + 4}"/>`
    + `<text x="${(x1 + x2) / 2}" y="${y - 5}" text-anchor="middle">${esc(label)}</text></g>`;
}
function dimV(y1, y2, x, label, left = false) {
  return `<g class="dimline"><line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/><line x1="${x - 4}" y1="${y1}" x2="${x + 4}" y2="${y1}"/><line x1="${x - 4}" y1="${y2}" x2="${x + 4}" y2="${y2}"/>`
    + `<text x="${left ? x - 6 : x + 6}" y="${(y1 + y2) / 2}" text-anchor="${left ? 'end' : 'start'}" dominant-baseline="middle">${esc(label)}</text></g>`;
}

function acrossView(m, x, ch, arr, widths, faces, T, c) {
  const W = Math.max(...widths);
  const n = c.fill ? 1 : c.max;
  const pitch = arr ? m.nm(arr.attrs.pitch) : 0;
  const axis = arr?.attrs.axis;
  const shapes = [];
  for (let k = 0; k < n; k++) {
    if (axis === 'y') shapes.push({ u: k * pitch, v: 0, ghost: k >= c.min });
    else if (axis === 'z') shapes.push({ u: 0, v: k * pitch, ghost: k >= c.min });
    else shapes.push({ u: 0, v: 0, ghost: false });
  }
  const uMax = Math.max(...shapes.map((s) => s.u)) + W;
  const vMax = Math.max(...shapes.map((s) => s.v)) + T;
  const scale = Math.min(180 / uMax, 105 / vMax);
  const g = Math.max(3, Math.min(W, T) * 0.4 * scale);
  const ox = 52, oy = 34;
  const H = vMax * scale + 2 * g;
  const Y = (v) => oy + H - g - v * scale;
  const gate = refName(x.attrs.gate), chl = refName(ch.attrs.layer);
  const gStroke = m.color.get(gate) ?? m.pal.gate, cStroke = m.color.get(chl) ?? m.pal.channel;
  const out = [];
  for (const s of shapes) {
    const x0 = ox + g + s.u * scale, x1 = x0 + W * scale;
    const yTop = Y(s.v + T), yBot = Y(s.v);
    const op = s.ghost ? 0.35 : 1;
    const L = faces.includes('left') ? g : 0, R = faces.includes('right') ? g : 0;
    const face = (f, rx, ry, rw, rh) => (faces.includes(f) ? `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fillOf(gate)}" stroke="${gStroke}" opacity="${op}"><title>gate covers the ${f} face</title></rect>` : '');
    out.push(face('top', x0 - L, yTop - g, x1 - x0 + L + R, g), face('bottom', x0 - L, yBot, x1 - x0 + L + R, g),
      face('left', x0 - g, yTop, g, yBot - yTop), face('right', x1, yTop, g, yBot - yTop));
    out.push(`<rect x="${x0}" y="${yTop}" width="${x1 - x0}" height="${yBot - yTop}" fill="${fillOf(chl)}" stroke="${cStroke}" stroke-width="1.4" opacity="${op}"><title>${esc(ch.name)} ${fmt(W)} x ${fmt(T)}nm</title></rect>`);
    for (const w of widths.filter((w) => w < W && !isRange(ch.attrs.width))) {
      const xm = (x0 + x1) / 2;
      out.push(`<rect class="option" x="${xm - (w * scale) / 2}" y="${yTop}" width="${w * scale}" height="${yBot - yTop}"><title>width option ${fmt(w)}nm</title></rect>`);
    }
  }
  const s0 = shapes[0];
  const x0 = ox + g + s0.u * scale;
  const bottom = oy + H + 16;
  out.push(dimH(x0, x0 + W * scale, bottom, `W ${widths.length > 1 ? (isRange(ch.attrs.width) ? `${fmt(widths[0])}-${fmt(widths[1])}` : widths.map(fmt).join('|')) : fmt(W)}`));
  out.push(dimV(Y(s0.v + T), Y(s0.v), ox - 8, `T ${fmt(T)}`, true));
  if (shapes.length > 1) {
    const s1 = shapes[1];
    if (axis === 'z') out.push(dimV(Y(s1.v), Y(s0.v), ox + g + W * scale + g + 10, `pitch ${fmt(pitch)}`));
    else out.push(dimH(ox + g + s0.u * scale, ox + g + s1.u * scale, oy - 6, `pitch ${fmt(pitch)}`));
  }
  const cap = arr ? `${c.fill ? 'fill' : c.min === c.max ? c.n : `${c.min}..${c.max}`} x ${ch.name} along ${axis}` : ch.name;
  const w = Math.max(ox + uMax * scale + 2 * g + 70, 220);
  return `<figure><figcaption>across the channel, ${esc(cap)}</figcaption><svg viewBox="0 0 ${w} ${bottom + 12}" width="${w}" height="${bottom + 12}">${out.join('')}</svg></figure>`;
}

function alongView(m, x, ch, arr, faces, T, c, Lg) {
  const cpp = m.cpp;
  if (!Lg || !cpp) return `<figure><figcaption>along the channel</figcaption><p class="empty">add a gate figure arrayed along x to see gate length and CPP</p></figure>`;
  const nz = arr?.attrs.axis === 'z' && !c.fill ? c.max : 1;
  const pz = arr?.attrs.axis === 'z' ? m.nm(arr.attrs.pitch) : 0;
  const stackH = (nz - 1) * pz + T;
  const wraps = faces.includes('left') || faces.includes('right') || faces.includes('bottom');
  const cap = Math.max(T, stackH * 0.35);
  const total = 3 * cpp;
  const scale = Math.min(250 / total, 110 / (stackH + cap * 2));
  const ox = 20, base = 34 + (stackH + cap * 1.6) * scale;
  const X = (u) => ox + u * scale;
  const Y = (v) => base - v * scale;
  const gate = refName(x.attrs.gate), chl = refName(ch.attrs.layer);
  const gStroke = m.color.get(gate) ?? m.pal.gate, cStroke = m.color.get(chl) ?? m.pal.channel;
  const stratum = m.strata.find((s) => refList(s.attrs.layers).includes(chl));
  const md = stratum ? refList(stratum.attrs.layers).find((n) => n !== chl && m.by.get(n)?.attrs.role === 'conductor' && !m.gateLayers.has(n)) : undefined;
  const out = [];
  out.push(`<rect x="${X(0)}" y="${Y(stackH)}" width="${total * scale}" height="${stackH * scale}" fill="${fillOf(chl)}" stroke="${cStroke}" stroke-dasharray="3 2" opacity="0.55"><title>source / drain</title></rect>`);
  for (let k = 0; k < 3; k++) {
    const gc = cpp * (k + 0.5);
    const gx0 = X(gc - Lg / 2);
    const gTop = Y(stackH + cap), gBot = wraps ? Y(faces.includes('bottom') ? -cap * 0.4 : 0) : Y(stackH);
    out.push(`<rect x="${gx0}" y="${gTop}" width="${Lg * scale}" height="${gBot - gTop}" fill="${fillOf(gate)}" stroke="${gStroke}" stroke-width="1.4"><title>gate ${esc(gate)}, L ${fmt(Lg)}nm</title></rect>`);
    for (let j = 0; j < nz; j++) {
      out.push(`<rect x="${gx0}" y="${Y(j * pz + T)}" width="${Lg * scale}" height="${T * scale}" fill="${fillOf(chl)}" stroke="${cStroke}"/>`);
    }
    if (md && k < 2) {
      const sx0 = X(gc + Lg / 2 + (cpp - Lg) * 0.18), sx1 = X(gc + cpp - Lg / 2 - (cpp - Lg) * 0.18);
      out.push(`<rect x="${sx0}" y="${Y(stackH + cap * 0.9)}" width="${sx1 - sx0}" height="${cap * 0.9 * scale}" fill="${fillOf(md)}" stroke="${m.color.get(md)}"><title>${esc(md)} source/drain contact</title></rect>`);
    }
  }
  const sub = Y(0) + (faces.includes('bottom') ? cap * 0.5 * scale : 0) + 2;
  out.push(`<line class="substrate" x1="${X(0)}" y1="${sub}" x2="${X(total)}" y2="${sub}"/>`);
  const top = Y(stackH + cap) - 12;
  out.push(dimH(X(cpp * 0.5), X(cpp * 1.5), top, `CPP ${fmt(cpp)}`));
  const bot = sub + 22;
  out.push(dimH(X(cpp * 1.5 - Lg / 2), X(cpp * 1.5 + Lg / 2), bot, `L ${fmt(Lg)}`));
  out.push(dimH(X(cpp * 0.5 + Lg / 2), X(cpp * 1.5 - Lg / 2), bot + 20, `S/D ${fmt(cpp - Lg)}`));
  const w = X(total) + 20;
  return `<figure><figcaption>along the channel, gate pitch${md ? `, ${esc(md)} contacts` : ''}</figcaption><svg viewBox="0 0 ${w} ${bot + 30}" width="${w}" height="${bot + 30}">${out.join('')}</svg></figure>`;
}

// ---- misc ------------------------------------------------------------------------

function emptySvg(msg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 60"><text class="empty" x="200" y="34" text-anchor="middle">${esc(msg)}</text></svg>`;
}
