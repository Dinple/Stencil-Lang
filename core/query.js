// The query API over a resolved Stencil technology (doc/API.md), in
// JavaScript: the same queries as the Python package, in camelCase.
//
//   import { Technology } from './core/query.js';
//   const t = Technology.fromProject({ main, load });     // or fromSource / fromResolved
//   t.minSpacing('M1', { axis: 'x' }).value.toString()   // '14'
//
// Lengths are exact rationals (core/rational.js Q) in nanometres; areas nm^2.
// Inputs accept integers, Q, bigint, strings ('12', '-14.5', '1e-3', '29/2')
// and numbers (read as their shortest decimal). Options are plain objects;
// an unknown option is a TypeError, a bad value a RangeError. Records are frozen.

import { Q } from './rational.js';
import { resolveProject, resolveSource } from './resolve.js';
import { canonical } from './canon.js';
import { sha256Hex } from './sha256.js';
import { expandSite, modelSelector } from './template.js';
import { checkRules, recognizeDevices } from './rulecheck.js';
import { checkProfile, routingScope, tracksMode } from './profile.js';

// ---- errors ------------------------------------------------------------------------
export class StencilError extends Error { get name() { return this.constructor.name; } }
export class ResolveError extends StencilError { constructor(message, diagnostics = []) { super(message); this.diagnostics = diagnostics; } }
export class UnknownName extends StencilError {}
export class AmbiguousError extends StencilError {}
// .rules: [[rule name, what it needs], ...]
export class UnresolvedRuleError extends StencilError {
  constructor(rules) {
    super(`cannot decide ${rules.map(([n, need]) => `${n} (needs ${need})`).join('; ')}, pass the condition, or ignore: [...] to leave a rule out`);
    this.rules = rules;
  }
}

// ---- constants and numbers ------------------------------------------------------------
const SYMMETRIC = new Set(['spacing', 'cut_spacing', 'corner_spacing']);
const THRESHOLD = new Set(['width', 'length', 'min_length', 'area', 'spacing', 'cut_spacing', 'corner_spacing', 'eol_spacing', 'enclosure', 'extension']);
const ALIASES = new Set(['min_length', 'length']);            // the only kinds a query may combine
const LENGTH_ATTRS = new Set(['value', 'width_below', 'width_above', 'prl', 'within']);
const FACES = ['top', 'bottom', 'left', 'right'];
const LIMITS = new Map([['min', ['min', 'exact']], ['max', ['max', 'exact']], ['exact', ['exact']]]);
const INVALID = 'a valid definition (the resolver reported errors on this rule)';
const ZERO = Q.int(0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// An input number, exactly (the same grammar as the Python API).
export function toQ(x) {
  if (x instanceof Q) return x;
  if (typeof x === 'bigint') return new Q(x);
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new RangeError(`not a finite number: ${x}`);
    return Number.isInteger(x) ? Q.int(x) : parseNumber(String(x), x);
  }
  if (typeof x === 'string') return parseNumber(x.trim(), x);
  throw new TypeError(`expected a number, got ${x === null ? 'null' : typeof x}`);
}
function parseNumber(s, orig) {
  let m = /^(-?\d+)\/(\d+)$/.exec(s);
  if (m) {
    if (BigInt(m[2]) === 0n) throw new RangeError(`not a number: '${orig}' (zero denominator)`);
    return new Q(BigInt(m[1]), BigInt(m[2]));
  }
  m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) throw new RangeError(`not a number: '${orig}'`);
  let q = Q.decimal(m[3] ? `${m[2]}.${m[3]}` : m[2]);
  if (m[4]) { const e = BigInt(m[4]); q = e >= 0n ? q.mul(new Q(10n ** e)) : q.div(new Q(10n ** -e)); }
  return m[1] ? q.neg() : q;
}
// Resolved-form values (integers, 'n/d' strings) -> Q, else null.
function rq(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return Q.int(v);
  if (typeof v === 'string' && /^-?\d+(\/\d+)?$/.test(v)) { const [n, d = '1'] = v.split('/'); return d.replace(/0/g, '') === '' ? null : new Q(BigInt(n), BigInt(d)); }
  return null;
}
const refOf = (v) => (v && typeof v === 'object' && typeof v.ref === 'string' ? v.ref : null);
const isRef = (v) => refOf(v) !== null;
const strOrNull = (v) => (typeof v === 'string' ? v : null);
// A value for an error message; never throws (a JSON object may shadow toString,
// JSON.stringify throws on a bigint), so a rejection keeps its own error class.
export function shown(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return `${v}`;
  if (v instanceof Q) { try { return `${v.n}/${v.d}`.replace(/\/1$/, ''); } catch { return '<value>'; } }
  try { const j = JSON.stringify(v); if (j !== undefined) return j; } catch { /* below */ }
  try { return String(v); } catch { return '<value>'; }
}
const nameOf = (o) => strOrNull(o.name);
const freeze = (o) => Object.freeze(o);
const maxQ = (xs) => xs.reduce((a, b) => (b.cmp(a) > 0 ? b : a));
const minQ = (xs) => xs.reduce((a, b) => (b.cmp(a) < 0 ? b : a));
const truthyFrom = (v) => !!v;

// Options: a plain object with known keys; null / undefined values mean "not given".
function options(o, allowed, where) {
  if (o === undefined || o === null) return {};
  if (typeof o !== 'object' || Array.isArray(o)) throw new TypeError(`${where}: options are an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new TypeError(`${where}: unknown option '${k}'`);
  const out = Object.create(null);
  for (const k of allowed) if (hasOwn(o, k) && o[k] !== null && o[k] !== undefined) out[k] = o[k];
  return out;
}
function flag(name, v) {
  if (v !== undefined && typeof v !== 'boolean') throw new TypeError(`${name} must be true, false or omitted, not ${shown(v)}`);
  return v ?? null;
}
function names(name, v) {
  if (v === undefined) return null;
  if (typeof v === 'string' || !v || v instanceof Map || typeof v[Symbol.iterator] !== 'function') throw new TypeError(`${name} is a collection of names`);
  const out = [...v];
  if (!out.every((x) => typeof x === 'string')) throw new TypeError(`${name} must hold names (strings)`);
  return out;
}

// The first integer beyond +/-(2^53 - 1) in a JSON value, else null.
function unsafeInt(v) {
  const stack = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'number' && Number.isInteger(x) && !Number.isSafeInteger(x)) return x;
    if (x && typeof x === 'object') for (const y of Object.values(x)) stack.push(y);
  }
  return null;
}

function optionalName(what, v) {
  if (v !== undefined && typeof v !== 'string') throw new TypeError(`${what} is a name, not ${shown(v)}`);
}
function kindsOf(kind) {
  const kinds = typeof kind === 'string' ? [kind] : Array.isArray(kind) ? [...kind] : null;
  if (!kinds || !kinds.every((k) => typeof k === 'string')) throw new TypeError(`kind is a rule kind or a list of them, not ${shown(kind)}`);
  return kinds;
}
function operandsOf(on) {
  const ops = typeof on === 'string' ? [on] : Array.isArray(on) ? [...on] : null;
  if (!ops || !ops.every((x) => typeof x === 'string')) throw new TypeError(`on is a name or a list of names, not ${shown(on)}`);
  return ops;
}
const measureOf = (r) => r.attrs.measure ?? 'edge';
// The common measure of applied rules (AmbiguousError when they differ).
function oneMeasure(applied) {
  const ms = new Set(applied.map(([r]) => measureOf(r)));
  if (ms.size > 1) throw new AmbiguousError(`rules measure differently (edge and center): ${applied.map(([r]) => r.name ?? '?').join(', ')}`);
  return ms.size ? [...ms][0] : 'edge';
}

// ---- records ---------------------------------------------------------------------------
export class Size {
  constructor(kind, values) { this.kind = kind; this.values = freeze(values); freeze(this); }
  get min() { return this.values.length ? minQ(this.values) : null; }
  get max() { return this.values.length ? maxQ(this.values) : null; }
  get fixed() { return this.kind === 'fixed' ? this.values[0] : null; }
  contains(x) {
    const q = toQ(x);
    if (this.kind === 'range') return q.cmp(this.values[0]) >= 0 && q.cmp(this.values[1]) <= 0;
    if (this.kind === 'fill') return q.cmp(ZERO) > 0 && q.isInt();
    return this.values.some((v) => v.eq(q));
  }
}

export class SiteTemplate {
  constructor(fields) { Object.assign(this, fields); freeze(this); }
  // The track grids on `layer`, one per row that has one.
  tracks(layer) { return freeze(this.grids.filter((g) => g.layer === layer)); }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export class Technology {
  // ---- loading ------------------------------------------------------------------------
  constructor(resolved, opts = {}) {
    const o = options(opts, ['diagnostics', 'allowIncomplete'], 'Technology');
    if (o.diagnostics !== undefined && !Array.isArray(o.diagnostics)) throw new TypeError('diagnostics is a list');
    const diagnostics = (o.diagnostics ?? []).filter((d) => isObj(d));
    const allowIncomplete = flag('allowIncomplete', o.allowIncomplete) ?? false;
    if (!isObj(resolved) || !Array.isArray(resolved.objects)) throw new StencilError("not a resolved Stencil technology (no 'objects' list)");
    resolved.objects.forEach((o, i) => {
      if (!(isObj(o) && typeof o.kind === 'string' && isObj(o.attrs) && (o.children === undefined || (Array.isArray(o.children) && o.children.every((c) => isObj(c) && typeof c.kind === 'string' && isObj(c.attrs))))))
        throw new StencilError(`object ${i} is not a resolved object (kind, attrs, children)`);
    });
    const bad = unsafeInt(resolved);
    if (bad !== null) throw new StencilError(`the integer ${bad} is beyond +/-(2^53 - 1), which JSON readers do not hold exactly`);
    this.resolved = resolved;
    this.diagnostics = freeze(diagnostics.map((d) => freeze({ code: d.code, severity: d.severity, message: d.message, file: d.file ?? null, line: d.line ?? null, col: d.col ?? null, hint: d.hint ?? null })));
    this.complete = resolved.complete !== false;
    this.hash = resolved.hash || `sha256:${sha256Hex(canonical(resolved))}`;
    if (!this.complete && !allowIncomplete) {
      const errs = this.diagnostics.filter((d) => d.severity === 'error');
      const msg = errs.slice(0, 5).map((d) => `${shown(d.file)}:${shown(d.line)}:${shown(d.col)}: ${shown(d.code)}: ${shown(d.message)}`).join('; ') || 'the resolved form is marked incomplete';
      throw new ResolveError(`technology did not resolve cleanly: ${msg}`, this.diagnostics);
    }
    const g = resolved.grid_nm ?? 1;
    this._grid = rq(g);
    if (!this._grid || this._grid.cmp(ZERO) <= 0) throw new StencilError(`bad grid_nm ${shown(g)}`);
    this._objects = resolved.objects;
    this._by = new Map(resolved.objects.filter((o) => typeof o.name === 'string' && o.name).map((o) => [o.name, o]));
  }

  // Resolve a project in-process: load(path) -> source text or null.
  static fromProject({ main, load }, opts = {}) {
    const r = resolveProject({ main, load });
    return new Technology(r.resolved, { diagnostics: r.diags, ...options(opts, ['allowIncomplete'], 'fromProject') });
  }
  static fromSource(src, opts = {}) {
    const r = resolveSource(src);
    return new Technology(r.resolved, { diagnostics: r.diags, ...options(opts, ['allowIncomplete'], 'fromSource') });
  }
  // A resolved form, or the {resolved, diagnostics} bundle of cli.mjs --with-diagnostics.
  static fromResolved(data, opts = {}) {
    const o = options(opts, ['allowIncomplete'], 'fromResolved');
    if (data && data.resolved && !data.objects) return new Technology(data.resolved, { diagnostics: data.diagnostics ?? [], ...o });
    return new Technology(data, o);
  }

  // ---- 1. grid and units ------------------------------------------------------------------
  get grid() { return this._grid; }
  dbu(x) {
    const q = toQ(x).div(this._grid);
    if (!q.isInt()) throw new RangeError(`${shown(x)} nm is not on the ${this._grid} nm grid`);
    const n = Number(q.n);
    if (!Number.isSafeInteger(n)) throw new RangeError(`${shown(x)} nm is ${q.n} database units, beyond the exact range of a Number`);
    return n;
  }
  nm(n) {
    if (!Number.isInteger(n)) throw new TypeError(`database units are integers, got ${shown(n)}`);
    if (!Number.isSafeInteger(n)) throw new RangeError(`${n} is beyond the exact range of a Number`);
    return Q.int(n).mul(this._grid);
  }
  snap(x, mode) {
    mode ??= 'nearest';
    const q = toQ(x).div(this._grid);
    const k = mode === 'down' ? q.floor() : mode === 'up' ? q.ceil() : mode === 'nearest' ? q.round() : null;
    if (!k) throw new RangeError(`mode must be nearest, down or up, not '${shown(mode)}'`);
    return k.mul(this._grid);
  }
  _len(v) { const q = rq(v); return q === null ? null : q.mul(this._grid); }
  _size(v, scale = true) {
    const f = (x) => { const q = rq(x); if (q === null) throw BAD_SIZE; return scale ? q.mul(this._grid) : q; };
    try {
      if (v === undefined || v === null) return null;
      if (rq(v) !== null) return new Size('fixed', [f(v)]);
      if (v === 'fill') return new Size('fill', []);
      if (isObj(v) && Array.isArray(v.one_of)) return new Size('one_of', v.one_of.map(f));
      if (isObj(v) && 'min' in v && 'max' in v) return new Size('range', [f(v.min), f(v.max)]);
    } catch (e) { if (e !== BAD_SIZE) throw e; }
    return null;
  }

  // ---- lookup helpers -----------------------------------------------------------------------
  _obj(name, kinds) {
    kinds = [].concat(kinds);
    const o = typeof name === 'string' ? this._by.get(name) : undefined;
    if (!o || !kinds.includes(o.kind)) throw new UnknownName(`no ${kinds.join(' or ')} named '${shown(name)}'`);
    return o;
  }
  _ofKind(kind) { return this._objects.filter((o) => o.kind === kind); }
  static _byOrder(objs) {
    const key = (o) => (Number.isFinite(o.attrs.order) ? o.attrs.order : null);
    return [...objs].sort((a, b) => (key(a) === null) - (key(b) === null) || (key(a) ?? 0) - (key(b) ?? 0));
  }

  // ---- 2-3. layers -----------------------------------------------------------------------------
  _layer(o) {
    const a = o.attrs;
    let lat = a;
    const arr = this._by.get(refOf(a.tracks));
    if (!('pitch' in a) && arr?.kind === 'array') lat = arr.attrs;
    const pair = (v) => (Array.isArray(v) && v.length === 2 ? freeze([...v]) : null);
    return freeze({
      name: nameOf(o), order: Number.isInteger(a.order) ? a.order : null, role: a.role ?? null, side: a.side ?? null, direction: a.direction ?? null,
      width: this._size(a.width), pitch: 'pitch' in lat ? this._len(lat.pitch) : null, offset: 'offset' in lat ? this._len(lat.offset) : null,
      masks: Number.isInteger(a.masks) ? a.masks : 1, tracksMode: a.role === 'conductor' ? tracksMode(o) : null,
      gds: pair(a.gds), gdsPin: pair(a.gds_pin), gdsLabel: pair(a.gds_label), derived: truthyFrom(a.from), note: a.note ?? null,
    });
  }
  layers(opts) {
    const { role, side } = options(opts, ['role', 'side'], 'layers');
    optionalName('role', role);
    optionalName('side', side);
    const objs = this._ofKind('layer').filter((o) => (role === undefined || o.attrs.role === role) && (side === undefined || o.attrs.side === side));
    return freeze(Technology._byOrder(objs).map((o) => this._layer(o)));
  }
  layer(name) { return this._layer(this._obj(name, 'layer')); }

  // ---- 4. routing scope -------------------------------------------------------------------------
  // Placed-only device layers are never included; without a site that bounds it, every other conductor is.
  routingLayers(site) {
    if (site !== undefined && site !== null) this._obj(site, 'site');
    return freeze(Technology._byOrder(routingScope(this.resolved, site == null ? undefined : [site])).map((o) => this._layer(o)));
  }

  // ---- 5. vias -------------------------------------------------------------------------------------
  _via(o) {
    const a = o.attrs;
    const lowers = Array.isArray(a.lower) ? a.lower.map(refOf) : a.lower ? [refOf(a.lower)] : [];
    const pair = (v) => {
      if (v === undefined || v === null) return null;
      if (Array.isArray(v) && v.length === 2) return freeze([this._len(v[0]), this._len(v[1])]);
      const q = this._len(v);
      return q === null ? null : freeze([q, q]);
    };
    const z = freeze([ZERO, ZERO]);
    return freeze({ name: nameOf(o), lower: freeze(lowers), cut: refOf(a.cut), upper: refOf(a.upper), size: pair(a.size), encloseLower: pair(a.enclose_lower) ?? z, encloseUpper: pair(a.enclose_upper) ?? z });
  }
  vias(opts) {
    const { lower, upper } = options(opts, ['lower', 'upper'], 'vias');
    optionalName('lower', lower);
    optionalName('upper', upper);
    return freeze(this._ofKind('connector').map((o) => this._via(o)).filter((v) => (lower === undefined || v.lower.includes(lower)) && (upper === undefined || v.upper === upper)));
  }
  via(lower, upper) {
    operandsOf([lower, upper]);
    const vs = this.vias({ lower, upper });
    if (!vs.length) throw new UnknownName(`no connector from ${lower} up to ${upper}`);
    if (vs.length > 1) throw new AmbiguousError(`${vs.length} connectors from ${lower} up to ${upper}: ${vs.map((v) => v.name).join(', ')}`);
    return vs[0];
  }

  // ---- 6-7. cell templates ----------------------------------------------------------------------------
  sites() { return freeze(this._ofKind('site').map(nameOf)); }
  site(name, opts) {
    const { units = 1 } = options(opts, ['units'], 'site');
    if (name === undefined || name === null) {
      const used = new Set(this._ofKind('site').flatMap((s) => (s.children ?? []).filter((c) => c.kind === 'row').map((c) => refOf(c.attrs.site))));
      const top = this.sites().filter((n) => typeof n === 'string' && !used.has(n));
      if (top.length !== 1) throw new AmbiguousError(`name the site: ${top.join(', ') || 'every site is a row of another'}`);
      name = top[0];
    }
    const o = this._obj(name, 'site');
    if (!Number.isInteger(units) || units < 1) throw new RangeError(`units must be a positive integer, not ${shown(units)}`);
    const x = expandSite(this.resolved, name, { units });
    if (x.problems.length) throw new StencilError(`site ${name} does not expand cleanly: ${x.problems.map((p) => p.message).join('; ')}`);
    if (x.cellWidth === undefined) throw new StencilError(`site ${name} has no width or height`);
    const L = (v) => this._len(v);
    const a = o.attrs;
    return new SiteTemplate({
      name, width: L(x.width), cellWidth: L(x.cellWidth), units, height: L(x.height),
      rails: freeze(x.rails.map((r) => freeze({ name: r.name, net: r.net ?? null, layer: r.layer ?? null, y: L(r.y), width: r.width === undefined ? null : L(r.width), sharedWith: freeze((r.shared ?? []).filter((n) => n !== r.name)) }))),
      bands: freeze(x.bands.map((b) => freeze({ name: b.name, polarity: b.polarity, stratum: b.stratum ?? null, y0: L(b.y0), y1: L(b.y1), flipped: b.flipped }))),
      edges: freeze(x.edges.map((e) => freeze({ name: e.name, layer: e.layer ?? null, side: e.side, shared: e.shared, x0: L(e.x0), y0: L(e.y0), x1: L(e.x1), y1: L(e.y1) }))),
      pins: freeze(Array.isArray(a.pins) ? a.pins.map(refOf) : []), boundary: refOf(a.boundary), symmetry: freeze(Array.isArray(a.symmetry) ? [...a.symmetry] : []),
      grids: freeze(x.tracks.map((t) => freeze({ name: t.name, layer: t.layer, axis: t.axis, positions: freeze(t.positions.map(L)), usable: freeze([...t.use]), span: freeze([L(t.span[0]), L(t.span[1])]) }))),
    });
  }

  // ---- 8-12. rules -------------------------------------------------------------------------------------
  _rule(o) {
    const a = o.attrs;
    const area = a.kind === 'area';
    const on = Array.isArray(a.on) ? a.on.map(refOf) : [refOf(a.on)];
    const conv = (k, v) => {
      if (LENGTH_ATTRS.has(k) && rq(v) !== null) return rq(v).mul(area && k === 'value' ? this._grid.mul(this._grid) : this._grid);
      if (isRef(v)) return v.ref;
      return v;
    };
    const attrs = Object.create(null);
    for (const [k, v] of Object.entries(a)) if (!['on', 'kind', 'intent'].includes(k)) attrs[k] = conv(k, v);
    const children = (o.children ?? []).map((c) => {
      const ca = Object.assign(Object.create(null), c.attrs);
      for (const k of ['width', 'prl', 'margins']) if (Array.isArray(ca[k])) ca[k] = freeze(ca[k].map((x) => this._len(x)));
      if (Array.isArray(ca.values)) ca.values = freeze(ca.values.map((row) => (Array.isArray(row) ? freeze(row.map((x) => this._len(x))) : null)));
      if ('value' in ca) ca.value = this._len(ca.value);
      return freeze({ kind: c.kind, name: nameOf(c), attrs: freeze(ca) });
    });
    return freeze({ name: nameOf(o), kind: a.kind ?? null, on: freeze(on), intent: a.intent ?? 'pdk', attrs: freeze(attrs), children: freeze(children), _invalid: o.invalid === true || (o.children ?? []).some((c) => c.invalid === true) });
  }
  _rules() { return (this._ruleCache ??= this._ofKind('rule').map((o) => this._rule(o))); }
  rules(opts) {
    const o = options(opts, ['on', 'kind', 'includeCheckerOnly'], 'rules');
    const { on, kind } = o;
    const includeCheckerOnly = flag('includeCheckerOnly', o.includeCheckerOnly) ?? false;
    if (on !== undefined && typeof on !== 'string') throw new TypeError(`on is a name, not ${shown(on)}`);
    const kinds = kind === undefined ? null : kindsOf(kind);
    return freeze(this._rules().filter((r) => (on === undefined || r.on.includes(on)) && (!kinds || kinds.includes(r.kind)) && (includeCheckerOnly || r.intent !== 'checker_only')));
  }

  // ['apply', threshold] | ['skip'] | ['unknown', needs]
  _decide(r, q, axisIsCondition = true) {
    const a = r.attrs;
    const needs = [];
    let skip = false;
    if (r._invalid) needs.push(INVALID);
    if (r.children.some((c) => c.kind === 'case')) needs.push('case contexts (via_end / open_end)');
    if (r.kind === 'extension' && a.axis == null) needs.push(INVALID);
    if ([...LENGTH_ATTRS].some((k) => k in a && !(a[k] instanceof Q))) needs.push(INVALID);   // a threshold or condition that is not a length
    if (axisIsCondition && a.axis != null) {
      if (q.axis == null) needs.push('axis');
      else if (q.axis !== a.axis) skip = true;
    }
    const num = (k) => a[k] instanceof Q;
    for (const [k, test] of [['width_below', (w, t) => w.cmp(t) < 0], ['width_above', (w, t) => w.cmp(t) > 0]]) {
      if (!(k in a)) continue;
      if (q.width == null) needs.push('width');
      else if (num(k) && !test(q.width, a[k])) skip = true;
    }
    if ('prl' in a) {
      if (q.prl == null) needs.push('prl');
      else if (num('prl') && q.prl.cmp(a.prl) < 0) skip = true;
    }
    for (const k of ['same_net', 'same_color']) {
      if (!(k in a)) continue;
      if (q[k] == null) needs.push(k);
      else if (q[k] !== a[k]) skip = true;
    }
    if ('scope' in a) {
      if (q.scopes == null) needs.push('scopes');
      else if (!q.scopes.includes(a.scope)) skip = true;
    }
    const table = r.children.find((c) => c.kind === 'table');
    if (table) {
      const ta = table.attrs;
      if ('width' in ta && q.width == null) needs.push('width');
      if ('prl' in ta && q.prl == null) needs.push('prl');
      // each index present: lengths, starting at 0, strictly increasing (VOCABULARY.md section 3.6)
      const idxOk = ['width', 'prl'].every((k) => !(k in ta) || (Array.isArray(ta[k]) && ta[k].length > 0 && !ta[k].includes(null)
        && ta[k][0].isZero() && ta[k].every((x, i) => i === 0 || ta[k][i - 1].cmp(x) < 0)));
      const rows = Array.isArray(ta.width) ? ta.width.length : 1, cols = Array.isArray(ta.prl) ? ta.prl.length : 1;
      const vals = ta.values;
      if (!(idxOk && Array.isArray(vals) && vals.length === rows && vals.every((row) => Array.isArray(row) && row.length === cols && !row.includes(null)))) needs.push(INVALID);
    }
    if (axisIsCondition && r.children.some((c) => c.kind === 'alternative')) needs.push('margin alternatives (query them with enclosure())');
    if (skip) return ['skip'];
    if (needs.length) return ['unknown', [...new Set(needs)]];
    if (table) {
      const ta = table.attrs;
      const pick = (bps, x) => { let k = 0; bps.forEach((b, i) => { if (b.cmp(x) <= 0) k = i; }); return k; };
      const rows = ta.width ?? [ZERO], cols = ta.prl ?? [ZERO];
      return ['apply', ta.values[pick(rows, 'width' in ta ? q.width : ZERO)][pick(cols, 'prl' in ta ? q.prl : ZERO)]];
    }
    return ['apply', a.value ?? null];
  }
  _query(o) {
    if (o.axis !== undefined && o.axis !== 'x' && o.axis !== 'y') throw new RangeError(`axis must be 'x' or 'y', not '${shown(o.axis)}'`);
    return {
      width: o.width === undefined ? null : toQ(o.width), prl: o.prl === undefined ? null : toQ(o.prl), axis: o.axis ?? null,
      same_net: flag('sameNet', o.sameNet), same_color: flag('sameColor', o.sameColor), scopes: names('scopes', o.scopes),
    };
  }
  _checkNames(ns) { for (const n of ns) if (typeof n !== 'string' || !this._by.has(n)) throw new UnknownName(`no object named '${shown(n)}'`); }

  // Every named operand a region, computed layer or connector is computed from,
  // directly or through other derived operands (intermediate ones included).
  _closure(name) {
    const out = new Set(), todo = [name];
    while (todo.length) {
      const o = this._by.get(todo.pop());
      if (!o) continue;
      const refs = [];
      if (this._derived(o)) {
        const walk = (e) => {
          if (Array.isArray(e)) e.forEach(walk);
          else if (isObj(e)) {
            if (typeof e.ref === 'string') refs.push(e.ref);
            // arguments: a list, or an object indexed by "0", "1", ...
            else if (Array.isArray(e.args)) e.args.forEach(walk);
            else if (isObj(e.args)) Object.values(e.args).forEach(walk);
          }
        };
        walk(o.attrs.from);
      } else if (o.kind === 'connector') {
        const v = this._via(o);
        for (const x of [v.cut, ...v.lower, v.upper]) if (x) refs.push(x);
      }
      for (const x of refs) if (!out.has(x) && x !== name) { out.add(x); todo.push(x); }
    }
    return out;
  }
  _derived(o) { return o.kind === 'region' || (o.kind === 'layer' && !!o.attrs.from); }
  // Why `rule` may constrain shapes of `ns` without naming them.
  _indirect(rule, ns, connectors = true) {
    const out = [];
    if (!rule.on.every((x) => typeof x === 'string')) return out;   // a rule with a broken operand names no layer
    for (const op of rule.on) {
      const o = typeof op === 'string' ? this._by.get(op) : undefined;
      if (!o || ns.includes(op) || !(this._derived(o) || o.kind === 'connector')) continue;
      const c = this._closure(op);
      const hit = [...new Set(ns)].filter((n) => c.has(n)).sort();
      if (hit.length && this._derived(o)) out.push(`its operand ${op} is computed from ${hit.join(', ')}`);
      else if (hit.length && connectors) out.push(`it applies to connector ${op}, which uses ${hit.join(', ')}; ${rule.kind === 'enclosure' ? 'query enclosure() on its cut and layers' : `query on ${op}`}`);
    }
    return out;
  }
  // `name` is `target`, or computed from it.
  _related(name, target) { return name === target || this._closure(name).has(target); }

  // The threshold a generator must honour for rules of `kind` on `on` (see doc/API.md).
  // opts: { limit, width, prl, axis, sameNet, sameColor, scopes, ignore }
  ruleValue(kind, on, opts) {
    const o = options(opts, ['limit', 'width', 'prl', 'axis', 'sameNet', 'sameColor', 'scopes', 'ignore'], 'ruleValue');
    const kinds = kindsOf(kind);
    if (!kinds.length || (kinds.length > 1 && !kinds.every((k) => ALIASES.has(k)))) throw new RangeError(`kinds ${kinds.join(', ') || '(none)'} cannot be combined in one query`);
    for (const k of kinds) {
      if (typeof k !== 'string' || k.startsWith('x_')) throw new RangeError(`${k}: extension kinds have no defined meaning to query; use rules()`);
      if (!THRESHOLD.has(k)) throw new RangeError(`rule kind ${k} has no threshold`);
    }
    const limit = o.limit ?? 'min';
    if (!LIMITS.has(limit)) throw new RangeError(`limit must be min, max or exact, not '${shown(limit)}'`);
    const accepted = LIMITS.get(limit);
    const ops = operandsOf(on);
    if (ops.length < 1 || ops.length > 2) throw new RangeError('on names one or two operands');
    this._checkNames(ops);
    const q = this._query(o);
    const ignore = new Set(names('ignore', o.ignore) ?? []);
    const norm = (t) => (t.length === 1 ? [t[0], t[0]] : [...t]).sort();
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    // cut spacing of a connector's cuts: rules on its cut layer apply to them too
    const conn = new Set(ops).size === 1 ? this._by.get(ops[0]) : undefined;   // "C", ["C"] and ["C", "C"] alike
    const alias = conn?.kind === 'connector' && kinds.includes('cut_spacing') && this._by.has(this._via(conn).cut) ? [this._via(conn).cut] : null;
    const matchOne = (r, want) => (SYMMETRIC.has(r.kind) ? same(norm(r.on), norm(want)) : r.on.length === want.length && r.on.every((x, i) => x === want[i]));
    // a rule with a broken operand names no layer
    const matches = (r) => r.on.every((x) => typeof x === 'string') && (matchOne(r, ops) || (!!alias && r.kind === 'cut_spacing' && matchOne(r, alias)));
    // a scalar enclosure on a connector: rules on its [cut, layer] pairs constrain its cuts too
    const pairs = [];
    if (conn?.kind === 'connector' && kinds.includes('enclosure')) {
      const v = this._via(conn);
      for (const l of [...v.lower, v.upper]) if (v.cut && l) pairs.push([v.cut, l]);
    }
    const pairHits = (r) => {
      if (r.kind !== 'enclosure' || r.on.length !== 2 || !r.on.every((x) => typeof x === 'string')) return [];
      return pairs.filter(([c, l]) => this._related(r.on[0], c) && this._related(r.on[1], l))
        .map(([c, l]) => `it applies to the cuts of connector ${ops[0]} in ${l}; query enclosure(${c}, ${l})`).slice(0, 1);
    };
    const indirect = (r) => [...this._indirect(r, ops), ...(alias ? this._indirect(r, alias, false) : []), ...(pairs.length ? pairHits(r) : [])];
    const lim = (r) => r.attrs.limit ?? 'min';
    const decideAll = (rules) => {
      const applied = [], unknown = [];
      for (const r of rules) {
        const [verdict, x] = this._decide(r, q);
        if (verdict === 'apply') { if (x instanceof Q) applied.push([r, x]); else unknown.push([r.name, INVALID]); }
        else if (verdict === 'unknown') unknown.push(...x.map((need) => [r.name, need]));
      }
      return [applied, unknown];
    };
    const every = this.rules({ kind: kinds }).filter((r) => !ignore.has(r.name));
    const indirectOther = every.filter((r) => !accepted.includes(lim(r)) && !matches(r)).flatMap((r) => indirect(r).map((why) => [r.name, why]));
    const pool = every.filter((r) => accepted.includes(lim(r)));
    const cands = pool.filter(matches);
    const unknown = pool.filter((r) => !matches(r)).flatMap((r) => indirect(r).map((why) => [r.name, why]));
    if (!cands.length && !unknown.length) return null;
    const [applied, more] = decideAll(cands);
    unknown.push(...more);
    if (unknown.length) throw new UnresolvedRuleError(unknown);
    if (!applied.length) return freeze({ value: null, limit, rules: freeze([]), measure: oneMeasure([]) });
    const exact = applied.filter(([r]) => lim(r) === 'exact');
    const bounds = applied.filter(([r]) => lim(r) !== 'exact');
    // the bounds in the other direction, for consistency (min rules for a max query, and so on)
    const others = every.filter((r) => matches(r) && (lim(r) === 'min' || lim(r) === 'max') && !accepted.includes(lim(r)));
    const [opposite, open] = decideAll(others);
    const measure = oneMeasure([...applied, ...opposite]);   // thresholds of different measures do not compare
    const word = (r) => (lim(r) === 'min' ? 'at least' : 'at most');
    if (exact.length) {
      if (exact.some(([, v]) => !v.eq(exact[0][1]))) throw new AmbiguousError(`exact thresholds disagree: ${exact.map(([r, v]) => `${r.name} = ${v}`).join(', ')}`);
      const v = exact[0][1];
      if (open.length || indirectOther.length) throw new UnresolvedRuleError([...indirectOther, ...open]);   // an exact answer must be checked against every bound
      const clash = [...bounds, ...opposite].filter(([r, b]) => (lim(r) === 'min' ? b.cmp(v) > 0 : b.cmp(v) < 0));
      if (clash.length) throw new AmbiguousError(`no value satisfies ${exact[0][0].name} (exactly ${v}) and ${clash.map(([r, b]) => `${r.name} (${word(r)} ${b})`).join(', ')}`);
      return freeze({ value: v, limit: 'exact', rules: freeze(exact.map(([r]) => r.name)), measure });
    }
    const vals = bounds.map(([, v]) => v);
    const best = limit === 'min' ? maxQ(vals) : minQ(vals);
    const clash = opposite.filter(([, b]) => (limit === 'min' ? b.cmp(best) < 0 : b.cmp(best) > 0));
    if (clash.length) throw new AmbiguousError(`no value satisfies ${limit === 'min' ? 'at least' : 'at most'} ${best} and ${clash.map(([r, b]) => `${r.name} (${word(r)} ${b})`).join(', ')}`);
    return freeze({ value: best, limit, rules: freeze(bounds.filter(([, v]) => v.eq(best)).map(([r]) => r.name)), measure });
  }
  minWidth(layer, opts) { return this.ruleValue('width', layer, opts); }
  minLength(layer, opts) { return this.ruleValue(['min_length', 'length'], layer, opts); }
  minArea(layer, opts) { return this.ruleValue('area', layer, opts); }
  // minSpacing(a, opts) or minSpacing(a, b, opts); width: the wider shape.
  minSpacing(a, b, opts) {
    if (b !== undefined && b !== null && typeof b === 'object' && !Array.isArray(b)) { opts = b; b = undefined; }
    const o = options(opts, ['width', 'prl', 'axis', 'sameNet', 'sameColor', 'scopes', 'ignore'], 'minSpacing');
    return this.ruleValue('spacing', b == null ? [a] : [a, b], o);
  }

  // The margin sets `outer` must leave around `inner`: any one suffices (doc/API.md).
  enclosure(inner, outer, opts) {
    const o = options(opts, ['width', 'scopes', 'ignore'], 'enclosure');
    operandsOf([inner, outer]);
    this._checkNames([inner, outer]);
    const q = this._query({ width: o.width, scopes: o.scopes });
    const ignore = new Set(names('ignore', o.ignore) ?? []);
    const conns = new Set(), related = new Map();
    for (const c of this._ofKind('connector')) {
      const v = this._via(c);
      if (typeof c.name !== 'string') continue;                 // an unnamed connector cannot be a rule operand
      if (v.cut === inner && [...v.lower, v.upper].includes(outer)) conns.add(c.name);
      if (v.cut && this._related(v.cut, inner)) {
        // every obligation [cut, layer] computed from [inner, outer], beyond the direct one
        const layers = [...v.lower, v.upper].filter((l) => l && this._related(l, outer) && !(v.cut === inner && l === outer));
        if (layers.length) related.set(c.name, `it applies to connector ${c.name}, whose ${v.cut} in ${layers.join(', ')} is computed from ${inner} in ${outer}`);
      }
    }
    const pool = this.rules({ kind: 'enclosure' }).filter((r) => !ignore.has(r.name) && r.on.every((x) => typeof x === 'string'));
    const direct = (r) => (r.on.length === 2 && r.on[0] === inner && r.on[1] === outer) || (r.on.length === 1 && conns.has(r.on[0]));
    const cands = pool.filter(direct);
    const unknown = [];
    for (const r of pool) {
      if (r.on.length === 1 && related.has(r.on[0])) unknown.push([r.name, related.get(r.on[0])]);   // a connector with a derived obligation (direct or not)
      // rules on regions or computed layers derived from inner / outer
      else if (!direct(r)) unknown.push(...this._indirect(r, [inner, outer]).filter((why) => !why.startsWith('it applies to connector')).map((why) => [r.name, why]));
    }
    if (!cands.length && !unknown.length) return null;
    let sets = [[ZERO, ZERO, ZERO, ZERO]];
    for (const r of cands) {
      if ((r.attrs.limit ?? 'min') !== 'min') throw new StencilError(`rule ${r.name}: enclosure with limit ${shown(r.attrs.limit)}, read it with rules()`);
      const [verdict, v] = this._decide(r, q, false);
      if (verdict === 'unknown') { unknown.push(...v.map((need) => [r.name, need])); continue; }
      if (verdict === 'skip') continue;
      let alts = r.children.filter((c) => c.kind === 'alternative').map((c) => c.attrs.margins);
      if (!alts.length) {
        if (!(v instanceof Q)) { unknown.push([r.name, INVALID]); continue; }
        alts = [r.attrs.axis === 'x' ? [v, v, ZERO, ZERO] : r.attrs.axis === 'y' ? [ZERO, ZERO, v, v] : [v, v, v, v]];
      }
      if (alts.some((m) => !Array.isArray(m) || m.length !== 4 || m.includes(null) || !m.every((x) => x instanceof Q))) { unknown.push([r.name, INVALID]); continue; }
      const next = [];
      for (const s of sets) for (const m of alts) {
        const t = s.map((x, k) => (m[k].cmp(x) > 0 ? m[k] : x));
        if (!next.some((u) => u.every((x, k) => x.eq(t[k])))) next.push(t);
      }
      sets = next;
    }
    if (unknown.length) throw new UnresolvedRuleError(unknown);
    // drop sets that ask for more than another set on every side
    const keep = sets.filter((s) => !sets.some((t) => t !== s && t.every((x, k) => x.cmp(s[k]) <= 0)));
    return freeze(keep.map(([left, right, bottom, top]) => freeze({ left, right, bottom, top })));
  }

  // ---- 13-14. devices ------------------------------------------------------------------------------------
  devices() { return freeze(this._ofKind('cross').map((o) => new Device(this, o))); }
  device(name) { return new Device(this, this._obj(name, 'cross')); }

  // ---- 15-16. checking -------------------------------------------------------------------------------------
  _shapes(shapes) {
    if (shapes == null || typeof shapes === 'string' || shapes instanceof Map || typeof shapes[Symbol.iterator] !== 'function') throw new TypeError('shapes is a list of shapes');
    return [...shapes].map((s, i) => {
      const d = Array.isArray(s) && s.length === 2 ? { layer: s[0], rect: s[1] } : s;
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new TypeError(`shape ${i}: an object or [layer, rect]`);
      if (typeof d.layer !== 'string') throw new RangeError(`shape ${i}: no layer`);
      if (!Array.isArray(d.rect) || d.rect.length !== 4) throw new RangeError(`shape ${i}: rect is [x0, y0, x1, y1]`);
      let rect;
      try { rect = d.rect.map((v) => this.dbu(v)); } catch (e) { throw new (e instanceof TypeError ? TypeError : RangeError)(`shape ${i}: ${e.message}`); }
      const out = { layer: d.layer, rect };
      for (const k of ['net', 'color', 'connector']) if (d[k] != null) out[k] = d[k];
      return out;
    });
  }
  _measured(text, area) {
    const g = area ? this._grid.mul(this._grid) : this._grid, g2 = this._grid.mul(this._grid);
    let m = /^(centre distance )?sqrt\((-?\d+(?:\/\d+)?)\)$/.exec(text);
    if (m) return `${m[1] ?? ''}sqrt(${rq(m[2]).mul(g2)})`;
    m = /^(centre distance )?(-?\d+(?:\/\d+)?)$/.exec(text);
    if (m) return `${m[1] ?? ''}${rq(m[2]).mul(g)}`;
    return text;
  }
  // The reference rule checker (VOCABULARY.md section 3) on rectangles in nm.
  check(shapes, mode) {
    mode ??= 'generator';
    if (mode !== 'generator' && mode !== 'checker') throw new RangeError(`mode must be generator or checker, not '${shown(mode)}'`);
    let r;
    try { r = checkRules(this.resolved, { shapes: this._shapes(shapes) }, { mode }); } catch (e) { throw e.constructor === Error && /^shape \d+:/.test(e.message) ? new RangeError(e.message) : e; }
    const kinds = new Map(this._ofKind('rule').map((o) => [nameOf(o), o.attrs.kind]));
    const violations = r.violations.map((v) => {
      const name = typeof v.rule === 'string' ? v.rule : null;
      const area = kinds.get(name) === 'area';
      const t = v.threshold === undefined ? null : rq(v.threshold).mul(area ? this._grid.mul(this._grid) : this._grid);
      return freeze({ rule: name, kind: v.kind ?? null, shapes: freeze([...v.subjects]), measured: this._measured(v.measured, area), threshold: t, limit: v.limit, detail: v.detail ?? null });
    });
    return freeze({ complete: r.complete, violations: freeze(violations), unsupported: freeze(r.unsupported.map((u) => freeze({ rule: typeof u.rule === 'string' ? u.rule : null, kind: u.kind ?? null, reason: u.reason }))) });
  }
  // Devices in a layout, with the markers over them and their candidate models.
  recognize(shapes) {
    let out;
    try { out = recognizeDevices(this.resolved, { shapes: this._shapes(shapes) }); } catch (e) { throw e.constructor === Error && /^shape \d+:/.test(e.message) ? new RangeError(e.message) : e; }
    const devices = [], unsupported = [];
    for (const d of out) {
      const cross = typeof d.cross === 'string' ? d.cross : null;
      if (d.unsupported) { unsupported.push(freeze({ object: cross, message: d.unsupported })); continue; }
      const b = d.bbox;
      devices.push(freeze({ device: cross, bbox: freeze([b.x0, b.y0, b.x1, b.y1].map((v) => this.nm(v))), markers: freeze([...d.markers]), partial: freeze([...d.partial]),
        models: freeze(Object.assign(Object.create(null), { n: freeze(d.models.n.map(strOrNull)), p: freeze(d.models.p.map(strOrNull)) })),
        selection: freeze(Object.assign(Object.create(null), d.selection)) }));
    }
    return freeze({ complete: !unsupported.length, devices: freeze(devices), unsupported: freeze(unsupported) });
  }

  // ---- 17. tool profiles ---------------------------------------------------------------------------------------
  profiles() { return freeze(this._ofKind('profile').map(nameOf)); }
  supports(profile, opts) {
    const { source } = options(opts, ['source'], 'supports');
    if (source !== undefined && !(source instanceof Technology)) throw new TypeError('source is a Technology');
    const p = (source ?? this)._obj(profile, 'profile');
    return freeze([...checkProfile(this.resolved, p)].map((f) => freeze({ object: typeof f.object === 'string' ? f.object : null, message: f.message })));
  }
}
const BAD_SIZE = Symbol('bad size');

// A transistor structure (a `cross`): gate, channel, faces, sizes and models.
export class Device {
  constructor(tech, o) {
    this._t = tech;
    const a = o.attrs;
    this.name = nameOf(o);
    this.gate = refOf(a.gate);
    const ch = tech._by.get(refOf(a.channel));
    this._array = ch?.kind === 'array' ? ch : null;
    const fig = this._array ? tech._by.get(refOf(ch.attrs.of)) : ch;
    this._figure = fig?.kind === 'figure' ? fig : null;
    this.channelFigure = this._figure?.name ?? null;
    this.channelLayer = this._figure ? refOf(this._figure.attrs.layer) : null;
    this.faces = freeze(a.faces === 'all' ? [...FACES] : (Array.isArray(a.faces) ? a.faces : []).filter((f) => FACES.includes(f)));
    this.stratum = refOf(a.stratum);
    const sizes = Object.create(null);
    for (const c of (o.children ?? []).filter((x) => x.kind === 'size' && typeof x.name === 'string')) {
      const sets = isObj(c.attrs.sets) ? c.attrs.sets : {};
      const target = typeof sets.ref === 'string' ? sets.ref : null, attr = typeof sets.attr === 'string' ? sets.attr : null;
      const tobj = target === null ? undefined : tech._by.get(target);
      const tv = tobj && attr !== null && hasOwn(tobj.attrs, attr) ? tobj.attrs[attr] : undefined;
      sizes[c.name] = freeze({ name: c.name, target, attr, domain: tech._size(tv, attr !== 'count') });
    }
    this.sizes = freeze(sizes);
    this.models = freeze((o.children ?? []).filter((c) => c.kind === 'model').map(modelSelector)
      .map((m) => freeze({ name: typeof m.name === 'string' ? m.name : null, polarity: typeof m.polarity === 'string' ? m.polarity : null, markers: freeze([...m.markers]), exclude: freeze([...m.exclude]) })));
    freeze(this);
  }
  // The value of obj.attr: a size parameter's if one sets it, else its own fixed value.
  _value(obj, attr, given, scale) {
    for (const p of Object.values(this.sizes)) if (obj && p.target === obj.name && p.attr === attr && given.has(p.name)) return given.get(p.name);
    if (!obj) return null;
    const s = this._t._size(hasOwn(obj.attrs, attr) ? obj.attrs[attr] : undefined, scale);
    if (!s) return null;
    if (s.kind !== 'fixed') {
      const p = Object.values(this.sizes).find((x) => x.target === obj.name && x.attr === attr);
      throw new RangeError(p ? `${obj.name}.${attr} is not fixed: give the size ${p.name}` : `${obj.name}.${attr} is not fixed`);
    }
    return s.values[0];
  }
  // Effective width in nm: count x (n_wide*width + n_side*thickness).
  wEff(sizes) {
    sizes ??= {};                                      // null and undefined: no sizes given
    if (!isObj(sizes)) throw new TypeError('wEff: sizes are an object');
    const given = new Map();
    for (const k of Object.keys(sizes)) {
      if (!hasOwn(this.sizes, k)) throw new RangeError(`${this.name} has no size '${k}' (sizes: ${Object.keys(this.sizes).join(', ') || 'none'})`);
      if (sizes[k] == null) continue;                  // null / undefined: this size not given
      const p = this.sizes[k];
      const x = toQ(sizes[k]);
      if (p.attr === 'count' && (!x.isInt() || x.cmp(Q.int(1)) < 0)) throw new RangeError(`${k} = ${shown(sizes[k])}: a count is a positive integer`);
      if (p.domain && !p.domain.contains(x)) throw new RangeError(`${k} = ${shown(sizes[k])} is outside its domain ${p.domain.kind} ${p.domain.values.join(', ')}`);
      given.set(k, x);
    }
    if (!this._figure) throw new StencilError(`${this.name}: no channel figure`);
    const nWide = ['top', 'bottom'].filter((f) => this.faces.includes(f)).length;
    const nSide = ['left', 'right'].filter((f) => this.faces.includes(f)).length;
    const width = nWide ? this._value(this._figure, 'width', given, true) : ZERO;
    const thick = nSide ? this._value(this._figure, 'thickness', given, true) : ZERO;
    if (width === null || thick === null) throw new StencilError(`${this.name}: the channel figure has no ${width === null ? 'width' : 'thickness'}`);
    const count = this._array ? this._value(this._array, 'count', given, false) : Q.int(1);
    if (count === null) throw new StencilError(`${this.name}: the channel array has no count`);
    return count.mul(Q.int(nWide).mul(width).add(Q.int(nSide).mul(thick)));
  }
  // The one model for a device of `polarity` under exactly the `markers` layers.
  selectModel(polarity, markers) {
    const mk = new Set(names('markers', markers ?? []));
    const hits = this.models.filter((m) => m.polarity === polarity && m.markers.every((x) => mk.has(x)) && !m.exclude.some((x) => mk.has(x)));
    if (hits.length !== 1) throw new AmbiguousError(`${this.name}: ${hits.length} models for polarity ${shown(polarity)} with markers [${[...mk].sort().join(', ')}]${hits.length ? `: ${hits.map((m) => m.name).join(', ')}` : ''}`);
    return hits[0];
  }
}
