// Stencil resolver, Core 0.2 (SPEC.md section 3).
//
// A project is a main file plus the modules it imports. Every import creates a
// module instance with its own scope; values flow between instances only
// through parameter bindings and qualified references (`dev.CPP`).
//
// Pipeline:
//   load + parse every file -> build instances (imports, bindings)
//   -> patches -> drops -> base -> evaluate -> cascade drops -> layer order
//   -> vocabulary validation -> checks -> resolved form (SPEC.md section 5)
//
// Resolution is partial: an object with errors is marked invalid and
// everything else still resolves, so a live view can keep drawing.

import { parse } from './parser.js';
import { diag } from './lexer.js';
import { Q } from './rational.js';
import { expandSite, modelSelector, polaritiesOf } from './template.js';
import { KINDS, FUNCTIONS, attrSpec, describeType, enumWords, refKinds, closest, PAIR_RULES, CONTAINMENT_RULES, RULE_CONDITIONS } from './vocab.js';

const ONE = Q.int(1);
const ZERO = Q.int(0);
const now = () => globalThis.performance?.now() ?? Date.now();

class EvalErr extends Error {}

// ---- public API -----------------------------------------------------------------

// Single source text, optionally with a loader for its imports.
export function resolveSource(src, opts = {}) {
  const main = opts.path ?? 'main.stencil';
  const load = (p) => (p === main ? src : opts.load ? opts.load(p) : null);
  return resolveProject({ main, load });
}

// main: path of the main file; load(path) -> source text or null.
export function resolveProject({ main, load }) {
  const t0 = now();
  const s = new Session(load);
  const resolved = s.run(main);
  for (const d of s.diags) {
    const f = s.files.get(d.file);
    const lines = f?.lines ?? [0];
    Object.assign(d, lineCol(lines, d.from, 'line', 'col'), lineCol(lines, d.to, 'end_line', 'end_col'));
  }
  const seen = new Set();
  const diags = s.diags.filter((d) => {
    const key = `${d.file}|${d.instance ?? ''}|${d.code}|${d.from}|${d.to}|${d.message}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  diags.sort((a, b) => (a.file === b.file ? 0 : a.file === main ? -1 : b.file === main ? 1 : a.file < b.file ? -1 : 1) || a.from - b.from || a.to - b.to);
  const files = {};
  for (const [p, f] of s.files) if (f) files[p] = f.src;
  return { ast: s.files.get(main)?.ast, resolved, diags, spans: s.spans, files, ms: now() - t0 };
}

// Module path resolution: "gt2n/device" is relative to the project root,
// "./x" and "../x" are relative to the importing file.
export function resolvePath(fromFile, spec) {
  let p = spec;
  if (p.startsWith('./') || p.startsWith('../')) {
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
    p = dir ? `${dir}/${p}` : p;
  }
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  p = out.join('/');
  return p.endsWith('.stencil') ? p : `${p}.stencil`;
}

// ---- session: the whole project ---------------------------------------------------

class Session {
  constructor(load) {
    this.load = load;
    this.files = new Map();      // path -> { src, lines, ast } | null
    this.diags = [];
    this.instances = [];         // post-order: imports before importers
    this.decls = new Map();      // drop validation: declared names by logical path
    this.obligations = [];
    this.shared = new Map();     // path -> instance, for imports without a body
    this.loading = [];           // import chain, for cycle detection
    this.dropped = new Set();    // dropped and cascaded object records
    this.spans = [];
    this._grid = undefined;
  }

  file(path) {
    if (this.files.has(path)) return this.files.get(path);
    let src = null;
    try { src = this.load(path); } catch { src = null; }
    if (src == null) { this.files.set(path, null); return null; }
    const { ast, diags } = parse(src);
    for (const d of diags) { d.file = path; this.diags.push(d); }
    const f = { src, lines: lineIndex(src), ast };
    this.files.set(path, f);
    return f;
  }

  report(file, code, severity, node, message, hint, obj, fix, instance) {
    if (this.mute) return;
    const d = diag(code, severity, node.from, Math.max(node.to, node.from + 1), message, hint, fix);
    d.file = file;
    if (instance) d.instance = instance;
    this.diags.push(d);
    if (obj && severity === 'error') obj.invalid = true;
  }

  run(mainPath) {
    const f = this.file(mainPath);
    if (!f) {
      this.report(mainPath, 'C011', 'error', { from: 0, to: 0 }, `cannot read '${mainPath}'`);
      return { stencil: '0.1', vocabulary: 'std/0', grid_nm: 1, modules: [], objects: [] };
    }
    this.main = new Module(this, mainPath, f, null, null);
    this.loading.push(mainPath);
    this.main.build();
    this.loading.pop();

    // Each module's patches, then its qualified drops, in import order (every
    // import before its importers): a module sees what its imports did.
    for (const m of this.instances) { m.applyPatches(); m.applyDrops(); }
    const baseAll = (o) => { o.mod.applyBase(o, []); for (const c of [...o.children.values()]) baseAll(c); };
    for (const m of this.instances) { for (const o of m.unnamed.values()) baseAll(o); for (const o of m.order) baseAll(o); }
    // Dropped objects (and children removed by drops) get their inheritance too,
    // silently: drop validation looks up what they inherited.
    this.mute = (this.mute ?? 0) + 1;
    const seen = new Set();
    const baseGone = (o) => {
      if (!o || seen.has(o)) return;
      seen.add(o);
      if (o.baseState !== 'done') o.mod.applyBase(o, []);
      for (const c of [...o.children.values()]) baseGone(c);
      for (const t of o.tombNodes?.values() ?? []) baseGone(t.removed);
      baseGone(o.prior);
    };
    for (const m of this.instances) {
      for (const o of m.droppedNames.values()) if (o.kind !== 'param') baseGone(o);
      for (const o of m.unnamed.values()) baseGone(o);
      for (const o of m.order) baseGone(o);
    }
    this.mute--;
    this.checkDrops();
    for (const m of this.instances) m.evaluateAll();
    this.checkParamTypes();
    this.patchConflicts();
    this.cascade();
    this.flatten();
    this.orderLayers();
    this.validate();
    this.runChecks();
    const out = this.emit();
    // Cell templates and device models are checked on the emitted form, the
    // same expansion every consumer uses (core/template.js).
    this.checkTemplates(out);
    out.complete = !this.diags.some((d) => d.severity === 'error');
    return out;
  }

  grid() {
    if (this._grid !== undefined) return this._grid;
    this._grid = ONE;
    const tech = this.main.unnamed.get('#technology');
    if (tech?.attrs.has('grid')) {
      try {
        const v = this.main.evalAttr(tech, 'grid');
        if (v.t === 'num' && v.dim === 1 && v.q.cmp(ZERO) > 0) this._grid = v.q;
      } catch (e) { if (!(e instanceof EvalErr)) throw e; }
    }
    return this._grid;
  }

  // Every live object record, children included.
  *liveObjects() {
    const walk = function* (o) { yield o; for (const c of o.children.values()) yield* walk(c); };
    for (const m of this.instances) {
      for (const o of m.unnamed.values()) yield* walk(o);
      for (const o of m.order) if (!this.dropped.has(o)) yield* walk(o);
    }
  }

  // A binding must match the parameter's declared type: required(T), or the
  // type of its default value (C014).
  checkParamTypes() {
    for (const m of this.instances) {
      for (const p of [...m.params.values(), ...(m.droppedParams?.values() ?? [])]) {
        if (!p.bound || !p.declared) continue;
        // Bindings are checked even when nothing uses them, or the parameter was dropped.
        let v = p.memo.xy?.state === 'done' ? p.memo.xy.value : p.memo.z?.state === 'done' ? p.memo.z.value : null;
        if (!v && !p.memo.xy && !p.memo.z) {
          try { v = m.params.get(p.name) === p ? m.evalParam(p.name, 'xy') : p.scope.eval(p.expr, { cls: 'xy', noscale: true }); } catch (e) { if (!(e instanceof EvalErr)) throw e; }
        }
        if (!v) continue;
        const d = p.declared;
        let want;
        if (d.expr.type === 'Lit' && d.expr.v === 'required') want = d.expr.ptype;   // untyped `required`: any
        else {
          // The default's type, for scalars, references, strings, booleans and names only.
          try {
            const t = typeName(d.scope.eval(d.expr, { cls: 'xy', noscale: true }));
            if (INFERRED_TYPES.has(t) || Object.hasOwn(KINDS, t)) want = t;
          } catch (e) { if (!(e instanceof EvalErr)) throw e; }
        }
        if (!want) continue;
        const got = typeName(v);
        if (got === null) continue;                     // not decidable here (reported elsewhere, or cascaded)
        const ok = want === 'any' || got === want || (want === 'number' && got === 'int');
        if (!ok) {
          p.scope.err('C014', p.node.nameNode, `parameter '${p.name}' of ${m.label()} expects ${article(want)}, got ${describeValue(v)}`,
            d.expr.type === 'Lit' ? `declared as required(${want}) at ${m.path}:${lineCol(m.lines, d.node.from, 'l', 'c').l}` : `its default is ${article(want)} (${m.path}:${lineCol(m.lines, d.node.from, 'l', 'c').l})`);
        }
      }
    }
  }

  // Two modules that do not import one another must not both patch one
  // attribute of a shared object to different values: the result would depend
  // on import order (C052). Values are compared after evaluation, each in the
  // scope it was written in.
  // ---- drop validation ----------------------------------------------------------
  // Every declared attribute / child (and every `base = X`) is recorded by
  // logical path (keyOf), with the module that declared it and its source
  // position; every drop is an obligation. A drop names something real when
  // that name was declared at its path, or at a path it inherits from through
  // a `base` the dropping module can see, by the dropping module itself
  // earlier in its source, or by a module it imports. This depends only on
  // what the dropping module can see, never on the order of unrelated imports,
  // replacements or merges (SPEC.md section 3.5).
  declare(o, name, mod, node, baseExpr) {
    const k = keyOf(o);
    if (!this.decls.has(k)) this.decls.set(k, new Map());
    const m = this.decls.get(k);
    if (!m.has(name)) m.set(name, []);
    m.get(name).push({ mod, pos: node.from, baseExpr });
  }

  // module-level names (objects and parameters) of a module
  declareTop(owner, name, mod, node) {
    const k = `mod:${owner.muid}`;
    if (!this.decls.has(k)) this.decls.set(k, new Map());
    const m = this.decls.get(k);
    if (!m.has(name)) m.set(name, []);
    m.get(name).push({ mod, pos: node.from });
  }

  mustExistTop(owner, name, mod, node) {
    this.obligations.push({ key: `mod:${owner.muid}`, path: owner.label(), name, mod, node, pos: node.from, top: true });
  }

  mustExist(o, name, mod, node) {
    this.obligations.push({ key: keyOf(o), path: o.path, name, mod, node, pos: node.from });
  }

  checkDrops() {
    // what the dropping module can see: its own statements written before the
    // drop (source order), and everything its imports declare
    const sees = (ob, e) => (e.mod === ob.mod ? e.pos < ob.pos : this.reaches(ob.mod, e.mod));
    // `base = X` is a declaration too: it counts only where the dropping module
    // can see it (in any position, inheritance does not depend on order), on
    // the object or one of its ancestors, and X is looked up where it was written
    // The object at a logical path, live or dropped (as materialized above).
    const byMuid = new Map(this.instances.map((m) => [`${m.muid}`, m]));
    const objectAt = (k) => {
      const [head, ...segs] = k.split('/');
      const c = head.indexOf(':');
      const m = byMuid.get(head.slice(1, c));
      const name = head.slice(c + 1);
      let o = m && (name.startsWith('#') ? m.unnamed.get(name) : m.objects.get(name) ?? m.droppedNames.get(name));
      for (const seg of segs) o = o && (o.children.get(seg) ?? o.tombNodes?.get(seg)?.removed ?? priorChild(o, seg));
      return o?.kind === 'param' ? undefined : o;
    };
    // Inherited: follow the `base` edges on the object and its ancestors that the
    // dropping module (or one of its imports) wrote, to the base target at the
    // same relative path, the structure as inheritance materialized it, and
    // ask whether a module the dropping module can see declared the name there
    // (the history registry, so replaced originals count and unrelated patches
    // do not), or whether the target inherits it the same way. Each object is
    // visited once.
    // Inheritance as seen by one module, as a fixed point over every object there
    // is or was (live, dropped, tombstoned, replaced): inh(o) = the objects o
    // inherits from at the same relative position, through the `base` edges on o
    // or its ancestors that the module (or one of its imports) wrote, historical
    // edges too. Children are looked up through what an object inherits. The sets
    // only grow and the universe is finite, so the iteration ends; sets keep every
    // result once.
    const universe = [];
    {
      const seen = new Set();
      const add = (o) => {
        if (!o || seen.has(o) || o.kind === 'param') return;
        seen.add(o);
        universe.push(o);
        for (const c of o.children.values()) add(c);
        for (const t of o.tombNodes?.values() ?? []) add(t.removed);
        add(o.prior);
      };
      for (const m of this.instances) {
        for (const o of m.unnamed.values()) add(o);
        for (const o of m.objects.values()) add(o);
        for (const o of m.droppedNames.values()) add(o);
      }
    }
    // Computed once for all views: each object's logical path, and the `base`
    // edges on it or its ancestors with the relative path from that ancestor.
    // Objects without any such edge never inherit and are left out of the
    // fixed point.
    const keyMemo = new Map();
    const kOf = (o) => {
      if (!keyMemo.has(o)) keyMemo.set(o, o.parent ? `${kOf(o.parent)}/${o.name ?? '#' + o.kind}` : keyOf(o));
      return keyMemo.get(o);
    };
    const ownBases = (o) => (this.decls.get(kOf(o))?.get('base') ?? []).filter((e) => e.baseExpr?.type === 'Ref');
    // whether o or an ancestor has a base edge (memoized flag; no lists are kept)
    const anyMemo = new Map();
    const anyBase = (o) => {
      if (!anyMemo.has(o)) anyMemo.set(o, ownBases(o).length > 0 || (!!o.parent && anyBase(o.parent)));
      return anyMemo.get(o);
    };
    // the base edges on o or its ancestors: { e, chain, i }, the edge sits on
    // chain[i], and the relative path down to o is chain[i-1] ... chain[0] (read by
    // index, never copied). Built on demand for objects being solved.
    const baseAnc = (o) => {
      const chain = [];
      for (let y = o; y; y = y.parent) chain.push(y);
      const out = [];
      for (let i = 0; i < chain.length; i++) for (const e of ownBases(chain[i])) out.push({ e, chain, i });
      return out;
    };
    const segName = (y) => y.name ?? '#' + y.kind;
    // Demand-driven: a view solves only the objects whose inheritance is actually
    // read, starting from the drops' objects; unrelated components are never
    // touched. Sets only grow, so solving again after adding objects is sound.
    const views = new Map();
    const viewFor = (M) => {
      if (views.has(M)) return views.get(M);
      const visible = (e) => e.mod === M || this.reaches(M, e.mod);
      const inh = new Map();
      const active = [];
      let grew = false;
      const inhOf = (o) => {
        if (!inh.has(o)) { inh.set(o, new Set()); if (anyBase(o)) { active.push(o); grew = true; } }
        return inh.get(o);
      };
      const ownChildren = (t, seg) => {
        const out = [t.children.get(seg), t.tombNodes?.get(seg)?.removed];
        for (let p = t.prior; p; p = p.prior) out.push(p.children.get(seg), p.tombNodes?.get(seg)?.removed);
        return out.filter(Boolean);
      };
      // children named seg of t and of everything t (transitively) inherits from
      const childrenOf = (t, seg) => {
        const out = new Set();
        const seen = new Set([t]);
        const q = [t];
        while (q.length) {
          const n = q.pop();
          for (const c of ownChildren(n, seg)) out.add(c);
          for (const u of inhOf(n)) if (!seen.has(u)) { seen.add(u); q.push(u); }
        }
        return out;
      };
      const step = (nodes, seg) => (nodes.size ? new Set([...nodes].flatMap((n) => [...childrenOf(n, seg)])) : nodes);
      const descend = (nodes, segs) => {
        for (const seg of segs) { if (!nodes.size) return nodes; nodes = step(nodes, seg); }
        return nodes;
      };
      // descend along chain[i-1] ... chain[0]
      const descendChain = (nodes, chain, i) => {
        for (let j = i - 1; j >= 0 && nodes.size; j--) nodes = step(nodes, segName(chain[j]));
        return nodes;
      };
      const targets = (e) => {
        const parts = e.baseExpr.parts;
        for (let k = parts.length; k >= 1; k--) {
          const r = e.mod.walkPath(parts.slice(0, k)).obj;
          if (r) return descend(new Set([r]), parts.slice(k));
        }
        return new Set();
      };
      // Incremental: once solved, an object's set is final, a later drop only
      // activates objects nothing solved so far has read (reading activates), so
      // each solve iterates only the objects activated since the last one.
      const edgesOf = new Map();
      let stable = 0;
      const solve = () => {
        for (let changed = true; changed;) {
          changed = false;
          grew = false;
          for (let k = stable; k < active.length; k++) {
            const o = active[k];
            const set = inh.get(o);
            if (!edgesOf.has(o)) edgesOf.set(o, baseAnc(o).filter(({ e }) => visible(e)));
            for (const { e, chain, i } of edgesOf.get(o)) {
              for (const t of descendChain(targets(e), chain, i)) if (t !== o && !set.has(t)) { set.add(t); changed = true; }
            }
          }
          if (grew) changed = true;
        }
        stable = active.length;
      };
      const view = { visible, inhOf, solve, size: () => active.length };
      views.set(M, view);
      return view;
    };
    const inherited = (ob) => {
      const x = objectAt(ob.key);
      if (!x) return false;
      const { inhOf, visible, solve, size } = viewFor(ob.mod);
      inhOf(x);
      // walking the closure can activate objects not solved yet: solve and walk
      // again until the walk activates nothing new
      for (;;) {
        solve();
        const before = size();
        const seen = new Set([x]);
        const q = [...inhOf(x)];
        for (const t of q) seen.add(t);
        while (q.length) {
          const t = q.pop();
          if ((this.decls.get(kOf(t))?.get(ob.name) ?? []).some(visible)) return true;
          for (const u of inhOf(t)) if (!seen.has(u)) { seen.add(u); q.push(u); }
        }
        if (size() === before) return false;
      }
    };
    for (const ob of this.obligations) {
      const has = (k) => (this.decls.get(k)?.get(ob.name) ?? []).some((e) => sees(ob, e));
      if (has(ob.key) || (!ob.top && inherited(ob))) continue;
      ob.mod.err('C050', ob.node, ob.top ? `nothing named '${ob.name}' to drop here (it is declared after the drop)` : `'${ob.path}' has no attribute or child '${ob.name}' to drop`);
    }
  }

  // Does module x import y, directly or through other imports? (The import
  // graph, not the first-owner chain: a shared instance has several importers.)
  reaches(x, y) {
    const cache = (this._reach ??= new Map());
    const key = `${x.muid}>${y.muid}`;
    if (cache.has(key)) return cache.get(key);
    const seen = new Set();
    const stack = [...x.imports.values()];
    let found = false;
    while (stack.length && !found) {
      const m = stack.pop();
      if (seen.has(m)) continue;
      seen.add(m);
      if (m === y) found = true;
      else stack.push(...m.imports.values());
    }
    cache.set(key, found);
    return found;
  }

  patchConflicts() {
    const related = (a, b) => this.reaches(a, b) || this.reaches(b, a);
    const valueOf = (e) => {
      if (e.drop) return { t: 'word', v: '\u0000dropped' };
      if (e.present) return { t: 'word', v: `\u0000present:${e.present}` };
      if (e.rec.state === 'done') return e.rec.value;
      try { return e.rec.scope.eval(e.rec.expr, { cls: e.obj.mod.attrClass(e.obj, e.name) }); } catch (x) { if (x instanceof EvalErr) return null; throw x; }
    };
    const isAncestor = (x, y) => x !== y && this.reaches(x, y);
    const reg = this.patchedBy ?? new Map();
    // Effects are keyed by logical path (keyOf): `m<module>:S` for an object,
    // `.../R` for a child, `...@width` for an attribute. ancestors(k): the object
    // keys above k (for an attribute, its object first).
    const ancestors = (k) => {
      const out = [];
      let x = k.includes('@') ? k.slice(0, k.lastIndexOf('@')) : k;
      if (k.includes('@')) out.push(x);
      while (x.includes('/')) { x = x.slice(0, x.lastIndexOf('/')); out.push(x); }
      return out;
    };
    // A module importing both settles a clash with its own effect on the same
    // path, or with a drop of the object or any ancestor of it.
    const settledAt = (k, a, b) => {
      const settles = (c) => isAncestor(c, a.mod) && isAncestor(c, b.mod);
      if ((reg.get(k) ?? []).some((c) => settles(c.mod))) return true;
      return ancestors(k).some((x) => (reg.get(x) ?? []).some((c) => c.drop && settles(c.mod)));
    };
    const reported = new Set();
    const clash = (a, b, msg) => {
      if (reported.has(b)) return;
      reported.add(b);
      b.mod.err('C052', b.drop || b.present ? b.node : b.rec.node.nameNode, msg, 'patch it once, in the module that imports both', b.obj);
    };
    for (const [k, entries] of reg) {
      // the same path, set or dropped by two unrelated modules
      for (let i = 1; i < entries.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = entries[j], b = entries[i];
          if (a.mod === b.mod || related(a.mod, b.mod) || settledAt(k, a, b)) continue;
          const va = valueOf(a), vb = valueOf(b);
          if (va && vb && deepKey(va) === deepKey(vb)) continue;
          if (a.present && b.present && a.present === b.present) continue;   // same child kind: compare its attributes instead
          if (!!a.present !== !!b.present && !a.drop && !b.drop) continue;   // a child next to an attribute of the same name: no structural clash
          clash(a, b, `${a.mod.label()} and ${b.mod.label()} both patch ${b.obj.path}.${b.name} differently${a.drop || b.drop ? ' (one drops it)' : ''}; the result would depend on import order`);
        }
      }
      // a setting below an object that an unrelated module drops
      for (const b of entries) {
        if (b.drop) continue;
        for (const x of ancestors(k)) {
          if (x === k) continue;
          for (const a of reg.get(x) ?? []) {
            if (!a.drop || a.mod === b.mod || related(a.mod, b.mod) || settledAt(k, a, b)) continue;
            clash(a, b, `${a.mod.label()} drops ${a.obj.path}${a.name && a.obj.name !== a.name ? '.' + a.name : ''}, below which ${b.mod.label()} sets ${b.obj.path}.${b.name}; the result would depend on import order`);
          }
        }
      }
    }
  }

  // ---- cascading drops ----------------------------------------------------------
  // An object whose required attribute refers to a dropped object is dropped
  // too; list items that refer to dropped objects are removed. Repeats until
  // nothing changes. Numeric dependencies on a dropped object stay errors.
  cascade() {
    const isGone = (v) => {
      if (!v || typeof v !== 'object') return null;
      if (v.t === 'dropped') return v.obj;
      if ((v.t === 'ref' || v.t === 'attrref') && isGoneObj(v.obj)) return v.obj;
      if (v.t === 'list' || v.t === 'choice') { for (const x of v.items) { const g = isGone(x); if (g) return g; } }
      if (v.t === 'call') { for (const x of v.args) { const g = isGone(x); if (g) return g; } }
      return null;
    };
    const dropChild = (o) => { if (o.parent) o.parent.children.delete(o.name ?? '#' + o.kind); };
    const isGoneObj = (d) => { for (let x = d; x; x = x.parent) if (this.dropped.has(x)) return true; return false; };
    this.isGoneObj = isGoneObj;
    // Every pass removes at least one object, list item or attribute, so this
    // terminates; the bound only guards against an implementation error.
    let changed = true;
    let passes = 0;
    const bound = [...this.liveObjects()].reduce((n, o) => n + 1 + o.attrs.size, 2);
    while (changed) {
      if (passes++ > bound) { this.main.err('V998', { from: 0, to: 0 }, 'internal error: cascading drops did not settle'); break; }
      changed = false;
      for (const o of [...this.liveObjects()]) {
        if (this.dropped.has(o)) continue;
        for (const [name, a] of [...o.attrs]) {
          if (a.state !== 'done') continue;
          const gone = isGone(a.value) ?? (o.kind === 'check' ? (findPoison(a.value)?.obj ?? [...(a.deps ?? []), ...(a.refDeps ?? [])].find((d) => this.dropped.has(d) || isGoneObj(d))) : null);
          if (!gone) continue;
          const spec = attrSpec(o.kind, name);
          const isPair = spec && typeIncludesPair(spec.type) && a.value.t === 'list' && a.value.items.length === 2;
          if (a.value.t === 'list' && !isPair) {
            const keep = a.value.items.filter((x) => !isGone(x));
            if (keep.length || !spec?.required) {
              a.value = { ...a.value, items: keep };
              a.scope.info(a.node.nameNode, 'I021', `'${gone.path}' removed from ${o.path}.${name} (it was dropped)`);
              changed = true;
              continue;
            }
          }
          if (spec?.required || name === 'from' || o.kind === 'check') {
            this.dropped.add(o);
            dropChild(o);
            if (o.kind === 'check') o.srcMod.warn('W040', o.node.nameNode, `check '${o.path}' no longer applies: it depends on '${gone.path}', which was dropped`, 'restate the check for the new composition if it still matters');
            else o.srcMod.info(o.node.nameNode ?? o.node.kindNode, 'I020', `'${o.path}' removed because '${gone.path}' was dropped`);
            changed = true;
            break;
          }
          o.attrs.delete(name);
          a.scope.info(a.node.nameNode, 'I021', `${o.path}.${name} removed because '${gone.path}' was dropped`);
          changed = true;
        }
      }
    }
    // What is left and still depends on a dropped object is an error: either
    // the value carries the dropped reference, or it was computed from an
    // attribute of an object that the cascade removed afterwards.
    for (const o of this.liveObjects()) {
      for (const [name, a] of o.attrs) {
        if (a.state !== 'done') continue;
        const p = findPoison(a.value);
        const dep = p ? null : [...(a.deps ?? [])].find((d) => d !== o && isGoneObj(d));
        if (p || dep) {
          a.state = 'err';
          a.scope.err('C051', p?.node ?? a.expr, `${o.path}.${name} uses '${(p?.obj ?? dep).path}', which was dropped`, 'drop this object too, or give the value directly', o);
        }
      }
    }
  }

  // ---- names in the resolved form -------------------------------------------------
  flatten() {
    this.byRname = new Map();
    for (const m of this.instances) {
      for (const o of m.order) {
        if (this.dropped.has(o)) continue;
        // Checks are assertions, not technology content: imported ones keep
        // their instance-qualified name and never clash.
        o.rname = o.kind === 'check' && m.importer ? `${m.label()}.${o.name}` : m.resolvedName(o.name);
        setPaths(o, o.rname);
        const prev = this.byRname.get(o.rname);
        if (prev && prev !== o) {
          o.clash = true;
          m.err('C060', o.node.nameNode ?? o.node.kindNode,
            `'${o.rname}' from ${m.label()} clashes with '${prev.rname}' from ${prev.mod.label()}`,
            `rename one on import: import "..." as X { rename { ${o.name} = NEW_NAME } } or rename { prefix = "X_" }`, o);
          continue;
        }
        this.byRname.set(o.rname, o);
      }
    }
  }

  // ---- vertical order ---------------------------------------------------------------
  orderLayers() {
    const seen = new Set();
    const seq = [];
    const expand = (m) => {
      if (seen.has(m)) return;
      seen.add(m);
      const tech = m.unnamed.get('#technology');
      const stack = tech ? m.value(tech, 'stack') : undefined;
      const stacked = [];
      if (stack?.t === 'list') {
        for (const item of stack.items) {
          if (item.t === 'module') stacked.push(item.mod);
          else m.err('V030', tech.attrs.get('stack').expr, `technology.stack lists '${item.v ?? item.t}', which is not an import alias`);
        }
      }
      for (const inst of stacked) expand(inst);
      for (const inst of m.imports.values()) {
        if (stacked.includes(inst) || seen.has(inst)) continue;
        const hasLayers = inst.order.some((o) => o.kind === 'layer' && !this.dropped.has(o));
        if (hasLayers && stacked.length) m.warn('W030', inst.importNode, `layers of '${inst.alias}' are not in technology.stack; they are placed after the stacked modules`);
        expand(inst);
      }
      for (const o of m.order) if (o.kind === 'layer' && !this.dropped.has(o) && !o.clash) seq.push(o);
    };
    expand(this.main);

    // Explicit placement: below / above / level_with, applied in sequence order,
    // repeated until every placement holds (at most one pass per placement + 1).
    const level = new Map();
    let placed = seq.filter((o) => ['below', 'above', 'level_with'].some((k) => o.mod.value(o, k)?.t === 'ref'));
    placed = placed.filter((o) => {
      if (['below', 'above', 'level_with'].filter((k) => o.mod.value(o, k)?.t === 'ref').length < 2) return true;
      o.srcMod.err('V031', o.node.nameNode, `${o.path}: use only one of below / above / level_with`, null, o);
      return false;
    });
    const holds = () => placed.every((o) => {
      const t = ['below', 'above', 'level_with'].map((k) => [k, o.mod.value(o, k)]).find(([, x]) => x?.t === 'ref');
      const i = seq.indexOf(o), j = seq.indexOf(t[1].obj);
      return j < 0 || (t[0] === 'below' ? i < j : i > j);
    });
    for (let pass = 0; pass <= placed.length && !holds(); pass++)
    for (const o of placed) {
      const below = o.mod.value(o, 'below'), above = o.mod.value(o, 'above'), lw = o.mod.value(o, 'level_with');
      const set = [below, above, lw].filter((x) => x?.t === 'ref');
      if (set.length > 1) { o.mod.err('V031', o.node.nameNode, `${o.path}: use only one of below / above / level_with`, null, o); continue; }
      const t = set[0];
      if (!t) continue;
      if (t.obj === o || !seq.includes(t.obj)) { o.mod.err('V031', o.attrs.get(below ? 'below' : above ? 'above' : 'level_with').expr, `${o.path} cannot be placed relative to '${t.obj.path}'`, null, o); continue; }
      seq.splice(seq.indexOf(o), 1);
      const at = seq.indexOf(t.obj);
      seq.splice(below ? at : at + 1, 0, o);
      if (lw) level.set(o, t.obj);
    }
    for (const o of placed) { const lw = o.mod.value(o, 'level_with'); if (lw?.t === 'ref' && seq.includes(lw.obj)) level.set(o, lw.obj); }
    this.layerOrder = new Map();
    let n = 0;
    for (const o of seq) this.layerOrder.set(o, level.has(o) ? this.layerOrder.get(level.get(o)) ?? ++n : ++n);
    this.layerSeq = seq;
    // Later moves can undo earlier ones; every placement must still hold.
    for (const o of seq) {
      for (const [k, want] of [['below', (a, b) => a < b], ['above', (a, b) => a > b], ['level_with', (a, b) => a === b]]) {
        const t = o.mod.value(o, k);
        if (t?.t !== 'ref' || !this.layerOrder.has(t.obj)) continue;
        if (!want(this.layerOrder.get(o), this.layerOrder.get(t.obj))) {
          const a = o.attrs.get(k);
          a.scope.err('V031', a.expr, `contradictory placement: ${o.path} cannot be ${k.replace('_', ' ')} ${t.obj.path} given the other placements`, null, o);
        }
      }
    }

    // Side: explicit, else inferred from the strata (below the lowest device layer = back).
    const deviceLayers = new Set();
    for (const o of this.liveObjects()) {
      if (o.kind !== 'stratum') continue;
      const ls = o.mod.value(o, 'layers');
      if (ls?.t === 'list') for (const x of ls.items) if (x.t === 'ref') deviceLayers.add(x.obj);
    }
    const devOrders = [...deviceLayers].map((l) => this.layerOrder.get(l)).filter((x) => x !== undefined);
    const lo = devOrders.length ? Math.min(...devOrders) : undefined, hi = devOrders.length ? Math.max(...devOrders) : undefined;
    this.layerSide = new Map();
    for (const o of seq) {
      const explicit = o.mod.value(o, 'side')?.v;
      const ord = this.layerOrder.get(o);
      const isMarker = o.mod.value(o, 'role')?.v === 'marker';   // markers have no physical height
      const side = explicit ?? (lo === undefined || isMarker ? undefined : deviceLayers.has(o) ? 'device' : ord < lo ? 'back' : ord > hi ? 'front' : 'device');
      if (side) this.layerSide.set(o, side);
    }
  }

  // ---- validation ----------------------------------------------------------------
  validate() {
    const layers = this.layerSeq;
    if (layers.length && !this.main.unnamed.has('#technology')) {
      const first = layers.find((l) => l.mod === this.main) ?? layers[0];
      const at = first.node.from;
      first.mod.warn('V020', first.node.kindNode, 'no technology block; assuming grid = 1nm', 'add: technology { grid = 1nm }',
        { from: at, to: at, insert: 'technology { grid = 1nm }\n\n', label: 'Add technology block' });
    }
    // Imported technology blocks: grids should agree with the main one.
    const g = this.grid();
    for (const m of this.instances) {
      if (m === this.main) continue;
      const t = m.unnamed.get('#technology');
      const v = t && m.value(t, 'grid');
      if (v?.t === 'num' && v.dim === 1 && !v.q.div(g).isInt() && !g.div(v.q).isInt()) {
        m.warn('W031', t.attrs.get('grid').expr, `${m.label()} uses a ${fmtLen(v.q)} grid; the technology grid is ${fmtLen(g)}`);
      }
    }
    for (const o of this.liveObjects()) {
      if (o.parent) continue;
      try { o.srcMod.checkObject(o); } catch (e) {
        if (e instanceof EvalErr) continue;
        o.srcMod.err('V999', o.node.kindNode, `internal validator error on ${o.path}: ${e.message}`, 'please report this', o);
      }
    }

    const usedCuts = new Set();
    for (const o of this.liveObjects()) {
      const cut = o.kind === 'connector' && o.mod.value(o, 'cut');
      if (cut?.t === 'ref') usedCuts.add(cut.obj);
    }
    for (const l of layers) {
      if (l.mod.value(l, 'role')?.v === 'cut' && !usedCuts.has(l)) l.mod.warn('W010', l.node.nameNode, `cut layer '${l.path}' is not used by any connector`);
    }
  }

  runChecks() {
    for (const o of this.liveObjects()) {
      if (o.kind !== 'check') continue;
      if (o.attrs.get('holds')?.state === 'err') {
        o.srcMod.err('V101', o.node.nameNode, `check ${o.path} could not be evaluated, so it does not hold`, 'see the error on its holds expression', o);
        continue;
      }
      if (o.invalid) continue;
      const v = o.mod.value(o, 'holds');
      if (v?.t !== 'bool' || v.v) continue;
      const sev = o.mod.value(o, 'severity')?.v ?? 'error';
      const msg = o.mod.value(o, 'message')?.v;
      const bound = [...o.mod.params.values()].filter((p) => p.bound).map((p) => `${p.name} (${p.scope.path}:${lineCol(p.scope.lines, p.node.from, 'l', 'c').l})`);
      o.srcMod.report(sev === 'warning' ? 'warning' : 'error', 'V100', o.node.nameNode,
        `check ${o.path} failed${msg ? `: ${msg}` : ''}, ${v.detail ?? 'false'}`,
        bound.length ? `parameters bound by the importer: ${bound.join(', ')}` : undefined, sev === 'warning' ? undefined : o);
    }
  }

  checkTemplates(out) {
    const at = (name, path) => {
      let o = this.byRname.get(name);
      for (const seg of (path ?? '').split('.').filter(Boolean)) {
        // an expanded row child `R.x` is the child x of the row's site
        const site = o?.kind === 'row' ? o.mod.value(o, 'site') : null;
        const c = (site?.t === 'ref' ? site.obj : o)?.children.get(seg);
        if (!c) break;
        o = c;
      }
      return o;
    };
    for (const so of out.objects.filter((o) => o.kind === 'site')) {
      for (const p of expandSite(out, so.name).problems) {
        const o = at(so.name, p.path);
        if (o) o.srcMod.err(p.code, o.node.nameNode ?? o.node.kindNode, p.message, null, o);
      }
    }
    const strata = new Map(out.objects.filter((o) => o.kind === 'stratum').map((o) => [o.name, o]));
    for (const cr of out.objects.filter((o) => o.kind === 'cross')) {
      const models = (cr.children ?? []).filter((c) => c.kind === 'model');
      const sels = models.map(modelSelector);
      const key = (m) => `${m.polarity}|${[...m.markers].sort()}|${[...m.exclude].sort()}`;
      models.forEach((m, i) => {
        const o = at(cr.name, m.name);
        const err = (code, msg, hint) => o && o.srcMod.err(code, o.node.nameNode ?? o.node.kindNode, msg, hint, o);
        if (m.attrs.marker && m.attrs.markers) err('V041', `model ${m.name}: give marker or markers, not both`);
        const twin = sels.slice(0, i).find((x) => key(x) === key(sels[i]));
        if (twin) err('V041', `models ${twin.name} and ${m.name} select the same devices (${sels[i].polarity}, markers [${sels[i].markers}], exclude [${sels[i].exclude}])`, 'add a marker or an exclude to tell them apart');
        const st = typeof cr.attrs.stratum?.ref === 'string' ? strata.get(cr.attrs.stratum.ref) : undefined;
        const pols = polaritiesOf(st);
        if (st && !pols.includes(m.attrs.polarity)) err('V042', `model ${m.name} is ${m.attrs.polarity}, but cross ${cr.name} is in stratum ${st.name} (${pols.join(', ')})`);
      });
    }
  }

  // ---- resolved form ------------------------------------------------------------
  emit() {
    const grid = this.grid();
    const tg = this.main.unnamed.get('#technology')?.attrs.get('grid');
    this.gridOut = grid.isInt() ? this.safe(grid.n, { node: tg?.expr, mod: tg?.scope }, tg, null) : encQ(grid);
    this.gdsSeen = new Map();
    const objects = [];
    for (const o of this.main.unnamed.values()) objects.push(this.encodeObject(o, grid));
    const physical = [...this.layerSeq].sort((a, b) => this.layerOrder.get(a) - this.layerOrder.get(b));   // stable
    for (const o of physical) objects.push(this.encodeObject(o, grid));
    for (const m of this.instances) for (const o of m.order) {
      if (o.kind === 'layer' || this.dropped.has(o) || this.byRname.get(o.rname) !== o) continue;
      objects.push(this.encodeObject(o, grid));
    }
    const modules = this.instances.filter((m) => m !== this.main).map((m) => ({ path: m.path, as: m.label() }));
    for (const m of this.instances) m.reportSnaps();
    // Output with errors is for viewing only, never an authoritative generator input.
    const complete = !this.diags.some((d) => d.severity === 'error');
    return { stencil: this.files.get(this.main.path)?.ast?.version ?? '0.1', vocabulary: 'std/0', complete, grid_nm: this.gridOut, modules, objects };
  }

  encodeObject(o, grid) {
    this.spans.push({ file: o.srcMod.path, path: o.path, kind: o.kind, from: o.node.from, to: o.node.to });
    const attrs = {};
    const attrSrc = {};
    const defaulted = [];
    const spec = KINDS[o.kind];
    for (const [name, a] of o.attrs) {
      if (a.state !== 'done') continue;
      if (o.kind === 'layer' && (name === 'below' || name === 'above' || name === 'level_with')) continue;
      attrs[name] = o.kind === 'layer' && name.startsWith('gds') ? this.encodeGds(o, name, a) : this.encode(a.value, grid, a, o, RULE_FAMILY.has(o.kind));
      attrSrc[name] = `${a.scope.path}:${lineCol(a.scope.lines, a.node.from, 'l', 'c').l}`;
    }
    for (const [name, as] of Object.entries(spec?.attrs ?? {})) {
      if (!(name in attrs) && as.default && !(o.kind === 'layer' && name === 'side')) { attrs[name] = this.encode(as.default, grid, null, o); defaulted.push(name); }
    }
    // `tracks M0 { ... }` names its layer by the block name: write the layer's
    // resolved name, so renames and prefixes carry through.
    if (o.kind === 'tracks' && !('layer' in attrs) && o.name) {
      const t = implicitTracksLayer(this, o);
      if (t && !this.dropped.has(t)) { attrs.layer = { ref: t.path }; defaulted.push('layer'); }
    }
    if (o.kind === 'layer') {
      attrs.order = this.layerOrder.get(o);
      if (this.layerSide.has(o)) attrs.side = this.layerSide.get(o);
    }
    const out = { kind: o.kind };
    if (o.name) out.name = o.parent ? o.name : (o.rname ?? o.name);
    out.attrs = attrs;
    if (defaulted.length) out.defaulted = defaulted;
    out.children = [...o.children.values()].map((c) => this.encodeObject(c, grid));
    if (o.mod !== this.main) out.module = o.mod.label();
    const lc = lineCol(o.srcMod.lines, o.node.from, 'l', 'c');
    out.src = `${o.srcMod.path}:${lc.l}:${lc.c}`;
    out.attr_src = attrSrc;
    if (o.invalid) out.invalid = true;
    return out;
  }

  // GDS numbers are shifted on the exact value, then serialised once.
  encodeGds(o, name, a) {
    const v = a.value;
    if (v?.t !== 'list' || v.items.length !== 2 || v.items.some((x) => x.t !== 'num' || x.dim !== 0 || !x.q.isInt())) return this.encode(v, this.grid(), a, o);
    const at = { node: a.expr, mod: a.scope };
    const pair = [this.safe(v.items[0].q.n + o.mod.gdsShift(), at, a, o), this.safe(v.items[1].q.n, at, a, o)];
    const key = pair.join('/');
    const prev = this.gdsSeen.get(key);
    if (prev && prev.o !== o) {
      a.scope.err('V021', a.expr, `GDS ${key} of ${o.path}.${name} is already used by ${prev.o.path}.${prev.name}`,
        'give one of them another layer/datatype, or shift a module: import ... { gds { shift = 1000 } }', o);
    } else {
      this.gdsSeen.set(key, { o, name });
    }
    return pair;
  }

  // JSON numbers are exact only up to 2^53; larger integers are an error, not a silent rounding.
  safe(n, v, a, o) {
    if (typeof n === 'string') return n;
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) {
      if (a) (v.mod ?? a.scope).err('C071', v.node ?? a.expr, `${n} database units cannot be represented exactly in the resolved form`, 'use a coarser grid or a smaller value', o);
      return n.toString();
    }
    return Number(n);
  }

  // exact: rule thresholds, which may be off-grid; they are written as exact
  // "num/den" DBU strings instead of being rejected (VOCABULARY.md section 3.1).
  encode(v, grid, a, o, exact = false) {
    switch (v.t) {
      case 'num': {
        if (v.dim === 0) return v.q.isInt() ? this.safe(v.q.n, v, a, o) : encQ(v.q);
        const unit = v.dim === 1 ? grid : grid.mul(grid);
        const dbu = v.q.div(unit);
        if (!dbu.isInt() && exact) return `${dbu.n}/${dbu.d}`;
        if (exact && !Number.isSafeInteger(Number(dbu.n))) return `${dbu.n}`;      // beyond 2^53: an exact string
        if (!dbu.isInt()) {
          if (a) {
            const lo = dbu.floor().mul(unit), hi = dbu.ceil().mul(unit);
            const at = v.node ?? a.expr;
            const scope = v.mod ?? a.scope;
            const u = v.dim === 1 ? fmtLen : fmtArea;
            scope.err('C070', at, `${u(v.q)} is not on the ${fmtLen(grid)} grid`,
              `nearest: ${u(lo)} or ${u(hi)}; or wrap the expression in snap(...)${scope.scaleFactors() ? ', or import with scale { snap = true }' : ''}`, o,
              { from: at.from, to: at.to, insert: `snap(${scope.text(at)})`, label: 'Wrap in snap(...)' });
          }
          return this.safe(dbu.round().n, v, a, o);
        }
        return this.safe(dbu.n, v, a, o);
      }
      case 'str': return v.v;
      case 'bool': return v.v;
      case 'word': return v.v;
      case 'module': return v.mod.label();
      case 'ref': return { ref: v.obj.path };
      case 'attrref': return { ref: v.obj.path, attr: v.attr };
      case 'list': return v.items.map((x) => this.encode(x, grid, a, o, exact));
      case 'range': return { min: this.encode(v.lo, grid, a, o, exact), max: this.encode(v.hi, grid, a, o, exact) };
      case 'choice': return { one_of: v.items.map((x) => this.encode(x, grid, a, o, exact)) };
      case 'call': return { call: v.fn, args: v.args.map((x) => this.encode(x, grid, a, o, exact)) };
      default: return null;
    }
  }
}

// ---- module: one instance of one file --------------------------------------------

class Module {
  constructor(session, path, file, importer, importNode) {
    this.s = session;
    this.path = path;
    this.src = file.src;
    this.lines = file.lines;
    this.ast = file.ast;
    this.importer = importer;
    this.importNode = importNode;
    this.alias = importNode?.alias ?? null;
    this.params = new Map();
    this.objects = new Map();
    this.unnamed = new Map();
    this.order = [];
    this.droppedNames = new Map();   // name -> object record
    this.patches = [];
    this.drops = [];
    this.imports = new Map();        // alias -> Module
    this.config = { rename: new Map(), prefix: null, gds: null, scale: null };
    this.muid = (session.nextModuleId = (session.nextModuleId ?? 0) + 1);
    this.transformRoot = importer ? importer.transformRoot : this;
    this.stack = [];
  }

  // One note per scaled module listing what snapping changed.
  reportSnaps() {
    if (this.snaps?.size && this.importNode) {
      const ex = [...this.snaps.values()].slice(0, 4).map((x) => `${this.text(x.node)} -> ${fmtLen(x.to)} (line ${lineCol(this.lines, x.node.from, 'l', 'c').l})`);
      this.importer.info(this.importNode.aliasNode, 'I030', `scale snapped ${this.snaps.size} length${this.snaps.size > 1 ? 's' : ''} in ${this.label()} to the grid: ${ex.join(', ')}${this.snaps.size > 4 ? ', ...' : ''}`);
    }
    if (this.scaleFactors() && !this.scaleFactors().xy.eq(this.scaleFactors().z)) {
      for (const p of this.params.values()) {
        if (p.memo.xy?.state === 'done' && p.memo.z?.state === 'done' && p.scope === this) {
          this.warn('W032', p.node.nameNode, `'${p.name}' is used for both horizontal and vertical sizes, so it scales by two different factors`, 'split it into two parameters');
        }
      }
    }
  }

  label() {
    const chain = [];
    for (let m = this; m && m.alias; m = m.importer) chain.unshift(m.alias);
    return chain.length ? chain.join('.') : this.path;
  }

  // ---- diagnostics ----------------------------------------------------------
  report(severity, code, node, message, hint, obj, fix) {
    this.s.report(this.path, code, severity, node, message, hint, obj, fix, this.importer ? this.label() : undefined);
  }
  err(code, node, message, hint, obj, fix) { this.report('error', code, node, message, hint, obj, fix); }
  warn(code, node, message, hint, fix) { this.report('warning', code, node, message, hint, undefined, fix); }
  info(node, code, message) { this.report('info', code, node, message); }
  fail(code, node, message, hint, fix) { this.err(code, node, message, hint, undefined, fix); throw new EvalErr(message); }

  suggest(word, candidates, span) {
    const c = closest(word, candidates.filter(Boolean));
    if (!c) return { hint: undefined, fix: undefined };
    return { hint: `did you mean '${c}'?`, fix: span ? { from: span.from, to: span.to, insert: c, label: `Replace with '${c}'` } : undefined };
  }
  didYouMean(word, candidates) { return this.suggest(word, candidates).hint; }
  text(node) { return this.src.slice(node.from, node.to); }

  // ---- building ---------------------------------------------------------------
  build() {
    for (const st of this.ast.stmts) {
      if (st.type === 'Assign') {
        if (this.taken(st.name)) { this.err('C020', st.nameNode, `'${st.name}' is already defined in this file`); continue; }
        this.params.set(st.name, { name: st.name, expr: st.value, node: st, scope: this, memo: {} });
        this.s.declareTop(this, st.name, this, st);
        if (!(st.value.type === 'Lit' && st.value.ptype)) this.noTypedRequired(st.value);
        if (st.value.type === 'Lit' && st.value.ptype && !PARAM_TYPES.has(st.value.ptype) && !Object.hasOwn(KINDS, st.value.ptype)) {
          const s2 = this.suggest(st.value.ptype, [...PARAM_TYPES, ...Object.keys(KINDS)], st.value.ptypeNode);
          this.err('C014', st.value.ptypeNode, `unknown parameter type '${st.value.ptype}'`, s2.hint ?? `types: ${[...PARAM_TYPES].join(', ')}, or an object kind such as layer`, null, s2.fix);
        }
      } else if (st.type === 'Object') {
        if (!st.name) {
          const key = '#' + st.kind;
          if (this.unnamed.has(key)) { this.err('C020', st.kindNode, `only one '${st.kind} { ... }' block is allowed`); continue; }
          this.unnamed.set(key, this.buildObject(st, null, this));
        } else {
          if (this.taken(st.name)) {
            this.err('C020', st.nameNode, `'${st.name}' is already defined in this file`,
              'names are unique across all kinds, e.g. call the cut layer V0 and the connector VIA0');
            continue;
          }
          const o = this.buildObject(st, null, this);
          this.s.declareTop(this, st.name, this, st);
          this.objects.set(st.name, o);
          this.order.push(o);
        }
      } else if (st.type === 'Import') {
        this.buildImport(st);
      } else if (st.type === 'Patch') {
        this.patches.push(st);
      } else if (st.type === 'Drop') {
        this.drops.push(st);
      }
    }
    this.s.instances.push(this);
  }

  // `required(T)` is only valid as a parameter's whole value (SPEC.md section 3.1).
  noTypedRequired(e) {
    if (!e || typeof e !== 'object') return;
    if (Array.isArray(e)) { for (const x of e) this.noTypedRequired(x); return; }
    if (e.type === 'Lit' && e.ptype) { this.err('C014', e, 'required(T) is only valid as the whole value of a module parameter'); return; }
    for (const [k, v] of Object.entries(e)) if (k !== 'ptypeNode' && v && typeof v === 'object') this.noTypedRequired(v);
  }

  taken(name) { return this.params.has(name) || this.objects.has(name) || this.imports.has(name); }

  buildImport(st) {
    if (this.taken(st.alias)) { this.err('C020', st.aliasNode, `'${st.alias}' is already defined in this file`); return; }
    const path = resolvePath(this.path, st.path);
    const pathNode = { from: st.from, to: st.aliasNode.from };
    if (this.s.loading.includes(path)) {
      this.err('C010', pathNode, `import cycle: ${[...this.s.loading, path].join(' -> ')}`);
      return;
    }
    // Imports without a body share one instance, but only within one transform
    // scope: the nearest enclosing import with rename / gds / scale options.
    // Under different options a shared file is a different instance.
    const plain = !st.body || st.body.stmts.length === 0;
    const optionBlocks = (st.body?.stmts ?? []).filter((b) => b.type === 'Object' && !b.name && ['rename', 'gds', 'scale'].includes(b.kind));
    const shareKey = `${path}|${this.transformRoot.muid}`;
    if (plain && this.s.shared.has(shareKey)) { this.imports.set(st.alias, this.s.shared.get(shareKey)); return; }
    const f = this.s.file(path);
    if (!f) { this.err('C011', pathNode, `cannot find module '${st.path}' (looked for ${path})`); return; }
    const inst = new Module(this.s, path, f, this, st);
    if (optionBlocks.length) inst.transformRoot = inst;
    for (const b of optionBlocks) {
      this.noTypedRequired(b.body);
      inst.config[b.kind === 'rename' ? 'renameNode' : b.kind] = { node: b, scope: this };
      if (b.kind === 'rename') {
        for (const r of b.body.stmts) if (r.type === 'Assign' && r.name === 'prefix') inst.config.prefix = { expr: r.value, scope: this, node: r };
      }
    }
    this.s.loading.push(path);
    inst.build();
    this.s.loading.pop();
    if (plain) this.s.shared.set(shareKey, inst);
    this.imports.set(st.alias, inst);

    for (const b of st.body?.stmts ?? []) {
      if (b.type === 'Assign') {
        if (!inst.params.has(b.name)) {
          const s = this.suggest(b.name, [...inst.params.keys()], b.nameNode);
          this.err('C013', b.nameNode, `module '${st.path}' has no parameter '${b.name}'`, s.hint ?? `its parameters: ${[...inst.params.keys()].join(', ') || 'none'}`, null, s.fix);
          continue;
        }
        const prev = inst.params.get(b.name);
        if (prev.bound) { this.err('C020', b.nameNode, `'${b.name}' is bound twice`); continue; }
        this.noTypedRequired(b.value);
        inst.params.set(b.name, { name: b.name, expr: b.value, node: b, scope: this, memo: {}, bound: true, declared: prev });
      } else if (b.type === 'Object' && !b.name && ['rename', 'gds', 'scale'].includes(b.kind)) {
        if (b.kind === 'rename') {
          for (const r of b.body.stmts) {
            if (r.type !== 'Assign' || r.name === 'prefix') continue;
            if (r.value.type !== 'Ref' || r.value.parts.length !== 1) { this.err('V032', r.value, 'rename to a plain name: rename { OLD = NEW }'); continue; }
            if (!inst.objects.has(r.name)) {
              const s = this.suggest(r.name, [...inst.objects.keys()], r.nameNode);
              this.err('C021', r.nameNode, `module '${st.path}' has no object '${r.name}' to rename`, s.hint, null, s.fix);
              continue;
            }
            inst.config.rename.set(r.name, r.value.parts[0]);
          }
        }
      } else {
        this.err('V032', b.kindNode ?? b.nameNode ?? b, 'an import body holds parameter bindings and rename { } / gds { } / scale { } blocks');
      }
    }
  }

  buildObject(node, parent, scope, inPatch = false) {
    const o = {
      uid: (this.s.nextUid = (this.s.nextUid ?? 0) + 1),
      kind: node.kind, name: node.name, parent, node, mod: scope, srcMod: scope,
      path: parent ? `${parent.path}.${node.name ?? node.kind}` : (node.name ?? node.kind),
      attrs: new Map(), children: new Map(), invalid: false, inPatch,
    };
    this.fill(o, node.body.stmts, scope, inPatch);
    return o;
  }

  // Body statements: assignments overwrite, nested objects merge by name,
  // drops remove. `scope` is the module the statements were written in.
  fill(o, stmts, scope, inPatch = false) {
    const seenAttr = new Set();
    const seenChild = new Set();
    for (const st of stmts) {
      if (st.type === 'Assign') {
        scope.noTypedRequired(st.value);
        if (seenAttr.has(st.name)) scope.warn('C022', st.nameNode, `'${st.name}' is set twice; the last one wins`);
        seenAttr.add(st.name);
        o.attrs.set(st.name, { name: st.name, expr: st.value, node: st, scope, state: 'todo' });
        this.s.declare(o, st.name, scope, st, st.name === 'base' ? st.value : undefined);
        o.tomb?.delete(st.name); o.tombNodes?.delete(st.name);
      } else if (st.type === 'Object') {
        const key = st.name ?? '#' + st.kind;
        if (seenChild.has(key)) { scope.err('C020', st.nameNode ?? st.kindNode, `'${st.name ?? st.kind}' appears twice in this block`, null, o); continue; }
        seenChild.add(key);
        this.s.declare(o, key, scope, st);
        const gone = o.tomb?.has(key) ? o.tombNodes?.get(key) : undefined;
        o.tomb?.delete(key); o.tombNodes?.delete(key);
        const child = scope.buildObject(st, o, scope, inPatch);
        child.mod = o.mod;
        const prev = o.children.get(key);
        if (prev && prev.kind === child.kind) mergeInto(prev, child);
        else { o.children.set(key, child); linkPrior(child, gone?.removed ?? priorChild(o, key), gone ? droppers(gone) : o.priorBy); }
      } else if (st.type === 'Drop') {
        if (st.ref.parts.length !== 1) { scope.err('C050', st.ref, 'inside a block, drop takes a single name'); continue; }
        const name = st.ref.parts[0];
        const pendingBase = o.attrs.has('base');
        const removed = o.children.get(name);
        const had = o.attrs.delete(name) | o.children.delete(name);
        // Remember the drop, so an inherited value cannot come back when `base` is
        // applied. Whether the name exists is decided once, after inheritance
        // (Session.checkDrops), from what this module can see.
        tombstone(o, name, st.ref, scope, !!had, removed);
        this.s.mustExist(o, name, scope, st.ref);
      } else if (st.type === 'Patch') {
        scope.warn('W091', st, 'patches inside a block are not supported; write them at the top level');
      }
    }
  }

  // Look up a dotted path: own objects first, then import aliases.
  lookupPath(parts) {
    let o = this.objects.get(parts[0]) ?? this.unnamed.get('#' + parts[0]);
    if (!o && this.imports.has(parts[0]) && parts.length > 1) return this.imports.get(parts[0]).lookupPath(parts.slice(1));
    for (const p of parts.slice(1)) o = o?.children.get(p);
    return o;
  }

  isDropped(parts) {
    if (parts.length > 1 && this.imports.has(parts[0])) return this.imports.get(parts[0]).isDropped(parts.slice(1));
    return this.droppedNames.has(parts[0]);
  }

  // Split a dotted reference into the module that owns it and the rest: at every
  // module, its own names (unnamed roots and dropped names included) come before
  // its import aliases.
  splitRef(parts) {
    let owner = this, rest = parts;
    const local = (m, n) => m.objects.has(n) || m.unnamed.has('#' + n) || m.droppedNames.has(n);
    while (rest.length > 1 && !local(owner, rest[0]) && owner.imports.has(rest[0])) { owner = owner.imports.get(rest[0]); rest = rest.slice(1); }
    return { owner, rest };
  }

  // Follow a dotted path through live objects and through objects that were
  // dropped (kept in droppedNames / tombstones), noting who dropped them.
  walkPath(parts) {
    const { owner, rest } = this.splitRef(parts);
    const by = new Set();
    let o = owner.objects.get(rest[0]) ?? owner.unnamed.get('#' + rest[0]);
    if (!o) {
      const d = owner.droppedNames.get(rest[0]);
      if (!d || d.kind === 'param') return { obj: null, by, owner, rest };
      o = d;
      for (const m of owner.droppedBy?.get(rest[0]) ?? []) by.add(m);
    }
    for (const seg of rest.slice(1)) {
      const c = o.children.get(seg);
      if (c) { o = c; continue; }
      const g = o.tombNodes?.get(seg);
      if (g?.removed) { for (const m of droppers(g)) by.add(m); o = g.removed; continue; }
      // a child of the object this one replaced, left out of the replacement
      const pc = priorChild(o, seg);
      if (!pc) return { obj: null, by, owner, rest };
      for (const m of o.priorBy ?? []) by.add(m);
      o = pc;
    }
    return { obj: o, by, owner, rest };
  }

  applyPatches() {
    for (const p of this.patches) {
      const w = this.walkPath(p.ref.parts);
      const others = [...w.by].filter((m) => m !== this);
      if (!w.obj || (w.by.size && !others.length)) {
        // missing, or dropped by this module itself
        const pool = [...this.objects.keys(), ...[...this.imports].flatMap(([a, m]) => [...m.objects.keys()].map((k) => `${a}.${k}`))];
        const s = this.suggest(p.ref.parts.join('.'), pool, { from: p.ref.from, to: p.ref.to });
        this.err('C050', p.ref, `cannot patch '${p.ref.parts.join('.')}': no such object`, s.hint, null, s.fix);
        continue;
      }
      // Dropped by one of this module's own imports (and not restored within
      // them): C051, whether the object is gone, or an unrelated module has
      // restored it in the meantime.
      const mine = others.find((m) => this.s.reaches(this, m) || this.s.reaches(m, this)) ?? this.droppedByMine(w.obj);
      if (mine) {
        this.err('C051', p.ref, `cannot patch '${p.ref.parts.join('.')}': ${mine.label()} dropped it (or an object above it)`);
        continue;
      }
      // Dropped by an unrelated module: check the patch exactly as if the object
      // were still there (the other import order) and record that it asserts the
      // object exists; Session.patchConflicts decides (C052 unless settled).
      this.fill(w.obj, p.body.stmts, this, true);
      this.notePatchedAttrs(w.obj, p.body.stmts);
      // Patching an object asserts that it and its ancestors exist.
      for (let c = w.obj; c; c = c.parent) this.noteEffect(keyOf(c), { obj: c.parent ?? c, name: c.name ?? '#' + c.kind, present: c.kind, node: p.ref });
    }
  }

  // Was `o` (or an object above it) dropped by one of this module's imports,
  // with no later restoration by this module or one of its imports?
  droppedByMine(o) {
    const reg = this.s.patchedBy ?? new Map();
    for (let c = o; c; c = c.parent) {
      let by = null;
      for (const e of reg.get(keyOf(c)) ?? []) {
        if (e.drop && e.mod !== this && this.s.reaches(this, e.mod)) by = e.mod;
        else if (e.declares && by && (e.mod === this || this.s.reaches(this, e.mod))) by = null;
      }
      if (by) return by;
    }
    return null;
  }

  // Remember who patched which attribute of which object; Session.patchConflicts
  // compares the evaluated values after evaluation (C052). Keys are logical
  // paths (keyOf), so they survive a child being dropped and declared again.
  noteEffect(key, entry) {
    const reg = (this.s.patchedBy ??= new Map());
    if (!reg.has(key)) reg.set(key, []);
    reg.get(key).push({ mod: this, ...entry });
  }

  notePatchedAttrs(target, stmts) {
    const base = keyOf(target);
    for (const st of stmts) {
      if (st.type === 'Assign') {
        const rec = target.attrs.get(st.name);
        if (rec && rec.node === st) this.noteEffect(`${base}@${st.name}`, { obj: target, name: st.name, rec });
      } else if (st.type === 'Drop' && st.ref.parts.length === 1) {
        // a child or an attribute: the drop covers both paths
        const n = st.ref.parts[0];
        this.noteEffect(`${base}/${n}`, { obj: target, name: n, drop: true, node: st.ref });
        this.noteEffect(`${base}@${n}`, { obj: target, name: n, drop: true, node: st.ref });
      } else if (st.type === 'Object') {
        // Declaring a child asserts (or restores) it: it conflicts with a
        // sibling's drop of the same child (B1).
        const key = st.name ?? '#' + st.kind;
        this.noteEffect(`${base}/${key}`, { obj: target, name: key, present: st.kind, declares: true, node: st.nameNode ?? st.kindNode });
        const child = target.children.get(key);
        if (child) this.notePatchedAttrs(child, st.body.stmts);
      }
    }
  }

  applyDrops() {
    for (const d of this.drops) {
      const parts = d.ref.parts;
      // local names (unnamed roots included) come before import aliases, at every module
      const { owner, rest } = this.splitRef(parts);
      if (rest.length === 1) {
        const name = rest[0];
        const o = owner.objects.get(name);
        if (o || owner.params.has(name) || owner.droppedNames.has(name)) this.s.mustExistTop(owner, name, this, d.ref);
        if (o) {
          owner.order = owner.order.filter((x) => x !== o);
          owner.objects.delete(name);
          owner.droppedNames.set(name, o);
          (owner.droppedBy ??= new Map()).set(name, new Set([this]));
          this.s.dropped.add(o);
          this.noteEffect(keyOf(o), { drop: true, node: d.ref, obj: o, name });
        } else if (owner.params.has(name)) {
          (owner.droppedParams ??= new Map()).set(name, owner.params.get(name));   // its binding is still type-checked
          owner.params.delete(name);
          owner.droppedNames.set(name, { path: name, kind: 'param' });
        } else if (owner.droppedNames.has(name)) {
          // already dropped (by this or another module): the same effect again
          const prev = owner.droppedNames.get(name);
          if (prev.kind !== 'param') this.noteEffect(keyOf(prev), { drop: true, node: d.ref, obj: prev, name });
          owner.droppedBy?.get(name)?.add(this);
        } else {
          this.err('C050', d.ref, `nothing named '${parts.join('.')}' to drop`, this.didYouMean(name, [...owner.objects.keys()]));
        }
        continue;
      }
      // the parent may itself have been dropped by another module: the drop
      // still names something real, whatever the import order
      const parent = this.walkPath(parts.slice(0, -1)).obj;
      const last = rest[rest.length - 1];
      const removed = parent?.children.get(last);
      const had = parent && (parent.children.delete(last) | parent.attrs.delete(last));
      if (parent) {
        this.noteEffect(`${keyOf(parent)}/${last}`, { drop: true, node: d.ref, obj: parent, name: last });
        this.noteEffect(`${keyOf(parent)}@${last}`, { drop: true, node: d.ref, obj: parent, name: last });
      }
      // survives a later base merge; a repeat of an existing drop is the same effect
      if (parent) { tombstone(parent, last, d.ref, this, !!had, removed); this.s.mustExist(parent, last, this, d.ref); }
      else this.err('C050', d.ref, `nothing named '${parts.join('.')}' to drop`);
    }
  }

  applyBase(o, chain) {
    if (o.baseState === 'done' || o.baseState === 'busy') return;
    const b = o.attrs.get('base');
    if (!b) { o.baseState = 'done'; return; }
    o.baseState = 'busy';
    o.attrs.delete('base');
    const finish = () => { o.baseState = 'done'; };
    const sc = b.scope;
    if (b.expr.type !== 'Ref') { sc.err('C040', b.expr, 'base must name an object', null, o); return finish(); }
    // (while dropped objects are given their inheritance, a dropped base counts too)
    const base = sc.lookupPath(b.expr.parts) ?? (this.s.mute ? sc.walkPath(b.expr.parts).obj : undefined);
    const name = b.expr.parts.join('.');
    if (!base) {
      if (sc.isDropped(b.expr.parts)) sc.err('C051', b.expr, `'${name}' was dropped`, null, o);
      else {
        const s = sc.suggest(name, sc.order.filter((x) => x.kind === o.kind).map((x) => x.name), b.expr);
        sc.err('C021', b.expr, `unknown object '${name}'`, s.hint, o, s.fix);
      }
      return finish();
    }
    if (base.kind !== o.kind) { sc.err('C040', b.expr, `base '${name}' is a ${base.kind}, but this is a ${o.kind}`, null, o); return finish(); }
    if (base === o || base.baseState === 'busy') {
      sc.err('C041', b.expr, `inheritance cycle: ${[...chain, o, base].map((x) => x.path).join(' -> ')}`, null, o);
      return finish();
    }
    base.mod.applyBase(base, [...chain, o]);
    const own = { attrs: o.attrs, children: o.children, tomb: o.tomb, tombNodes: o.tombNodes, checkDeferred: true };
    o.tomb = undefined;
    o.tombNodes = undefined;
    o.attrs = new Map();
    for (const [k, a] of base.attrs) o.attrs.set(k, { ...a, state: 'todo', value: undefined });
    o.children = new Map();
    for (const [k, c] of base.children) o.children.set(k, cloneObj(c, o));
    mergeInto(o, own);
    finish();
  }

  // ---- import configuration -------------------------------------------------------
  configNum(block, key, fallback) {
    const c = this.config[block];
    if (!c) return fallback;
    const a = c.node.body.stmts.find((x) => x.type === 'Assign' && x.name === key);
    if (!a) return fallback;
    try {
      const v = c.scope.eval(a.value, { cls: 'xy', noscale: true });
      return v;
    } catch (e) { if (!(e instanceof EvalErr)) throw e; return fallback; }
  }

  // Composed scale factors {xy, z, snap} or null; nested imports multiply.
  scaleFactors() {
    if (this._scale !== undefined) return this._scale;
    let own = null;
    if (this.config.scale) {
      const xy = this.configNum('scale', 'xy', { t: 'num', q: ONE, dim: 0 });
      const z = this.configNum('scale', 'z', xy);
      const snap = this.configNum('scale', 'snap', { t: 'bool', v: false });
      const bad = [xy, z].find((v) => v.t !== 'num' || v.dim !== 0 || v.q.cmp(ZERO) <= 0);
      if (bad) this.config.scale.scope.err('V033', this.config.scale.node.kindNode, 'scale factors must be positive numbers, e.g. scale { xy = 36/200 }');
      else own = { xy: xy.q, z: z.q, snap: snap.t === 'bool' && snap.v };
      for (const st of this.config.scale.node.body.stmts) {
        if (st.type === 'Assign' && !['xy', 'z', 'snap'].includes(st.name)) this.config.scale.scope.err('V033', st.nameNode, `scale takes xy, z and snap, not '${st.name}'`);
      }
    }
    const up = this.importer?.scaleFactors() ?? null;
    this._scale = own && up ? { xy: own.xy.mul(up.xy), z: own.z.mul(up.z), snap: own.snap || up.snap } : own ?? up;
    return this._scale;
  }

  gdsShift() {
    if (this._gds !== undefined) return this._gds;
    const v = this.configNum('gds', 'shift', { t: 'num', q: ZERO, dim: 0 });
    let own = 0n;
    if (v.t === 'num' && v.dim === 0 && v.q.isInt()) own = v.q.n;
    else this.config.gds.scope.err('V033', this.config.gds.node.kindNode, 'gds { shift = N } takes an integer');
    this._gds = own + (this.importer?.gdsShift() ?? 0n);
    return this._gds;
  }

  resolvedName(name) {
    let n = name;
    for (let m = this; m && m.importer; m = m.importer) {
      if (m.config.rename.has(n)) { n = m.config.rename.get(n); continue; }
      if (m.config.prefix) {
        try {
          const v = m.config.prefix.scope.eval(m.config.prefix.expr, { cls: 'xy' });
          if (v.t === 'str') n = v.v + n; else m.config.prefix.scope.err('V032', m.config.prefix.expr, 'prefix takes a string, e.g. prefix = "PK_"');
        } catch (e) { if (!(e instanceof EvalErr)) throw e; }
      }
    }
    return n;
  }

  // ---- evaluation -----------------------------------------------------------
  evaluateAll() {
    for (const name of this.params.keys()) this.tryEval(() => this.evalParam(name, 'xy'));
    const walk = (o) => { for (const name of o.attrs.keys()) this.tryEval(() => o.mod.evalAttr(o, name), o); for (const c of o.children.values()) walk(c); };
    for (const o of this.unnamed.values()) walk(o);
    for (const o of this.order) walk(o);
  }

  tryEval(fn, obj) {
    try { fn(); } catch (e) {
      if (!(e instanceof EvalErr)) throw e;
      if (obj) obj.invalid = true;
    }
  }

  value(o, name) {
    const a = o.attrs.get(name);
    return a?.state === 'done' ? a.value : undefined;
  }

  evalParam(name, cls) {
    const p = this.params.get(name);
    p.memo[cls] ??= { state: 'todo', expr: p.expr };
    return p.scope.memo(p.memo[cls], `${this.label() === this.path ? '' : this.label() + '.'}${name}`, () => {
      if (p.expr.type === 'Lit' && p.expr.v === 'required') {
        const where = this.importNode ? `, bind it in the import: import "${this.importNode.path}" as ${this.alias} { ${name} = ... }` : '';
        if (this.importNode) this.importer.err('C012', this.importNode.aliasNode, `module '${this.importNode.path}' requires parameter '${name}'`, `add ${name} = ... to the import body`);
        this.fail('C012', p.node.nameNode, `parameter '${name}' is required but nothing binds it${where}`);
      }
      return p.scope.eval(p.expr, { cls });
    });
  }

  // Vertical attributes use the z scale factor.
  attrClass(o, name) {
    if (o.kind === 'figure' && name === 'thickness') return 'z';
    if (o.kind === 'array' && (name === 'pitch' || name === 'offset') && o.attrs.has('axis')) {
      try { if (this.evalAttr(o, 'axis')?.v === 'z') return 'z'; } catch (e) { if (!(e instanceof EvalErr)) throw e; }
    }
    return 'xy';
  }

  evalAttr(o, name) {
    const a = o.attrs.get(name);
    const label = `${o.path}.${name}`;
    return a.scope.memo(a, label, () => {
      const spec = attrSpec(o.kind, name);
      // Technology settings (grid, stack) are metadata and are never scaled.
      return spec?.type.k === 'attrref' ? a.scope.evalAttrRef(a.expr) : a.scope.eval(a.expr, { cls: this.attrClass(o, name), noscale: o.kind === 'technology' });
    });
  }

  memo(rec, label, compute) {
    if (rec.state === 'done') {
      const outer = this.s.depFrames?.[this.s.depFrames.length - 1];
      if (outer) { for (const d of rec.deps ?? []) outer.reads.add(d); for (const d of rec.refDeps ?? []) outer.refs.add(d); }
      return rec.value;
    }
    if (rec.state === 'err') throw new EvalErr('silent');
    const st = this.s.evalStack ??= [];
    if (rec.state === 'busy') {
      const cycle = [...st.slice(st.indexOf(label)), label].join(' -> ');
      rec.state = 'err';
      this.fail('C030', rec.expr, `evaluation cycle: ${cycle}`);
    }
    rec.state = 'busy';
    st.push(label);
    const frames = this.s.depFrames ??= [];
    frames.push({ reads: new Set(), refs: new Set() });
    try {
      rec.value = compute();
      rec.state = 'done';
      return rec.value;
    } catch (e) {
      rec.state = 'err';
      throw e;
    } finally {
      st.pop();
      const fr = frames.pop();
      rec.deps = fr.reads;
      rec.refDeps = fr.refs;
      const outer = frames[frames.length - 1];
      if (outer) { for (const d of fr.reads) outer.reads.add(d); for (const d of fr.refs) outer.refs.add(d); }
    }
  }

  eval(e, ctx = { cls: 'xy' }) {
    switch (e.type) {
      case 'Num': return { t: 'num', q: e.q, dim: 0 };
      case 'Len': return this.evalLen(e, ctx);
      case 'Str': return { t: 'str', v: e.v };
      case 'Lit':
        if (e.v === 'true' || e.v === 'false') return { t: 'bool', v: e.v === 'true' };
        if (e.v === 'none') return { t: 'word', v: 'none', node: e, mod: this };
        return this.fail('C012', e, "'required' is only allowed as a parameter value");
      case 'List': return { t: 'list', items: e.items.map((x) => this.eval(x, ctx)) };
      case 'Range': {
        const lo = this.num(e.lo, 'a range bound', ctx);
        const hi = this.num(e.hi, 'a range bound', ctx);
        if (lo.t === 'poison') return lo;
        if (hi.t === 'poison') return hi;
        if (lo.dim !== hi.dim) this.fail('C031', e, `range mixes ${dimName(lo.dim)} and ${dimName(hi.dim)}`, 'give both ends a unit, e.g. 0nm .. 120nm');
        return { t: 'range', lo, hi };
      }
      case 'Neg': { const v = this.num(e.e, "'-'", ctx); return v.t === 'poison' ? v : { ...v, q: v.q.neg() }; }
      case 'Bin': return this.evalBin(e, ctx);
      case 'Cmp': return this.evalCmp(e, ctx);
      case 'Ref': return this.evalRef(e, ctx);
      case 'Call': return this.evalCall(e, ctx);
      default: return this.fail('C001', e, 'cannot evaluate this expression');
    }
  }

  // Length literal: the module's scale factor applies here, and only here, so
  // values that come from an importer's bindings are never rescaled.
  evalLen(e, ctx) {
    let q = e.q;
    const sc = ctx.noscale ? null : this.scaleFactors();
    if (sc) {
      q = q.mul(ctx.cls === 'z' ? sc.z : sc.xy);
      if (sc.snap) {
        const g = this.s.grid();
        const snapped = q.div(g).round().mul(g);
        if (!snapped.eq(q)) (this.snaps ??= new Map()).set(`${e.from}:${ctx.cls}`, { node: e, from: q, to: snapped });
        q = snapped;
      }
    }
    return { t: 'num', q, dim: 1, node: e, mod: this };
  }

  num(e, what, ctx) {
    const v = this.eval(e, ctx);
    if (v.t === 'poison') return v;
    if (v.t !== 'num') this.fail('C031', e, `${what} must be a number or length, got ${describeValue(v)}`);
    return v;
  }

  evalBin(e, ctx) {
    const l = this.num(e.l, `'${e.op}'`, ctx);
    const r = this.num(e.r, `'${e.op}'`, ctx);
    if (l.t === 'poison') return l;
    if (r.t === 'poison') return r;
    let q, dim;
    if (e.op === '+' || e.op === '-') {
      if (l.dim !== r.dim) this.fail('C031', e, `cannot ${e.op === '+' ? 'add' : 'subtract'} ${dimName(l.dim)} and ${dimName(r.dim)}`, 'write lengths with a unit, e.g. 20nm');
      q = e.op === '+' ? l.q.add(r.q) : l.q.sub(r.q);
      dim = l.dim;
    } else if (e.op === '*') {
      q = l.q.mul(r.q);
      dim = l.dim + r.dim;
    } else {
      if (r.q.isZero()) this.fail('C033', e.r, 'division by zero');
      q = l.q.div(r.q);
      dim = l.dim - r.dim;
    }
    if (dim < 0 || dim > 2) this.fail('C031', e, `result has an unsupported dimension (length^${dim})`);
    return { t: 'num', q, dim };
  }

  evalCmp(e, ctx) {
    const l = this.eval(e.l, ctx);
    const r = this.eval(e.r, ctx);
    if (l.t === 'poison') return l;
    if (r.t === 'poison') return r;
    const show = (v) => (v.t === 'num' ? (v.dim === 0 ? fmtNum(v.q) : v.dim === 1 ? fmtLen(v.q) : fmtArea(v.q)) : describeValue(v));
    let res;
    if (l.t === 'num' && r.t === 'num') {
      if (l.dim !== r.dim) this.fail('C031', e, `cannot compare ${dimName(l.dim)} with ${dimName(r.dim)}`);
      const c = l.q.cmp(r.q);
      res = { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0, '==': c === 0, '!=': c !== 0 }[e.op];
    } else if ((e.op === '==' || e.op === '!=') && [l, r].every((x) => ['word', 'str', 'bool', 'ref', 'num'].includes(x.t))) {
      const same = valueKey(l) === valueKey(r);
      res = e.op === '==' ? same : !same;
    } else {
      this.fail('C031', e, `'${e.op}' compares numbers or lengths, got ${describeValue(l)} and ${describeValue(r)}`);
    }
    return { t: 'bool', v: res, detail: `${this.text(e.l).trim()} ${e.op} ${this.text(e.r).trim()} is ${show(l)} ${e.op} ${show(r)}` };
  }

  evalRef(e, ctx) {
    // Walk import aliases first: dev.CPP, a.b.M1. Errors are reported here,
    // in the file that holds the reference.
    let owner = this;
    let parts = e.parts;
    while (parts.length > 1 && !owner.params.has(parts[0]) && !owner.objects.has(parts[0]) && owner.imports.has(parts[0])) {
      owner = owner.imports.get(parts[0]);
      parts = parts.slice(1);
    }
    const [first, ...rest] = parts;
    const qual = owner !== this;
    let o;
    if (owner.params.has(first)) {
      const v = owner.evalParam(first, ctx.cls);
      if (!rest.length) return v;
      // A parameter bound to an object (e.g. LANDING = dev.MD) gives access to
      // that object's attributes and children: L.pitch.
      if (v.t !== 'ref') this.fail('C021', e, `parameter '${first}' is ${describeValue(v)}, which has no attribute '${rest[0]}'`);
      o = v.obj;
    }
    o ??= owner.objects.get(first) ?? (qual ? undefined : owner.unnamed.get('#' + first));
    if (!o && owner.imports.has(first) && !rest.length) return { t: 'module', mod: owner.imports.get(first), node: e, mod2: this };
    if (!o) {
      if (owner.droppedNames.has(first)) {
        const d = owner.droppedNames.get(first);
        if (d.kind === 'param') this.fail('C051', e, `parameter '${e.parts.join('.')}' was dropped`);
        return rest.length ? { t: 'poison', obj: d, node: e, mod: this } : { t: 'dropped', obj: d, node: e, mod: this };
      }
      if (!rest.length && !qual) return { t: 'word', v: first, node: e, mod: this };
      const pool = [...owner.params.keys(), ...owner.objects.keys(), ...owner.imports.keys()];
      const start = e.to - parts.join('.').length;
      const s = this.suggest(first, pool, { from: start, to: start + first.length });
      this.fail('C021', e, qual ? `module '${owner.label()}' has no '${first}'` : `unknown name '${first}'`, s.hint, s.fix);
    }
    for (let i = 0; i < rest.length; i++) {
      const part = rest[i];
      const child = o.children.get(part);
      if (child) { o = child; continue; }
      if (i === rest.length - 1) {
        this.s.depFrames?.[this.s.depFrames.length - 1]?.reads.add(o);
        if (o.attrs.has(part)) return o.mod.evalAttr(o, part);
        const spec = attrSpec(o.kind, part);
        if (spec?.default) return spec.default;
        if (spec) this.fail('C021', e, `'${o.path}' does not set '${part}'`);
      }
      this.fail('C021', e, `'${o.path}' has no attribute or child '${part}'`,
        this.didYouMean(part, [...o.attrs.keys(), ...o.children.keys(), ...Object.keys(KINDS[o.kind]?.attrs ?? {})]));
    }
    this.s.depFrames?.[this.s.depFrames.length - 1]?.refs.add(o);
    return { t: 'ref', obj: o, node: e, mod: this };
  }

  evalAttrRef(e) {
    if (e.type !== 'Ref' || e.parts.length < 2) this.fail('V003', e, 'expected an attribute reference such as SHEET.width');
    const objParts = e.parts.slice(0, -1);
    const o = this.lookupPath(objParts);
    const attr = e.parts[e.parts.length - 1];
    if (!o) {
      if (this.isDropped(objParts)) return { t: 'dropped', obj: { path: objParts.join('.') }, node: e, mod: this };
      this.fail('C021', e, `unknown object '${objParts.join('.')}'`, this.didYouMean(e.parts[0], [...this.objects.keys()]));
    }
    if (!attrSpec(o.kind, attr)) {
      const s = this.suggest(attr, Object.keys(KINDS[o.kind]?.attrs ?? {}), { from: e.to - attr.length, to: e.to });
      this.fail('C021', e, `a ${o.kind} has no attribute '${attr}'`, s.hint, s.fix);
    }
    return { t: 'attrref', obj: o, attr, node: e, mod: this };
  }

  evalCall(e, ctx) {
    const fn = FUNCTIONS[e.fn];
    if (!fn) { const s = this.suggest(e.fn, Object.keys(FUNCTIONS), e.fnNode); this.fail('C032', e.fnNode, `unknown function '${e.fn}'`, s.hint, s.fix); }
    const args = e.args.map((x) => this.eval(x, ctx));
    const poison = args.find((v) => v.t === 'poison');
    if (poison) return poison;
    if (fn.kind === 'value') {
      if (!args.length) this.fail('C032', e, 'one_of needs at least one value');
      return { t: 'choice', items: args, node: e, mod: this };
    }
    if (fn.kind === 'geom') return { t: 'call', fn: e.fn, args, argNodes: e.args, node: e, mod: this };
    if (fn.kind === 'logic') {
      for (const [i, v] of args.entries()) if (v.t !== 'bool') this.fail('C031', e.args[i], `${e.fn} takes true/false values (comparisons), got ${describeValue(v)}`);
      if (e.fn === 'not') {
        if (args.length !== 1) this.fail('C032', e, 'not takes one argument');
        return { t: 'bool', v: !args[0].v, detail: `not (${args[0].detail ?? args[0].v})` };
      }
      const v = e.fn === 'all' ? args.every((x) => x.v) : args.some((x) => x.v);
      const failing = args.filter((x) => !x.v).map((x) => x.detail ?? 'false');
      return { t: 'bool', v, detail: e.fn === 'all' ? failing.join('; ') : `none of: ${failing.join('; ')}` };
    }
    // numeric
    if (!args.length) this.fail('C032', e, `${e.fn} needs an argument`);
    for (const [i, v] of args.entries()) if (v.t !== 'num') this.fail('C031', e.args[i], `${e.fn} takes numbers or lengths`);
    if (e.fn === 'mod') {
      if (args.length !== 2 || args[0].dim !== args[1].dim) this.fail('C031', e, 'mod(x, y) takes two values of the same dimension');
      if (args[1].q.isZero()) this.fail('C033', e.args[1], 'mod by zero');
      const k = args[0].q.div(args[1].q).floor();
      return { t: 'num', q: args[0].q.sub(args[1].q.mul(k)), dim: args[0].dim };
    }
    if (e.fn === 'min' || e.fn === 'max') {
      if (args.some((v) => v.dim !== args[0].dim)) this.fail('C031', e, `${e.fn} mixes numbers and lengths`);
      return args.reduce((m, v) => ((e.fn === 'min' ? v.q.cmp(m.q) < 0 : v.q.cmp(m.q) > 0) ? v : m));
    }
    if (args.length !== 1 || args[0].dim !== 1) this.fail('C031', e, `${e.fn} takes one length`);
    const g = this.s.grid();
    const steps = args[0].q.div(g);
    const r = e.fn === 'floor' ? steps.floor() : e.fn === 'ceil' ? steps.ceil() : steps.round();
    return { t: 'num', q: r.mul(g), dim: 1 };
  }

  // ---- validation (VOCABULARY.md section 5) ----------------------------------------
  checkObject(o) {
    const spec = KINDS[o.kind];
    const where = o.node.kindNode;
    if (!spec) {
      if (o.kind.startsWith('x_')) { this.warn('W001', where, `extension object '${o.kind}' is not understood by this tool`); return; }
      const allowed = o.parent ? Object.keys(KINDS[o.parent.kind]?.children ?? {}) : Object.keys(KINDS).filter((k) => KINDS[k].top);
      const s = this.suggest(o.kind, allowed, where);
      this.err('V001', where, `unknown object kind '${o.kind}'`, s.hint ?? `expected one of: ${allowed.join(', ')}`, o, s.fix);
      return;
    }
    if (!o.parent && !spec.top) {
      const parents = Object.keys(KINDS).filter((k) => KINDS[k].children?.[o.kind]);
      this.err('V001', where, `'${o.kind}' can only appear inside ${parents.join(' or ')}`, null, o);
    }
    if (o.parent && !KINDS[o.parent.kind]?.children?.[o.kind]) {
      const allowed = Object.keys(KINDS[o.parent.kind]?.children ?? {});
      this.err('V001', where, `'${o.kind}' is not allowed inside ${o.parent.kind}`,
        allowed.length ? `allowed here: ${allowed.join(', ')}` : `${o.parent.kind} has no nested objects`, o);
    }
    if (spec.named && !o.name) this.err('V004', where, `a ${o.kind} needs a name: ${o.kind} NAME { ... }`, null, o);
    if (!spec.named && o.name) this.err('V003', o.node.nameNode, `'${o.kind}' takes no name`, null, o);

    for (const [name, a] of o.attrs) {
      const as = attrSpec(o.kind, name);
      const sm = a.scope;
      if (!as) {
        if (name.startsWith('x_')) { sm.warn('W001', a.node.nameNode, `extension attribute '${name}' is not understood by this tool`); continue; }
        const s = sm.suggest(name, Object.keys(spec.attrs), a.node.nameNode);
        sm.err('V002', a.node.nameNode, `a ${o.kind} has no attribute '${name}'`, s.hint ?? `attributes: ${Object.keys(spec.attrs).join(', ')}`, o, s.fix);
        continue;
      }
      if (a.state !== 'done') continue;
      const problem = sm.checkType(a.value, as.type);
      if (problem) {
        let fix = problem.fix;
        const x = a.expr;
        if (!fix && problem.addUnit && x.type === 'Num') fix = { from: x.to, to: x.to, insert: 'nm', label: 'Add unit nm' };
        if (!fix && problem.quote && x.type === 'Ref') fix = { from: x.from, to: x.to, insert: `"${sm.text(x)}"`, label: 'Put in quotes' };
        if (!fix && problem.wrapList) fix = { from: x.from, to: x.to, insert: `[${sm.text(x)}]`, label: 'Make it a list' };
        const pm = problem.mod ?? sm;
        pm.err(problem.code ?? 'V003', problem.node ?? a.expr, `${o.kind} ${o.path}: '${name}' ${problem.msg}`, problem.hint, o, pm === sm ? fix : problem.fix);
      } else if (a.value.t === 'word' && a.value.v.startsWith('x_')) {
        sm.warn('W001', a.expr, `extension value '${a.value.v}' is not understood by this tool`);
      }
    }
    for (const [name, as] of Object.entries(spec.attrs)) {
      if (as.required && !o.attrs.has(name)) {
        this.err('V004', o.node.nameNode ?? where, `${o.kind} ${o.path} is missing '${name}'`, `${name} = ${describeType(as.type)}`, o);
      }
    }
    for (const c of o.children.values()) c.srcMod.checkObject(c);
    this.checkKind(o);
  }

  checkType(v, t) {
    const mismatch = (extra) => ({ msg: `should be ${describeType(t)}, not ${describeValue(v)}`, hint: extra, node: v.node, mod: v.mod });
    switch (t.k) {
      case 'any': return null;
      case 'len':
        if (v.t === 'num' && v.dim === 1) return null;
        if (v.t === 'num' && v.dim === 0) return { ...mismatch(`add a unit, e.g. ${v.q}nm`), addUnit: true };
        return mismatch();
      case 'area':
        return v.t === 'num' && v.dim === 2 ? null : mismatch(v.t === 'num' && v.dim === 1 ? 'an area is a product of two lengths, e.g. 288nm * 1nm' : undefined);
      case 'int': return v.t === 'num' && v.dim === 0 && v.q.isInt() ? null : mismatch();
      case 'num': return v.t === 'num' && v.dim === 0 ? null : mismatch();
      case 'str': return v.t === 'str' ? null : v.t === 'word' ? { ...mismatch(`put text in quotes: "${v.v}"`), quote: true } : mismatch();
      case 'bool': return v.t === 'bool' ? null : mismatch();
      case 'xword': return v.t === 'word' && /^x_\w+/.test(v.v) ? null : mismatch();
      case 'enum':
        if (v.t === 'word' && t.vals.includes(v.v)) return null;
        if (v.t === 'word') {
          const ms = v.mod ?? this;
          const s = ms.suggest(v.v, t.vals, v.node);
          return { msg: `'${v.v}' is not one of ${t.vals.join(' | ')}`, hint: s.hint, fix: s.fix, node: v.node, mod: v.mod };
        }
        return mismatch();
      case 'ref':
        if (v.t === 'ref' && t.kinds.includes(v.obj.kind)) return null;
        if (v.t === 'ref') return { msg: `'${v.obj.path}' is a ${v.obj.kind}, expected a ${t.kinds.join(' or ')}`, node: v.node, mod: v.mod };
        if (v.t === 'word') {
          const ms = v.mod ?? this;
          const names = [...ms.order.filter((o) => t.kinds.includes(o.kind)).map((o) => o.name),
            ...[...ms.imports].flatMap(([al, m]) => m.order.filter((o) => t.kinds.includes(o.kind)).map((o) => `${al}.${o.name}`))];
          const s = ms.suggest(v.v, names, v.node);
          return { code: 'C021', msg: `refers to unknown ${t.kinds.join(' or ')} '${v.v}'`, hint: s.hint, fix: s.fix, node: v.node, mod: v.mod };
        }
        return mismatch();
      case 'attrref':
        return v.t === 'attrref' && t.kinds.includes(v.obj.kind) ? null : mismatch();
      case 'geom': {
        if (v.t === 'ref' && ['layer', 'region'].includes(v.obj.kind)) return null;
        if (v.t === 'word') return { code: 'C021', msg: `refers to unknown layer or region '${v.v}'`, node: v.node, mod: v.mod };
        if (v.t !== 'call' || FUNCTIONS[v.fn]?.kind !== 'geom') return mismatch();
        const sig = FUNCTIONS[v.fn];
        const n = v.args.length, need = sig.args.length;
        if (sig.variadic ? n < need : n !== need) {
          return { code: 'C032', msg: `${v.fn}(...) takes ${sig.variadic ? `at least ${need}` : need} argument${need === 1 ? '' : 's'}, got ${n}`, node: v.node, mod: v.mod };
        }
        for (let i = 0; i < n; i++) {
          const at = sig.args[Math.min(i, need - 1)];
          const p = this.checkType(v.args[i], at);
          if (p) return { ...p, msg: `argument ${i + 1} of ${v.fn}(...) ${p.msg}`, node: p.node ?? v.argNodes?.[i] ?? v.node, mod: p.mod ?? v.mod };
        }
        return null;
      }
      case 'list':
        if (v.t !== 'list') return t.of.k === 'ref' && v.t === 'ref' ? { ...mismatch(`write a list: [${v.obj.name}]`), wrapList: true } : mismatch();
        for (const item of v.items) { const p = this.checkType(item, t.of); if (p) return p; }
        return null;
      case 'pair':
        if (v.t !== 'list' || v.items.length !== 2) return mismatch();
        for (const item of v.items) { const p = this.checkType(item, t.of); if (p) return p; }
        return null;
      case 'range':
        if (v.t !== 'range') return mismatch();
        return this.checkType(v.lo, t.of) ?? this.checkType(v.hi, t.of);
      case 'choice':
        if (v.t !== 'choice') return mismatch();
        for (const item of v.items) { const p = this.checkType(item, t.of); if (p) return p; }
        return null;
      case 'union': {
        const problems = t.of.map((x) => this.checkType(v, x));
        if (problems.some((p) => p === null)) return null;
        const specific = problems.find((p) => p.code === 'C021' || p.code === 'C032' || p.hint);
        if ((v.t === 'word' || v.t === 'call') && specific) return specific;
        const withFix = problems.find((p) => p.addUnit || p.wrapList || p.quote);
        return { ...mismatch(problems.find((p) => p.hint)?.hint), ...(withFix ? { addUnit: withFix.addUnit, wrapList: withFix.wrapList, quote: withFix.quote } : {}) };
      }
      default: return null;
    }
  }

  checkKind(o) {
    const v = (name) => o.mod.value(o, name);
    const at = (name) => o.attrs.get(name);
    const node = (name) => at(name)?.expr ?? o.node.kindNode;
    const errAt = (name, code, msg, hint) => (at(name)?.scope ?? this).err(code, node(name), msg, hint, o);
    const role = (ref) => (ref?.t === 'ref' && ref.obj.kind === 'layer' ? ref.obj.mod.value(ref.obj, 'role')?.v : undefined);
    const idx = (ref) => (ref?.t === 'ref' ? this.s.layerOrder.get(ref.obj) : undefined);

    if (o.kind === 'layer') {
      const r = v('role')?.v;
      if (v('from') && r !== 'marker') (at('from').scope).warn('V015', node('from'), "only marker layers can be computed with 'from'");
      if (v('direction') && r && r !== 'conductor') (at('direction').scope).warn('V016', node('direction'), `'direction' only applies to conductor layers`);
      const tracks = v('tracks');
      if (tracks?.t === 'ref' && tracks.obj.kind === 'array') {
        const fig = tracks.obj.mod.value(tracks.obj, 'of');
        if (fig?.t === 'ref' && fig.obj.mod.value(fig.obj, 'layer')?.obj !== o) errAt('tracks', 'V012', `track array '${tracks.obj.path}' repeats a figure that is not on ${o.path}`);
        const axis = tracks.obj.mod.value(tracks.obj, 'axis')?.v;
        const dir = v('direction')?.v;
        if ((dir === 'horizontal' && axis === 'x') || (dir === 'vertical' && axis === 'y')) {
          errAt('tracks', 'V012', `${dir} tracks repeat along ${dir === 'horizontal' ? 'y' : 'x'}, but '${tracks.obj.path}' uses axis ${axis}`);
        }
      }
    }
    if (o.kind === 'connector') {
      const lowers = v('lower')?.t === 'list' ? v('lower').items : [v('lower')];
      const cut = v('cut');
      const upper = v('upper');
      if (cut?.t === 'ref' && role(cut) && role(cut) !== 'cut') errAt('cut', 'V010', `'${cut.obj.path}' is a ${role(cut)} layer; a connector's cut must be a cut layer`);
      for (const lo of lowers) {
        if (!lo || !upper || idx(lo) === undefined || idx(upper) === undefined) continue;
        if (cut?.t === 'ref' && idx(cut) !== undefined) {
          if (!(idx(lo) < idx(cut) && idx(cut) < idx(upper))) {
            this.err('V010', o.node.nameNode, `${o.path}: cut '${cut.obj.path}' must sit between '${lo.obj.path}' and '${upper.obj.path}' in the stack`,
              'layers are listed bottom to top; use below = / above = to place a layer', o);
          }
        } else if (idx(lo) >= idx(upper)) {
          this.err('V010', o.node.nameNode, `${o.path}: lower '${lo.obj.path}' must be below upper '${upper.obj.path}'`, null, o);
        }
      }
    }
    if (o.kind === 'cross') {
      const gate = v('gate');
      if (gate && role(gate) && role(gate) !== 'conductor') errAt('gate', 'V011', `gate '${gate.obj.path}' must be a conductor layer`);
      let ch = v('channel');
      if (ch?.t === 'ref' && ch.obj.kind === 'array') ch = ch.obj.mod.value(ch.obj, 'of');
      const chLayer = ch?.t === 'ref' ? ch.obj.mod.value(ch.obj, 'layer') : undefined;
      if (chLayer?.t === 'ref' && role(chLayer) && role(chLayer) !== 'channel') errAt('channel', 'V011', `channel '${ch.obj.path}' is on '${chLayer.obj.path}', which is not a channel layer`);
    }
    // Bands, rails, rows, tracks and edge features are checked on the expanded
    // template (checkTemplates / core/template.js).
    if (o.kind === 'tracks' && o.name && !o.attrs.has('layer')) {
      const target = implicitTracksLayer(this.s, o);
      if (target?.kind !== 'layer') {
        const s = this.suggest(o.name, this.s.layerSeq.map((x) => x.rname ?? x.name), o.node.nameNode);
        this.err('C021', o.node.nameNode, `unknown layer '${o.name}'`, s.hint, o, s.fix);
      }
    }
    if (o.kind === 'rule') this.checkRule(o, v, at, node, errAt);
    if (o.kind === 'rule') {
      const kind = v('kind')?.v;
      const want = kind === 'area' ? 2 : kind && !kind.startsWith('x_') && !CONTAINMENT_RULES.has(kind) ? 1 : undefined;
      const vals = [['value', o]].concat([...o.children.values()].filter((c) => c.kind === 'case' || c.kind === 'table').map((c) => [c.kind === 'table' ? 'values' : 'value', c]));
      const badNum = (val) => {
        if (!val) return null;
        if (val.t === 'num') return val.dim !== want ? val : null;
        if (val.t === 'list') { for (const x of val.items) { const b = badNum(x); if (b) return b; } return null; }
        return val;                                   // strings, names, booleans... are never rule values
      };
      for (const [name, holder] of vals) {
        const bad = want !== undefined ? badNum(holder.mod.value(holder, name)) : null;
        if (bad) {
          const ha = holder.attrs.get(name);
          (bad.mod ?? ha.scope).err('V034', bad.node ?? ha.expr, `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} rule takes ${want === 2 ? 'an area (e.g. 288nm * 1nm)' : 'a length'}, not ${describeValue(bad)}`, null, o);
        }
      }
    }
    if (o.kind === 'rail' && v('layer') && role(v('layer')) && role(v('layer')) !== 'conductor') {
      errAt('layer', 'V003', `rail layer '${v('layer').obj.path}' must be a conductor`);
    }
  }

  // Rule structure (VOCABULARY.md section 3): operands, conditions, limits, values.
  checkRule(o, v, at, node, errAt) {
    const kind = v('kind')?.v;
    if (!kind || kind.startsWith('x_')) return;
    const on = v('on');
    const an = (w) => (/^[aeiou]/.test(w) ? `an ${w}` : `a ${w}`);
    const isPair = on?.t === 'list';
    const onConnector = on?.t === 'ref' && on.obj.kind === 'connector';
    const twoOperand = ['enclosure', 'extension', ...CONTAINMENT_RULES];
    const oneOperand = ['width', 'length', 'min_length', 'area', 'eol_spacing', 'cut_spacing'];
    // An `on` that did not evaluate (e.g. an unbound parameter) is reported elsewhere.
    if (!on) { /* nothing to add */ }
    else if (kind === 'cut_spacing' && on.t === 'ref' && on.obj.kind !== 'connector'
      && (on.obj.kind !== 'layer' || on.obj.attrs.has('from') || on.obj.mod.value(on.obj, 'role')?.v !== 'cut')) {
      errAt('on', 'V035', `a cut_spacing rule applies to a drawn cut layer or a connector, not ${on.obj.kind === 'layer' ? `the ${on.obj.mod.value(on.obj, 'role')?.v ?? ''} layer '${on.obj.path}'` : `the ${on.obj.kind} '${on.obj.path}'`}`);
    }
    else if (onConnector && !['cut_spacing', 'enclosure'].includes(kind)) errAt('on', 'V035', `${an(kind)} rule cannot apply to a connector (only cut_spacing and enclosure can)`);
    else if (!onConnector && twoOperand.includes(kind) && !isPair) errAt('on', 'V035', `${an(kind)} rule takes an ordered pair: on = [A, B]`);
    else if (oneOperand.includes(kind) && isPair) errAt('on', 'V035', `${an(kind)} rule takes one layer or region`);
    for (const [cond, kinds] of Object.entries(RULE_CONDITIONS)) {
      if (o.attrs.has(cond) && !kinds.includes(kind)) errAt(cond, 'V035', `'${cond}' has no meaning on ${an(kind)} rule`, `allowed on: ${kinds.join(', ')}`);
    }
    const limit = v('limit')?.v;
    if (CONTAINMENT_RULES.has(kind) && o.attrs.has('limit')) errAt('limit', 'V036', `${an(kind)} rule takes no limit`);
    else if (limit && limit !== 'min' && (PAIR_RULES.has(kind) || kind === 'extension')) errAt('limit', 'V036', `${an(kind)} rule only takes limit = min`);
    if (kind === 'min_length' && limit && limit !== 'min') errAt('limit', 'V036', 'min_length means length with limit = min; use kind = length for other limits');
    if (kind === 'extension' && !o.attrs.has('axis')) this.err('V035', o.node.nameNode, `${o.path}: an extension rule needs an axis`, 'axis = x | y', o);
    const cases = [...o.children.values()].filter((c) => c.kind === 'case');
    const tables = [...o.children.values()].filter((c) => c.kind === 'table');
    const alts = [...o.children.values()].filter((c) => c.kind === 'alternative');
    const forms = [o.attrs.has('value'), tables.length > 0, cases.length > 0].filter(Boolean).length;
    if (CONTAINMENT_RULES.has(kind)) {
      if (forms || alts.length) this.err('V038', o.node.nameNode, `${o.path}: ${an(kind)} rule takes no value, table, case or alternative`, null, o);
    } else if (kind === 'enclosure' && alts.length) {
      if (forms) this.err('V038', o.node.nameNode, `${o.path}: use either value or alternative children, not both`, null, o);
    } else if (forms !== 1) {
      this.err('V038', o.node.nameNode, `${o.path}: ${an(kind)} rule needs exactly one of value, table or case`, null, o);
    }
    if (alts.length && kind !== 'enclosure') this.err('V038', alts[0].node.kindNode, 'alternative children only belong to enclosure rules', null, o);
    for (const a of alts) {
      const m = a.mod.value(a, 'margins');
      if (m?.t === 'list' && m.items.length !== 4) a.attrs.get('margins').scope.err('V038', a.attrs.get('margins').expr, 'margins = [left, right, bottom, top]: four lengths', null, o);
    }
    // Thresholds are never negative (VOCABULARY.md section 3.1).
    const holders = [[o, 'value'], ...['width_below', 'width_above', 'prl', 'within'].map((c) => [o, c]), ...cases.map((c) => [c, 'value']), ...tables.map((t) => [t, 'values']), ...alts.map((x) => [x, 'margins'])];
    const neg = (val) => val && (val.t === 'num' ? val.q.cmp(ZERO) < 0 : val.t === 'list' && val.items.some(neg));
    for (const [h, name] of holders) {
      if (neg(h.mod.value(h, name))) { const ha = h.attrs.get(name); ha.scope.err('V034', ha.expr, 'rule thresholds are not negative', null, o); }
    }
    for (const c of cases) {
      if (!['length', 'min_length'].includes(kind) || !['via_end', 'open_end'].includes(c.name)) {
        this.err('V037', c.node.nameNode ?? c.node.kindNode, `'${c.name}' is not a context of ${kind} rules`, ['length', 'min_length'].includes(kind) ? 'contexts: via_end, open_end' : `${kind} rules have no case contexts`, o);
      }
    }
    for (const t of tables) {
      if (kind !== 'spacing') { this.err('V039', t.node.kindNode, 'tables are only defined for spacing rules', null, o); continue; }
      const idx = (name) => {
        const val = t.mod.value(t, name);
        if (!val) return [ZERO];
        const qs = val.t === 'list' ? val.items.map((x) => (x.t === 'num' ? x.q : null)) : [];
        const ok = qs.length && qs.every(Boolean) && qs[0].isZero() && qs.every((q, i) => i === 0 || q.cmp(qs[i - 1]) > 0);
        if (!ok) t.attrs.get(name).scope.err('V039', t.attrs.get(name).expr, `table ${name} must be a strictly increasing list starting at 0nm`, null, o);
        return qs;
      };
      const rows = idx('width'), cols = idx('prl');
      const vals = t.mod.value(t, 'values');
      const shapeOk = vals?.t === 'list' && vals.items.length === rows.length && vals.items.every((r) => r.t === 'list' && r.items.length === cols.length);
      if (!shapeOk) (t.attrs.get('values')?.scope ?? this).err('V039', t.attrs.get('values')?.expr ?? t.node.kindNode, `table values must be ${rows.length} row(s) of ${cols.length} value(s) (width x prl)`, null, o);
    }
  }
}

// ---- object helpers ----------------------------------------------------------------

function mergeInto(target, src) {
  // A drop in the merged body removes the inherited / existing value first.
  // (Whether it names something is decided by Session.checkDrops.)
  for (const name of src.tomb ?? []) {
    const at = src.tombNodes?.get(name);
    const removed = target.children.get(name);
    const had = target.attrs.delete(name) | target.children.delete(name);
    const prev = target.tomb?.has(name) ? target.tombNodes?.get(name) : undefined;
    (target.tomb ??= new Set()).add(name);
    // so a later base merge can still validate it; a merge that removed a real value proves the drop
    if (at) {
      (target.tombNodes ??= new Map()).set(name, { ...at, scopes: new Set([...droppers(prev), ...droppers(at)]),
        deferred: (prev ? prev.deferred : true) && at.deferred && !had, removed: prev?.removed ?? removed ?? at.removed });
    }
  }
  // A merged `base` must be (re)applied (S2).
  if (src.attrs.has('base')) target.baseState = undefined;
  for (const [k, a] of src.attrs) { target.attrs.set(k, a); target.tomb?.delete(k); target.tombNodes?.delete(k); }
  for (const [k, c] of src.children) {
    const gone = target.tomb?.has(k) ? target.tombNodes?.get(k) : undefined;
    target.tomb?.delete(k); target.tombNodes?.delete(k);
    const prev = target.children.get(k);
    if (prev && prev.kind === c.kind) mergeInto(prev, c);
    else { c.parent = target; c.mod = target.mod; target.children.set(k, c); linkPrior(c, gone?.removed ?? priorChild(target, k), gone ? droppers(gone) : target.priorBy); }
  }
}

let cloneCount = 0;
function cloneObj(o, parent) {
  const c = { ...o, uid: `c${++cloneCount}`, parent, mod: parent.mod, attrs: new Map(), children: new Map(), invalid: false,
    tomb: o.tomb ? new Set(o.tomb) : undefined, tombNodes: o.tombNodes ? new Map(o.tombNodes) : undefined,
    baseState: o.attrs.has('base') ? undefined : o.baseState };
  c.path = `${parent.path}.${o.name ?? o.kind}`;
  for (const [k, a] of o.attrs) c.attrs.set(k, { ...a, state: 'todo', value: undefined });
  for (const [k, ch] of o.children) c.children.set(k, cloneObj(ch, c));
  return c;
}

const RULE_FAMILY = new Set(['rule', 'case', 'table', 'alternative']);
const PARAM_TYPES = new Set(['len', 'number', 'area', 'string', 'bool', 'name', 'any']);
const INFERRED_TYPES = new Set(['len', 'number', 'area', 'string', 'bool', 'name']);

// Type of a value, for typed parameters: len / number / area / string / bool /
// name (an enum word) / an object kind (layer, site, ...) / list / range / ...
function typeName(v) {
  switch (v.t) {
    case 'num': return v.dim === 0 ? 'number' : v.dim === 1 ? 'len' : 'area';
    case 'str': return 'string';
    case 'bool': return 'bool';
    case 'word': return 'name';
    case 'ref': return v.obj.kind;
    case 'dropped': return v.obj?.kind ?? null;          // a dropped object keeps its kind (the cascade handles it)
    case 'module': return 'import alias';
    case 'poison': return null;
    default: return v.t;
  }
}
function article(t) { return /^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`; }

// Record a drop of `name` on `o`. Every module that dropped it is kept (an
// identical drop by another module is the same effect, and the C051 / C052
// decisions need all of them), with the object it removed, so that a patch
// aimed below it can still be checked. Entries are replaced, never mutated:
// clones share them.
function tombstone(o, name, node, scope, had, removed) {
  (o.tomb ??= new Set()).add(name);
  const map = (o.tombNodes ??= new Map());
  const prev = map.get(name);
  if (prev) map.set(name, { ...prev, scopes: new Set([...(prev.scopes ?? [prev.scope]), scope]), deferred: prev.deferred && !had, removed: prev.removed ?? removed });
  else map.set(name, { node, scope, scopes: new Set([scope]), deferred: !had, removed });
}
const droppers = (entry) => [...(entry?.scopes ?? (entry ? [entry.scope] : []))];

// The layer a `tracks M0 { ... }` block names: looked up in the module that wrote
// the block (so inheritance and prefixes keep it), then in the site's module,
// then by resolved name (a patch from a module that reaches it as `fs.M0`).
function implicitTracksLayer(session, o) {
  for (const m of [o.srcMod, o.mod]) { const t = m.lookupPath([o.name]); if (t?.kind === 'layer') return t; }
  const t = [...session.liveObjects()].find((x) => !x.parent && x.rname === o.name);
  return t?.kind === 'layer' ? t : undefined;
}

// Link a child declared again after a drop to the object it replaces, and its
// descendants to the matching descendants of that object, with the modules
// that dropped it (walkPath follows these links for names the replacement
// leaves out).
function linkPrior(c, prior, by) {
  if (!prior || c.prior) return;
  c.prior = prior;
  c.priorBy = by;
  for (const [k, x] of c.children) linkPrior(x, priorChild(c, k), by);    // anywhere along the chain of replaced objects
}
function priorChild(o, seg) {
  for (let p = o.prior; p; p = p.prior) {
    const c = p.children.get(seg) ?? p.tombNodes?.get(seg)?.removed;
    if (c) return c;
  }
  return undefined;
}

// The logical path of an object, stable when a child is dropped and declared again.
function keyOf(o) {
  return o.parent ? `${keyOf(o.parent)}/${o.name ?? '#' + o.kind}` : `m${o.mod.muid}:${o.name ?? '#' + o.kind}`;
}

function topOf(o) { while (o.parent) o = o.parent; return o; }

function setPaths(o, path) {
  o.path = path;
  for (const c of o.children.values()) setPaths(c, `${path}.${c.name ?? c.kind}`);
}

function typeIncludesPair(t) {
  if (t.k === 'pair') return true;
  if (t.k === 'union') return t.of.some(typeIncludesPair);
  return false;
}

function findPoison(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.t === 'poison') return v;
  for (const x of v.items ?? []) { const p = findPoison(x); if (p) return p; }
  for (const x of v.args ?? []) { const p = findPoison(x); if (p) return p; }
  if (v.t === 'range') return findPoison(v.lo) ?? findPoison(v.hi);
  return null;
}

// Structural key of a value, for comparing values from different scopes.
function deepKey(v) {
  if (!v || typeof v !== 'object') return String(v);
  switch (v.t) {
    case 'list': return `[${v.items.map(deepKey).join(',')}]`;
    case 'choice': return `one_of(${v.items.map(deepKey).join(',')})`;
    case 'range': return `${deepKey(v.lo)}..${deepKey(v.hi)}`;
    case 'call': return `${v.fn}(${v.args.map(deepKey).join(',')})`;
    case 'attrref': return `a:${v.obj.uid}.${v.attr}`;
    case 'module': return `m:${v.mod.muid}`;
    default: return valueKey(v);
  }
}

function valueKey(v) {
  switch (v.t) {
    case 'num': return `n${v.dim}:${v.q}`;
    case 'word': return `w:${v.v}`;
    case 'str': return `s:${v.v}`;
    case 'bool': return `b:${v.v}`;
    case 'ref': return `r:${v.obj.uid}`;
    default: return `${v.t}`;
  }
}

// ---- formatting --------------------------------------------------------------------

function encQ(q) { return q.isInt() ? Number(q.n) : `${q.n}/${q.d}`; }

export function fmtLen(q) {
  const n = q.toNumber();
  return `${Number.isInteger(n) ? n : +n.toFixed(4)}nm`;
}
function fmtArea(q) {
  const n = q.toNumber();
  return `${Number.isInteger(n) ? n : +n.toFixed(4)}nm^2`;
}

function dimName(dim) { return dim === 0 ? 'a number' : dim === 1 ? 'a length' : 'an area'; }

function describeValue(v) {
  switch (v.t) {
    case 'num': return v.dim === 0 ? `the number ${fmtNum(v.q)}` : v.dim === 1 ? `the length ${fmtLen(v.q)}` : `the area ${fmtArea(v.q)}`;
    case 'word': return `'${v.v}'`;
    case 'str': return 'a string';
    case 'bool': return v.v ? 'true' : 'false';
    case 'ref': return `the ${v.obj.kind} '${v.obj.path}'`;
    case 'attrref': return `${v.obj.path}.${v.attr}`;
    case 'module': return `the module '${v.mod.label()}'`;
    case 'list': return `a list of ${v.items.length}`;
    case 'range': return 'a range';
    case 'choice': return 'one_of(...)';
    case 'call': return `${v.fn}(...)`;
    case 'dropped': return `the dropped object '${v.obj.path}'`;
    default: return v.t;
  }
}

function fmtNum(q) { const n = q.toNumber(); return Number.isInteger(n) ? `${n}` : `${+n.toFixed(4)}`; }

export function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineCol(starts, offset, lk, ck) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { [lk]: lo + 1, [ck]: offset - starts[lo] + 1 };
}

export { enumWords, refKinds };
