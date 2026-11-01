// Cell-template expansion (VOCABULARY.md section 2, site v2).
//
// expandSite(resolved, name, { units }) -> { name, width, height, bands, rails, tracks, edges, problems }
//   units: the cell width in placement units (default 1); left/right edge
//   features sit at x = 0 and x = units * site width.
//
// Works on the resolved form (SPEC.md section 5), so every consumer, the resolver's
// checks, the playground renderer, generators, sees the same coordinates.
// All coordinates are integer DBU, in the site's frame (origin bottom-left).
//
// Rows: `row R { site = S; y; flip }` places site S's bands, rails, tracks and
// edge features at height y; flip mirrors them about the row's own horizontal
// centreline (local y -> h - y) before the shift. Rows nest one level: a row's
// site must not have rows itself. Expanded children are named `R.child`.

import { maxOf, minOf } from './jsmath.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// Values come from the resolved form even when the resolver rejected them
// (V003 is reported there): use them only in the shape they should have.
const listOf = (v, ok) => (Array.isArray(v) && v.every(ok) ? v : null);
const isRef = (v) => v && typeof v === 'object' && typeof v.ref === 'string';
const POLS = ['n', 'p'];
const polaritiesOf = (st) => listOf(st?.attrs?.polarity, (x) => POLS.includes(x)) ?? POLS;
// Track enumeration is bounded; more in-cell tracks than this is a mistake.
const MAX_TRACKS = 100000;
// Inputs are bounded so that every sum the expansion forms stays an exact Number.
const BOUND = 2 ** 50;
const tooBig = (vs) => vs.some((v) => isNum(v) && Math.abs(v) > BOUND);
// The possible values of a resolved width: [] when unset, null when not a length.
function widthValues(v) {
  if (v === undefined) return [];
  if (isNum(v)) return [v];
  if (v && Array.isArray(v.one_of) && v.one_of.every(isNum)) return v.one_of;
  if (v && isNum(v.min) && isNum(v.max)) return [v.min, v.max];
  return null;
}

export function expandSite(resolved, name, opts = {}) {
  const by = new Map((resolved.objects ?? []).filter((o) => o.name).map((o) => [o.name, o]));
  const site = by.get(name);
  const problems = [];
  const out = { name, width: site?.attrs.width, height: site?.attrs.height, bands: [], rails: [], tracks: [], edges: [], problems };
  if (!site || site.kind !== 'site' || !isNum(out.width) || !isNum(out.height)) return out;
  const units = opts.units ?? 1;
  const W = out.width * units;
  const prob = (code, path, message) => problems.push({ code, path, message });
  if (tooBig([W, out.height]) || !isNum(W)) { prob('V040', name, `site ${name}: a cell ${W} x ${out.height} DBU is beyond the exact range (+/-2^50)`); return out; }
  out.cellWidth = W;

  const place = (s, frame) => {
    const H = s.attrs.height;
    const ty = (y) => (frame.flip ? frame.y + H - y : frame.y + y);
    const tr = (lo, hi) => { const a = ty(lo), b = ty(hi); return a <= b ? [a, b] : [b, a]; };
    const kids = s.children ?? [];
    for (const c of kids) {
      const path = `${frame.prefix}${c.name}`;
      const a = c.attrs;
      switch (c.kind) {
        case 'band': {
          const polarity = POLS.includes(a.polarity) ? a.polarity : (c.name === 'n' || c.name === 'p' ? c.name : undefined);
          if (!polarity) { prob('V004', path, `band ${path} needs a polarity (its name is not n or p)`); break; }
          if (!a.y || !isNum(a.y.min) || !isNum(a.y.max)) break;
          if (tooBig([a.y.min, a.y.max])) { prob('V040', path, `band ${path}: coordinates beyond +/-2^50 DBU`); break; }
          if (a.y.min < 0 || a.y.max > H || a.y.min >= a.y.max) prob('V013', path, `band ${path} spans ${a.y.min}..${a.y.max}, outside its row 0..${H}`);
          const stratum = a.stratum?.ref;
          const pols = polaritiesOf(by.get(stratum));
          if (stratum && !pols.includes(polarity)) prob('V013', path, `band ${path} is ${polarity}, but stratum ${stratum} has polarities ${pols.join(', ')}`);
          const [y0, y1] = tr(a.y.min, a.y.max);
          out.bands.push({ name: path, src: c.src, polarity, stratum, y0, y1, flipped: frame.flip });
          break;
        }
        case 'rail': {
          const hasEdge = a.edge !== undefined, hasY = a.y !== undefined;
          if (hasEdge === hasY) { prob(hasEdge ? 'V040' : 'V004', path, hasEdge ? `rail ${path} has both edge and y; give one` : `rail ${path} needs edge or y`); break; }
          const local = hasEdge ? (a.edge === 'bottom' ? 0 : H) : a.y;
          if (!isNum(local)) break;
          if (local < 0 || local > H) prob('V040', path, `rail ${path} at y = ${local} is outside its row 0..${H}`);
          const layer = a.layer?.ref;
          // A width may be a choice or a range (sized later): every possible value
          // must be positive, and collisions use the largest, so none can hide.
          const ws = widthValues(a.width ?? by.get(layer)?.attrs.width);
          if (ws === null) { prob('V040', path, `rail ${path}: its width is not a length`); break; }
          if (ws.some((w) => w <= 0)) { prob('V040', path, `rail ${path}: width ${minOf(ws)} must be positive`); break; }
          if (tooBig([local, ...ws])) { prob('V040', path, `rail ${path}: coordinates beyond +/-2^50 DBU`); break; }
          const width = ws.length ? maxOf(ws) : undefined;
          out.rails.push({ name: path, src: c.src, net: a.net ?? c.name, layer, y: ty(local), width: isNum(width) ? width : undefined });
          break;
        }
        case 'tracks': {
          const layerName = a.layer?.ref ?? c.name;
          const layer = by.get(layerName);
          if (layer?.kind !== 'layer') break;                          // reported by the resolver (C021 / V003)
          const dir = layer.attrs.direction;
          if (dir !== 'horizontal' && dir !== 'vertical') { prob('V040', path, `tracks ${path}: layer ${layerName} has no horizontal or vertical direction`); break; }
          if (a.at && (a.pitch !== undefined || a.offset !== undefined)) { prob('V040', path, `tracks ${path}: give at, or pitch/offset, not both`); break; }
          const axis = dir === 'horizontal' ? 'y' : 'x';
          const extent = axis === 'y' ? H : W;
          let local;
          if (a.at !== undefined && !listOf(a.at, isNum)) break;          // reported by the resolver (V003)
          if (a.at && tooBig(a.at)) { prob('V040', path, `tracks ${path}: coordinates beyond +/-2^50 DBU`); break; }
          if (a.at) local = a.at;
          else {
            // the layer's lattice (its pitch / offset, or its track array) unless a local pitch is given
            const arr = by.get(layer.attrs.tracks?.ref);
            const lat = arr?.kind === 'array' ? arr.attrs : layer.attrs;
            const pitch = a.pitch ?? lat.pitch;
            const offset = a.offset ?? (a.pitch === undefined ? lat.offset ?? 0 : 0);
            if (!isNum(pitch) || pitch <= 0) { prob('V040', path, `tracks ${path}: no pitch (set pitch, or a pitch on ${layerName})`); break; }
            if (!isNum(offset)) break;                                     // reported by the resolver (V003)
            if (tooBig([pitch, offset])) { prob('V040', path, `tracks ${path}: coordinates beyond +/-2^50 DBU`); break; }
            if (offset < 0 || offset > extent) { prob('V040', path, `tracks ${path}: offset ${offset} lies outside 0..${extent}`); break; }
            // both ends of the lattice count
            if (Math.floor((extent - offset) / pitch) + 1 > MAX_TRACKS) { prob('V040', path, `tracks ${path}: more than ${MAX_TRACKS} tracks in one row`); break; }
            local = [];
            for (let k = 0, p = offset; p <= extent; k++, p = offset + k * pitch) local.push(p);
          }
          if (local.some((p) => !isNum(p) || p < 0 || p > extent)) prob('V040', path, `tracks ${path}: a position lies outside 0..${extent}`);
          const all = local.map((_, i) => i);
          let use = all;
          if (a.use !== undefined) {
            const isRange = a.use && typeof a.use === 'object' && isNum(a.use.min) && isNum(a.use.max);
            if (!listOf(a.use, Number.isInteger) && !isRange) break;      // reported by the resolver (V003)
            use = Array.isArray(a.use) ? a.use : all.filter((i) => i >= a.use.min && i <= a.use.max);
            const bad = (Array.isArray(a.use) ? a.use : [a.use.min, a.use.max]).filter((i) => !(i >= 0 && i < local.length));
            if (bad.length) prob('V040', path, `tracks ${path}: index ${bad[0]} does not exist (tracks 0..${local.length - 1})`);
          }
          // span: the row the grid belongs to (vertical tracks run only across it)
          out.tracks.push({ name: path, src: c.src, layer: layerName, axis, positions: axis === 'y' ? local.map(ty) : local, use, span: tr(0, H) });
          break;
        }
        case 'edge_feature': {
          const w = a.width;
          if (!isNum(w)) break;
          const shared = a.shared ?? true;
          const ext = a.extend ?? 0;
          const at = a.at ?? 'both';
          const sides = at === 'both' ? ['left', 'right'] : Array.isArray(at) ? at : [at];
          if (!isNum(ext) || (a.y !== undefined && !(a.y && isNum(a.y.min) && isNum(a.y.max)))) break;   // reported by the resolver (V003)
          if (w <= 0) { prob('V040', path, `edge feature ${path}: width must be positive`); break; }
          if (tooBig([w, ext, a.y?.min, a.y?.max])) { prob('V040', path, `edge feature ${path}: coordinates beyond +/-2^50 DBU`); break; }
          if (!(ext >= 0)) { prob('V040', path, `edge feature ${path}: extend must not be negative`); break; }
          if (a.y && (a.y.min < 0 || a.y.max > H || a.y.min >= a.y.max)) { prob('V040', path, `edge feature ${path}: y spans ${a.y.min}..${a.y.max}, outside its row 0..${H}`); break; }
          if (!shared && sides.some((sd) => w > ((sd === 'left' || sd === 'right') ? W : H))) { prob('V040', path, `edge feature ${path}: an unshared feature ${w} wide does not fit inside the cell`); break; }
          if (shared && w % 2) { prob('V040', path, `edge feature ${path}: a shared feature needs an even width in grid units (it is split between two cells)`); break; }
          const across = (edge, lo, hi) => (shared ? [edge - w / 2, edge + w / 2] : edge === lo ? [lo, lo + w] : [hi - w, hi]);
          for (const side of sides) {
            if (side === 'left' || side === 'right') {
              const [y0, y1] = a.y ? tr(a.y.min - ext, a.y.max + ext) : tr(-ext, H + ext);
              const [x0, x1] = across(side === 'left' ? 0 : W, 0, W);
              out.edges.push({ name: path, src: c.src, layer: a.layer?.ref, side, shared, x0, y0, x1, y1 });
            } else {
              const [y0, y1] = tr(...across(side === 'bottom' ? 0 : H, 0, H));
              out.edges.push({ name: path, src: c.src, layer: a.layer?.ref, side: frame.flip ? (side === 'top' ? 'bottom' : 'top') : side, shared, x0: -ext, y0, x1: W + ext, y1 });
            }
          }
          break;
        }
        case 'row': {
          if (frame.prefix) break;                                     // one level only (reported below)
          const sub = by.get(a.site?.ref);
          if (!sub || sub.kind !== 'site') break;
          if (sub === s) { prob('V040', path, `row ${path} uses its own site`); break; }
          if ((sub.children ?? []).some((x) => x.kind === 'row')) { prob('V040', path, `row ${path}: site ${sub.name} has rows itself; rows nest one level`); break; }
          if (sub.attrs.width !== out.width) prob('V040', path, `row ${path}: site ${sub.name} is ${sub.attrs.width} wide, this site ${out.width}`);
          const y = a.y ?? 0;
          if (!isNum(sub.attrs.height) || !isNum(sub.attrs.width) || !isNum(y)) break;   // reported by the resolver (V003 / V004)
          if (tooBig([y, sub.attrs.height])) { prob('V040', path, `row ${path}: coordinates beyond +/-2^50 DBU`); break; }
          if (y < 0 || BigInt(y) + BigInt(sub.attrs.height) > BigInt(H)) prob('V040', path, `row ${path} spans ${y}..${y + sub.attrs.height}, outside 0..${H}`);
          place(sub, { y, flip: a.flip === true, prefix: `${c.name}.` });
          break;
        }
        default:
      }
    }
  };
  place(site, { y: 0, flip: false, prefix: '' });

  // Bands of one stratum must not overlap; bands of different strata may.
  for (let i = 0; i < out.bands.length; i++) {
    for (let j = i + 1; j < out.bands.length; j++) {
      const A = out.bands[i], B = out.bands[j];
      if (A.stratum === B.stratum && Math.min(A.y1, B.y1) > Math.max(A.y0, B.y0)) prob('V013', B.name, `bands ${A.name} and ${B.name} overlap in stratum ${A.stratum}`);
    }
  }
  // Rails: rails of one net on one layer at one height are one shared rail (the
  // widest, which covers the others: they share the centreline). Then rails of
  // different nets on one layer must not overlap. Both steps are independent of
  // declaration order. A rail of unknown width counts as a line.
  const rails = [];
  for (const r of out.rails) {
    const same = rails.find((x) => x.layer === r.layer && x.y === r.y && x.net === r.net);
    if (!same) { rails.push({ ...r }); continue; }
    same.shared = [...(same.shared ?? [same.name]), r.name];
    if (r.width !== undefined && (same.width === undefined || r.width > same.width)) same.width = r.width;
  }
  for (let i = 0; i < rails.length; i++) {
    for (let j = i + 1; j < rails.length; j++) {
      const x = rails[i], r = rails[j];
      if (x.layer !== r.layer || x.net === r.net) continue;
      // exact: 2*|dy| < w1 + w2, in BigInt (the sum can pass 2^53)
      const d2 = 2n * (BigInt(x.y) > BigInt(r.y) ? BigInt(x.y) - BigInt(r.y) : BigInt(r.y) - BigInt(x.y));
      if (d2 === 0n || d2 < BigInt(x.width ?? 0) + BigInt(r.width ?? 0)) prob('V040', r.name, `rails ${x.name} (${x.net}) and ${r.name} (${r.net}) overlap on ${r.layer}`);
    }
  }
  out.rails = rails;
  // Expanded coordinates are computed in Number: keep them where sums and
  // halves are exact (+/-2^52), and say so otherwise instead of rounding.
  const big = (v) => isNum(v) && Math.abs(v) > 2 ** 52;
  const far = [
    ...out.bands.filter((b) => big(b.y0) || big(b.y1)), ...out.rails.filter((r) => big(r.y)),
    ...out.tracks.filter((t) => t.positions.some(big) || t.span.some(big)), ...out.edges.filter((e) => [e.x0, e.y0, e.x1, e.y1].some(big)),
  ];
  for (const x of far) prob('V040', x.name, `${x.name}: coordinates beyond +/-2^52 DBU cannot be expanded exactly`);
  return out;
}

// Model selection (VOCABULARY.md section 2, cross / model): which models of a cross
// can describe a device with the given markers. `covering`: marker layers that
// cover the device; `touching`: marker layers that touch it at all.
export { polaritiesOf };
export function modelSelector(model) {
  const a = model.attrs;
  const refs = (v) => (listOf(v, isRef) ?? []).map((x) => x.ref);
  const markers = a.markers !== undefined ? refs(a.markers) : isRef(a.marker) ? [a.marker.ref] : [];
  // sets: [L] and [L, L] select the same devices
  return { name: model.name, polarity: a.polarity, markers: [...new Set(markers)], exclude: [...new Set(refs(a.exclude))] };
}
export function selectModels(cross, covering, touching, polarity) {
  return (cross.children ?? []).filter((c) => c.kind === 'model').map(modelSelector)
    .filter((m) => (polarity === undefined || m.polarity === polarity)
      && m.markers.every((x) => covering.has(x)) && !m.exclude.some((x) => touching.has(x)));
}
