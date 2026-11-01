// Reference rule checker (VOCABULARY.md section 3, normative semantics).
//
// checkRules(resolved, layout) -> { violations, unsupported, complete }
//   resolved: a resolved technology (SPEC.md section 5)
//   layout:   { shapes: [{ layer, rect: [x0, y0, x1, y1], net?, color?, connector? }] }
//             coordinates in integer DBU; `connector` names the connector a cut
//             belongs to.
//
// It decides only what the semantics define on rectangles. Anything else,
// non-rectangular components, regions it cannot evaluate, missing net or
// colour data, end-of-line contexts, is reported as unsupported and makes
// the result incomplete; it is never silently treated as passing.

import { Q } from './rational.js';
import { modelSelector, selectModels } from './template.js';
import { maxOf, minOf } from './jsmath.js';

const ZERO = Q.int(0);

class Unsupported extends Error {}
const unsupported = (why) => { throw new Unsupported(why); };

// "n/d" strings and integers (resolved-form thresholds) -> exact rationals.
function toQ(v) {
  if (typeof v === 'number') return Q.int(v);
  if (typeof v === 'string' && /^-?\d+\/\d+$/.test(v)) { const [n, d] = v.split('/'); return new Q(BigInt(n), BigInt(d)); }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return new Q(BigInt(v));
  return null;
}
const qi = (n) => Q.int(n);
const big = (n) => BigInt(n);
// exact products of (safe) integers
const qmul = (a, b) => new Q(big(a) * big(b));
const qsq2 = (a, b) => new Q(big(a) * big(a) + big(b) * big(b));
// Coordinates are bounded so that every sum and difference stays an exact Number.
const LIMIT = 2 ** 51;
const qstr = (q) => (q.isInt() ? `${q.n}` : `${q.n}/${q.d}`);

// ---- rectangle geometry ------------------------------------------------------------
const gx = (a, b) => Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
const gy = (a, b) => Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
const ox = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const oy = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
const overlaps = (a, b) => ox(a, b) > 0 && oy(a, b) > 0;
const contacts = (a, b) => ox(a, b) >= 0 && oy(a, b) >= 0;
const contains = (o, i) => o.x0 <= i.x0 && i.x1 <= o.x1 && o.y0 <= i.y0 && i.y1 <= o.y1;
const dx = (r) => r.x1 - r.x0;
const dy = (r) => r.y1 - r.y0;

// Is `rect` covered by the union of `rects`? (coordinate compression)
function covered(rect, rects) {
  const xs = [...new Set([rect.x0, rect.x1, ...rects.flatMap((r) => [r.x0, r.x1])])].filter((x) => x >= rect.x0 && x <= rect.x1).sort((a, b) => a - b);
  const ys = [...new Set([rect.y0, rect.y1, ...rects.flatMap((r) => [r.y0, r.y1])])].filter((y) => y >= rect.y0 && y <= rect.y1).sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (!rects.some((r) => r.x0 <= cx && cx <= r.x1 && r.y0 <= cy && cy <= r.y1)) return false;
    }
  }
  return true;
}

// Merge rectangles into components (touching or overlapping rectangles merge).
function merge(rects) {
  const parent = rects.map((_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }   // path compression, iteratively
    return r;
  };
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (contacts(rects[i], rects[j])) parent[find(i)] = find(j);
  const groups = new Map();
  rects.forEach((r, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  return [...groups.values()].map((rs) => {
    const bbox = { x0: minOf(rs.map((r) => r.x0)), y0: minOf(rs.map((r) => r.y0)), x1: maxOf(rs.map((r) => r.x1)), y1: maxOf(rs.map((r) => r.y1)) };
    const meta = (key) => { const vals = new Set(rs.map((r) => r[key])); return vals.size === 1 ? [...vals][0] : MIXED; };
    return { rects: rs, bbox, rectangular: covered(bbox, rs), ids: rs.flatMap((r) => r.ids ?? []), net: meta('net'), color: meta('color'), connector: meta('connector') };
  });
}
const MIXED = Symbol('mixed');
// Derived geometry must stay inside the exact range too.
function inRange(rects) {
  if (rects.some((r) => [r.x0, r.y0, r.x1, r.y1].some((v) => Math.abs(v) > LIMIT))) unsupported('derived geometry outside +/-2^51 DBU');
  return rects;
}

// ---- the checker ---------------------------------------------------------------------

// Layout geometry shared by the rule checker and device recognition: merged
// components per layer, and evaluation of regions / computed markers (section 3.2).
function geometry(resolved, layout) {
  const objects = resolved.objects ?? [];
  const byName = new Map(objects.filter((o) => o.name).map((o) => [o.name, o]));
  const shapes = (layout.shapes ?? []).map((s, id) => {
    const [x0, y0, x1, y1] = s.rect;
    if (![x0, y0, x1, y1].every((v) => Number.isInteger(v) && Math.abs(v) <= LIMIT) || !(x1 > x0 && y1 > y0)) throw new Error(`shape ${id}: rect must be integer [x0, y0, x1, y1] (|v| <= 2^51) with positive size`);
    return { id, ids: [id], layer: s.layer, x0, y0, x1, y1, net: s.net, color: s.color, connector: s.connector };
  });
  const layerComps = new Map();
  const compsOfLayer = (name) => {
    if (!layerComps.has(name)) layerComps.set(name, merge(shapes.filter((s) => s.layer === name)));
    return layerComps.get(name);
  };

  // Components of an operand (a layer, a computed marker layer, or a region).
  const evalOperand = (name, depth = 0) => {
    const o = byName.get(name);
    if (!o) unsupported(`unknown operand '${name}'`);
    if (o.kind === 'layer' && !o.attrs.from) return compsOfLayer(name);
    if ((o.kind === 'layer' && o.attrs.from) || o.kind === 'region') return evalGeom(o.attrs.from, depth + 1);
    unsupported(`'${name}' is a ${o.kind}, not a layer or region`);
  };
  const evalGeom = (e, depth) => {
    if (depth > 20) unsupported('region nesting too deep');
    if (e && typeof e === 'object' && 'ref' in e) return evalOperand(e.ref, depth);
    if (!e || typeof e !== 'object' || !e.call) unsupported('unsupported region expression');
    const args = e.args ?? [];
    const sub = (i) => evalGeom(args[i], depth + 1);
    const rectsOf = (comps) => comps.flatMap((c) => c.rects);
    // Region operations are regularized: results of zero area (shared edges,
    // points) are dropped. Results keep the first operand's provenance.
    switch (e.call) {
      case 'intersect': {
        let acc = rectsOf(sub(0));
        for (let i = 1; i < args.length; i++) {
          const b = rectsOf(sub(i));
          acc = acc.flatMap((p) => b.filter((q) => overlaps(p, q)).map((q) => ({ ...p, x0: Math.max(p.x0, q.x0), y0: Math.max(p.y0, q.y0), x1: Math.min(p.x1, q.x1), y1: Math.min(p.y1, q.y1) })));
        }
        return merge(acc);
      }
      case 'grow':
      case 'shrink': {
        const d = toQ(args[1]);
        if (!d?.isInt() || d.n < 0n) unsupported(`${e.call} by a negative or non-integer distance`);
        const k = Number(d.n);
        if (k > LIMIT) unsupported(`${e.call} distance too large`);
        // grow distributes over the figures; shrink works on whole components
        if (e.call === 'grow') return merge(inRange(rectsOf(sub(0)).map((r) => ({ ...r, x0: r.x0 - k, y0: r.y0 - k, x1: r.x1 + k, y1: r.y1 + k }))));
        return merge(sub(0).map((c) => {
          if (!c.rectangular) unsupported('shrink of a non-rectangular component');
          const b = c.bbox;
          // the component's own (possibly mixed) metadata, not one figure's
          return { ids: c.ids, net: c.net, color: c.color, connector: c.connector, x0: b.x0 + k, y0: b.y0 + k, x1: b.x1 - k, y1: b.y1 - k };
        }).filter((r) => r.x1 > r.x0 && r.y1 > r.y0));
      }
      case 'touching':
      case 'avoiding': {
        const a = sub(0), b = rectsOf(sub(1));
        return a.filter((c) => c.rects.some((r) => b.some((q) => contacts(r, q))) === (e.call === 'touching'));
      }
      case 'union': return merge(args.flatMap((_, i) => rectsOf(sub(i))));
      case 'minus': {
        // closure of A \ B: each figure minus each cutter, as up to four rectangles
        let acc = rectsOf(sub(0));
        for (let i = 1; i < args.length; i++) {
          for (const q of rectsOf(sub(i))) {
            acc = acc.flatMap((p) => {
              if (!overlaps(p, q)) return [p];
              const parts = [];
              if (q.y1 < p.y1) parts.push({ ...p, y0: q.y1 });                                    // above
              if (q.y0 > p.y0) parts.push({ ...p, y1: q.y0 });                                    // below
              const y0 = Math.max(p.y0, q.y0), y1 = Math.min(p.y1, q.y1);
              if (q.x0 > p.x0) parts.push({ ...p, y0, y1, x1: q.x0 });                            // left
              if (q.x1 < p.x1) parts.push({ ...p, y0, y1, x0: q.x1 });                            // right
              return parts;
            });
          }
        }
        return merge(acc);
      }
      default: return unsupported(`region function ${e.call}() needs a placed cell template`);
    }
  };

  return { byName, compsOfLayer, evalOperand, evalGeom };
}

export function checkRules(resolved, layout, opts = {}) {
  const mode = opts.mode ?? 'generator';
  const objects = resolved.objects ?? [];
  const byName = new Map(objects.filter((o) => o.name).map((o) => [o.name, o]));
  const violations = [];
  const unsupportedList = [];

  const { compsOfLayer, evalOperand } = geometry(resolved, layout);

  // ---- per-rule evaluation ----------------------------------------------------------
  for (const rule of objects.filter((o) => o.kind === 'rule')) {
    const a = rule.attrs;
    if (mode === 'generator' && a.intent === 'checker_only') continue;
    try {
      checkRule(rule);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      unsupportedList.push({ rule: rule.name, kind: a.kind, reason: e.message });
    }
  }

  function checkRule(rule) {
    const a = rule.attrs;
    const kind = a.kind;
    if (rule.invalid === true || (rule.children ?? []).some((c) => c.invalid === true)) unsupported('the resolver reported errors on this rule');
    if (typeof kind !== 'string' || kind.startsWith('x_')) unsupported(`extension kind ${kind}`);
    const limit = a.limit ?? 'min';
    const children = rule.children ?? [];
    if (children.some((c) => c.kind === 'case')) unsupported('case contexts (via_end / open_end) need per-end connection data');
    const table = children.find((c) => c.kind === 'table');
    const alts = children.filter((c) => c.kind === 'alternative');
    const value = a.value !== undefined ? toQ(a.value) : null;
    const pass = (q, t) => { const c = q.cmp(t); return limit === 'min' ? c >= 0 : limit === 'max' ? c <= 0 : c === 0; };
    const passSq = (sq, t) => { if (t.cmp(ZERO) < 0) unsupported('a negative distance threshold'); return pass(sq, t.mul(t)); };   // Euclidean: compare squares
    const report = (subjects, measured, threshold, detail) => violations.push({
      rule: rule.name, kind, subjects: subjects.flatMap((c) => c.ids ?? []), measured, threshold: threshold == null ? undefined : qstr(threshold), limit, ...(detail ? { detail } : {}),
    });
    const rect = (c) => { if (!c.rectangular) unsupported('a non-rectangular component'); return c.bbox; };
    const scope = a.scope ? evalOperand(a.scope.ref).flatMap((c) => c.rects) : null;
    const inScope = (c) => !scope || c.rects.some((r) => scope.some((s) => contacts(r, s)));

    // Operands
    const onRefs = Array.isArray(a.on) ? a.on.map((x) => x.ref) : [a.on?.ref];
    const conn = !Array.isArray(a.on) && byName.get(a.on?.ref)?.kind === 'connector' ? byName.get(a.on.ref) : null;
    const cutComps = (c) => {
      const cutLayer = c.attrs.cut?.ref;
      if (!cutLayer) unsupported(`connector ${c.name} has no cut layer`);
      const comps = evalOperand(cutLayer);                   // a computed cut layer is evaluated, keeping provenance
      if (comps.some((x) => x.connector === MIXED || (x.connector === undefined))) unsupported(`cuts on ${cutLayer} without a connector name`);
      return comps.filter((x) => x.connector === c.name);
    };
    const opCache = new Map();
    const operand = (i) => { const n = onRefs[i]; if (!opCache.has(n)) opCache.set(n, evalOperand(n)); return opCache.get(n); };

    // Pair conditions
    const meta = (c, key) => { if (c[key] === undefined || c[key] === MIXED) unsupported(`${key === 'net' ? 'net' : 'mask colour'} data needed by ${key === 'net' ? 'same_net' : 'same_color'}`); return c[key]; };
    const pairOk = (c1, c2, r1, r2, widths = true) => {
      if (a.same_net !== undefined && (meta(c1, 'net') === meta(c2, 'net')) !== a.same_net) return false;
      if (a.same_color !== undefined && (meta(c1, 'color') === meta(c2, 'color')) !== a.same_color) return false;
      if (widths && (a.width_below !== undefined || a.width_above !== undefined)) {
        const w = qi(Math.max(Math.min(dx(r1), dy(r1)), Math.min(dx(r2), dy(r2))));
        if (a.width_below !== undefined && !(w.cmp(toQ(a.width_below)) < 0)) return false;
        if (a.width_above !== undefined && !(w.cmp(toQ(a.width_above)) > 0)) return false;
      }
      return true;
    };
    const prlOf = (r1, r2) => {
      if (a.axis === 'x') return Math.max(0, oy(r1, r2));
      if (a.axis === 'y') return Math.max(0, ox(r1, r2));
      if (overlaps(r1, r2)) return 0;
      if (gx(r1, r2) > 0 && gy(r1, r2) === 0) return Math.max(0, oy(r1, r2));
      if (gy(r1, r2) > 0 && gx(r1, r2) === 0) return Math.max(0, ox(r1, r2));
      return 0;
    };
    const pairs = (A, B) => {
      const out = [];
      if (B === A) { for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) out.push([A[i], A[j]]); }
      else for (const p of A) for (const q of B) if (p !== q) out.push([p, q]);
      // one operand: both are subjects, so the pair counts when either is in scope
      return out.filter(([p, q]) => inScope(p) || (B === A && inScope(q)));
    };
    const tableLookup = (w, prl) => {
      const idx = (key) => (table.attrs[key] ?? [0]).map(toQ);
      const rows = idx('width'), cols = idx('prl');
      const pick = (bps, x) => { let k = 0; bps.forEach((b, i) => { if (b.cmp(x) <= 0) k = i; }); return k; };
      return toQ(table.attrs.values[pick(rows, qi(w))][pick(cols, qi(prl))]);
    };

    switch (kind) {
      case 'width':
      case 'length':
      case 'min_length':
      case 'area': {
        for (const c of operand(0).filter(inScope)) {
          const r = rect(c);
          const q = kind === 'area' ? qmul(dx(r), dy(r))
            : a.axis === 'x' ? qi(dx(r)) : a.axis === 'y' ? qi(dy(r))
            : qi(kind === 'width' ? Math.min(dx(r), dy(r)) : Math.max(dx(r), dy(r)));
          if (!pass(q, value)) report([c], qstr(q), value);
        }
        return;
      }
      case 'spacing':
      case 'cut_spacing':
      case 'corner_spacing': {
        let A, B;
        if (conn) { if (kind !== 'cut_spacing') unsupported('only cut_spacing applies to a connector'); A = B = cutComps(conn); }
        else { A = operand(0); B = onRefs.length > 1 ? operand(1) : A; }
        for (const [c1, c2] of pairs(A, B)) {
          const r1 = rect(c1), r2 = rect(c2);
          if (!pairOk(c1, c2, r1, r2)) continue;
          if (kind === 'spacing' && a.prl !== undefined && qi(prlOf(r1, r2)).cmp(toQ(a.prl)) < 0) continue;
          if (kind === 'corner_spacing') {
            if (!(gx(r1, r2) > 0 && gy(r1, r2) > 0)) continue;             // corner pairs only (diagonal)
            const sq = qsq2(gx(r1, r2), gy(r1, r2));
            if (!passSq(sq, value)) report([c1, c2], `sqrt(${qstr(sq)})`, value);
            continue;
          }
          if (overlaps(r1, r2)) { report([c1, c2], 'overlap', undefined); continue; }
          const t = table ? tableLookup(Math.max(Math.min(dx(r1), dy(r1)), Math.min(dx(r2), dy(r2))), prlOf(r1, r2)) : value;
          if (kind === 'cut_spacing' && a.measure === 'center') {
            // doubled centre coordinates keep the arithmetic in integers
            const cx = Math.abs((r1.x0 + r1.x1) - (r2.x0 + r2.x1)), cy = Math.abs((r1.y0 + r1.y1) - (r2.y0 + r2.y1));
            if (a.axis === 'x' && oy(r1, r2) < 0) continue;
            if (a.axis === 'y' && ox(r1, r2) < 0) continue;
            if (t.cmp(ZERO) < 0) unsupported('a negative distance threshold');
            const t2 = t.mul(qi(2));
            const ok = a.axis === 'x' ? pass(qi(cx), t2) : a.axis === 'y' ? pass(qi(cy), t2) : pass(qsq2(cx, cy), t2.mul(t2));
            if (!ok) report([c1, c2], `centre distance ${a.axis ? qstr(new Q(big(a.axis === 'x' ? cx : cy), 2n)) : `sqrt(${qstr(qsq2(cx, cy).div(qi(4)))})`}`, t);
            continue;
          }
          if (a.axis === 'x') { if (oy(r1, r2) < 0) continue; if (!pass(qi(gx(r1, r2)), t)) report([c1, c2], `${gx(r1, r2)}`, t); continue; }
          if (a.axis === 'y') { if (ox(r1, r2) < 0) continue; if (!pass(qi(gy(r1, r2)), t)) report([c1, c2], `${gy(r1, r2)}`, t); continue; }
          const sq = qsq2(gx(r1, r2), gy(r1, r2));
          if (!passSq(sq, t)) report([c1, c2], `sqrt(${qstr(sq)})`, t);
        }
        return;
      }
      case 'eol_spacing': {
        const comps = operand(0);
        const within = a.within !== undefined ? toQ(a.within) : ZERO;
        for (const s of comps.filter(inScope)) {
          const S = rect(s);
          const axis = a.axis ?? (dx(S) > dy(S) ? 'x' : dy(S) > dx(S) ? 'y' : unsupported('a square end-of-line subject needs axis'));
          const endWidth = qi(axis === 'x' ? dy(S) : dx(S));
          if (a.width_below !== undefined && !(endWidth.cmp(toQ(a.width_below)) < 0)) continue;
          if (a.width_above !== undefined && !(endWidth.cmp(toQ(a.width_above)) > 0)) continue;
          for (const t of comps) {
            if (t === s) continue;
            const T = rect(t);
            if (!pairOk(s, t, S, T, false)) continue;               // eol width conditions are on the end, above
            if (overlaps(S, T)) { report([s, t], 'overlap', value); continue; }
            const trans = axis === 'x' ? gy(S, T) : gx(S, T);
            if (qi(trans).cmp(within) > 0) continue;
            const ends = axis === 'x'
              ? [[T.x1 > S.x1, Math.max(0, T.x0 - S.x1)], [T.x0 < S.x0, Math.max(0, S.x0 - T.x1)]]
              : [[T.y1 > S.y1, Math.max(0, T.y0 - S.y1)], [T.y0 < S.y0, Math.max(0, S.y0 - T.y1)]];
            for (const [selected, gap] of ends) if (selected && !pass(qi(gap), value)) report([s, t], `${gap}`, value);
          }
        }
        return;
      }
      case 'enclosure': {
        const obligations = conn
          ? (() => {
              const lowers = Array.isArray(conn.attrs.lower) ? conn.attrs.lower.map((x) => x.ref) : [conn.attrs.lower?.ref];
              const cuts = cutComps(conn);
              // computed endpoint layers are evaluated like any operand (an absent one holds nothing)
              const layerComps = (n) => (n === undefined || n === null ? [] : evalOperand(n));
              return [[cuts, lowers.flatMap(layerComps)], [cuts, layerComps(conn.attrs.upper?.ref)]];
            })()
          : [[operand(0), operand(1)]];
        for (const [inner, outer] of obligations) {
          for (const ic of inner.filter(inScope)) {
            const I = rect(ic);
            const holders = outer.filter((oc) => oc.rectangular && contains(oc.bbox, I));
            if (outer.some((oc) => !oc.rectangular && oc.rects.some((r) => contacts(r, I)))) unsupported('enclosure by a non-rectangular component');
            if (!holders.length) { report([ic], 'not enclosed', value); continue; }
            const ok = holders.some((oc) => {
              const O = oc.bbox;
              const w = qi(Math.min(dx(O), dy(O)));
              if (a.width_below !== undefined && !(w.cmp(toQ(a.width_below)) < 0)) return true;   // rule does not apply to this outer
              if (a.width_above !== undefined && !(w.cmp(toQ(a.width_above)) > 0)) return true;
              const m = [I.x0 - O.x0, O.x1 - I.x1, I.y0 - O.y0, O.y1 - I.y1].map(qi);
              if (alts.length) return alts.some((alt) => alt.attrs.margins.every((t, k) => pass(m[k], toQ(t))));
              const idx = a.axis === 'x' ? [0, 1] : a.axis === 'y' ? [2, 3] : [0, 1, 2, 3];
              return idx.every((k) => pass(m[k], value));
            });
            if (!ok) report([ic], 'margins', value, alts.length ? 'no alternative holds' : undefined);
          }
        }
        return;
      }
      case 'extension': {
        if (!a.axis) unsupported('extension without axis');
        for (const [ec, bc] of pairs(operand(0), operand(1))) {
          const E = rect(ec), B = rect(bc);
          if (!overlaps(E, B)) continue;
          const m = a.axis === 'x' ? [B.x0 - E.x0, E.x1 - B.x1] : [B.y0 - E.y0, E.y1 - B.y1];
          if (!m.every((x) => pass(qi(x), value))) report([ec, bc], `${minOf(m)}`, value);
        }
        return;
      }
      case 'inside':
      case 'interacting':
      case 'not_interacting':
      case 'not_overlapping': {
        const S = operand(0).filter(inScope);
        const T = operand(1).flatMap((c) => c.rects);
        // per merged subject component
        for (const c of S) {
          const touch = (f) => c.rects.some((r) => T.some((t) => f(r, t)));
          const bad = kind === 'inside' ? !c.rects.every((r) => covered(r, T))
            : kind === 'interacting' ? !touch(contacts)
            : kind === 'not_interacting' ? touch(contacts)
            : touch(overlaps);
          if (bad) report([c], kind);
        }
        return;
      }
      default:
        unsupported(`unknown rule kind ${kind}`);
    }
  }

  return { violations, unsupported: unsupportedList, complete: unsupportedList.length === 0 };
}

// Device recognition (VOCABULARY.md section 2, cross / model). For every cross, the
// components of `recognize` (default: intersect(gate, the channel's layer))
// are its devices. A marker covers a device when the marker's union contains
// it, and touches it when they overlap. A device's candidate models are those
// whose `markers` all cover it and whose `exclude` markers do not touch it;
// exactly one per polarity must remain, otherwise selection fails. Polarity
// itself comes from the cell template (bands), so it is reported, not chosen.
export function recognizeDevices(resolved, layout) {
  const { byName, compsOfLayer, evalOperand, evalGeom } = geometry(resolved, layout);
  const out = [];
  for (const cross of (resolved.objects ?? []).filter((o) => o.kind === 'cross')) {
    const a = cross.attrs;
    let expr = a.recognize;
    if (!expr) {
      let ch = byName.get(a.channel?.ref);
      if (ch?.kind === 'array') ch = byName.get(ch.attrs.of?.ref);
      const chLayer = ch?.attrs.layer?.ref;
      if (!a.gate?.ref || !chLayer) { out.push({ cross: cross.name, unsupported: 'no gate or channel layer' }); continue; }
      expr = { call: 'intersect', args: [a.gate, { ref: chLayer }] };
    }
    let comps;
    try { comps = evalGeom(expr, 1); } catch (e) { if (!(e instanceof Unsupported)) throw e; out.push({ cross: cross.name, unsupported: e.message }); continue; }
    const models = (cross.children ?? []).filter((c) => c.kind === 'model').map(modelSelector);
    const markerNames = [...new Set(models.flatMap((m) => [...m.markers, ...m.exclude]))];
    // markers may be computed (from = ...): evaluate them like any operand
    const markerRects = new Map();
    try { for (const mk of markerNames) markerRects.set(mk, evalOperand(mk).flatMap((x) => x.rects)); } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      out.push({ cross: cross.name, unsupported: `marker: ${e.message}` });
      continue;
    }
    for (const c of comps) {
      const covering = new Set(), touching = new Set();
      for (const mk of markerNames) {
        const rs = markerRects.get(mk);
        if (c.rects.some((r) => rs.some((q) => overlaps(r, q)))) touching.add(mk);
        if (c.rects.every((r) => covered(r, rs))) covering.add(mk);
      }
      const byPol = {}, selection = {};
      for (const pol of ['n', 'p']) {
        byPol[pol] = selectModels(cross, covering, touching, pol).map((m) => m.name);
        selection[pol] = byPol[pol].length === 1 ? 'ok' : byPol[pol].length ? 'ambiguous' : 'none';
      }
      const partial = [...touching].filter((x) => !covering.has(x));
      out.push({ cross: cross.name, bbox: c.bbox, markers: [...covering].sort(), partial, models: byPol, selection });
    }
  }
  return out;
}
