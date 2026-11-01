// JavaScript-specific behaviour of the query API (the shared semantics are in
// query_cases.json): object keys, exact integers, hashes, input forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Technology, UnresolvedRuleError, ResolveError, StencilError, AmbiguousError } from '../core/query.js';
import { hashResolved } from '../core/canon.js';
import { Q } from '../core/rational.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../python/tests/data/examples/${name}.json`, import.meta.url), 'utf8'));
const qr = Technology.fromResolved(fixture('query_rules'));

test('size and option names never reach Object.prototype', () => {
  const fet = qr.device('FET');
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => fet.wEff({ nfin: 2, [k]: 7 }), RangeError, k);
    assert.throws(() => qr.minSpacing('M1', { [k]: 1 }), TypeError, k);
  }
  assert.throws(() => fet.wEff(JSON.parse('{"__proto__": 1, "nfin": 2}')), RangeError);
  assert.throws(() => qr.ruleValue('width', 'M1', { limit: 'toString' }), RangeError);
  assert.throws(() => qr.ruleValue('width', 'M1', { limit: '__proto__' }), RangeError);
  // a size parameter named like a prototype property
  const r = fixture('query_rules').resolved;
  const objects = r.objects.map((o) => (o.name === 'FET' ? { ...o, children: o.children.map((c) => (c.kind === 'size' ? { ...c, name: 'constructor' } : c)) } : o));
  const fet2 = Technology.fromResolved({ ...r, objects }).device('FET');
  assert.equal(fet2.wEff({ constructor: 2 }).toString(), '198');
  assert.throws(() => fet2.wEff({}), RangeError);
});

test('database units stay exact or fail', () => {
  assert.throws(() => qr.dbu('9007199254740993'), RangeError);
  assert.equal(qr.dbu('4503599627370495.5'), 9007199254740991);
  assert.throws(() => qr.nm(2 ** 60), RangeError);
});

test('every construction route has the canonical hash', async () => {
  const src = readFileSync(new URL('../python/tests/data/src/query_rules.stencil', import.meta.url), 'utf8');
  const t = Technology.fromSource(src);
  assert.equal(t.hash, await hashResolved(t.resolved));
  assert.equal(t.hash, qr.hash);
  const { hash, ...bare } = fixture('query_rules').resolved;
  assert.equal(Technology.fromResolved(bare).hash, hash);
});

test('null options mean "not given"; JS numbers read as their shortest decimal', () => {
  assert.equal(qr.minWidth('M1', { axis: 'y', width: null, scopes: undefined }).value.toString(), '10');
  assert.deepEqual(qr.routingLayers(null).map((l) => l.name), ['M1']);
  // the approved float policy: 0.3 is read as 3/10 (Python reads the binary value)
  const fine = Technology.fromResolved({ ...fixture('level0_routing').resolved, grid_nm: '1/10' });
  assert.equal(fine.dbu(0.3), 3);
  assert.equal(fine.dbu('0.3'), 3);
});

test('options are validated', () => {
  assert.throws(() => qr.layers({ rol: 'conductor' }), TypeError);
  assert.throws(() => qr.minSpacing('M1', { sameNet: 0 }), TypeError);
  assert.throws(() => qr.minSpacing('M1', { scopes: 'HOT' }), TypeError);
  assert.throws(() => qr.site('CORE', { units: 2.5 }), RangeError);
  assert.throws(() => qr.device('FET').selectModel('n', 'LVT'), TypeError);
  assert.throws(() => qr.minSpacing('M1'), UnresolvedRuleError);
});

test('lone surrogates hash like Python', async () => {
  const r = { objects: [{ kind: 'layer', name: 'A', attrs: { note: '\ud800' }, children: [] }] };
  const h = 'sha256:ff0ad75012558349781af20e6f656d8b0323d03a207df41035426e04aa835975';   // python/tests/test_api.py checks the same value
  assert.equal(Technology.fromResolved(r).hash, h);
  assert.equal(await hashResolved(r), h);
});

test('integers beyond 2^53 are refused', () => {
  const r = fixture('query_rules').resolved;
  assert.throws(() => Technology.fromResolved({ ...r, objects: [...r.objects, { kind: 'layer', name: 'Z', attrs: { order: 2 ** 53 } }] }), /2\^53/);
});

test('constructor options', () => {
  const r = fixture('invalid_rule').resolved;
  assert.equal(Technology.fromResolved(r, { allowIncomplete: true }).complete, false);
  assert.equal(new Technology(r, { diagnostics: null, allowIncomplete: true }).complete, false);
  for (const bad of [[], 0, 'yes']) assert.throws(() => Technology.fromResolved(r, { allowIncomplete: bad }), TypeError);
  assert.throws(() => Technology.fromResolved(r, { allowIncomplete: null }), ResolveError);
  assert.throws(() => new Technology(r, { diagnostics: {}, allowIncomplete: true }), TypeError);
});

test('Size.contains uses the number grammar', () => {
  const w = qr.layer('M1').width;                        // a range, 10 .. 40 nm
  assert.ok(w.contains('12.5') && w.contains(20) && !w.contains('41'));
  assert.throws(() => w.contains(true), TypeError);
  assert.throws(() => w.contains(null), TypeError);
  assert.throws(() => w.contains('+1'), RangeError);
  assert.throws(() => w.contains('1/0'), RangeError);
});

test('native Maps are not collections of shapes or names', () => {
  for (const m of [new Map(), new Map([['M1', [0, 0, 1, 1]]])]) {
    assert.throws(() => qr.check(m), TypeError);
    assert.throws(() => qr.recognize(m), TypeError);
    assert.throws(() => qr.minSpacing('M1', { width: 20, prl: 60, sameNet: false, sameColor: false, scopes: m }), TypeError);
    assert.throws(() => qr.minSpacing('M1', { width: 20, prl: 60, sameNet: false, sameColor: false, ignore: m }), TypeError);
  }
  assert.equal(qr.minSpacing('M1', { width: 20, prl: 60, sameNet: false, sameColor: false, ignore: new Set(['M1_SN']) }).value.toString(), '18');
  assert.throws(() => qr.device('FET').selectModel('n', new Map()), TypeError);
  assert.equal(qr.device('FET').selectModel('n', new Set(['LVT'])).name, 'nch_lvt');
  assert.equal(qr.check(new Set()).complete, false);         // other iterables remain collections
});

test('rejections keep their error class for values that cannot be printed', () => {
  const bad = JSON.parse('{"toString":0}');
  for (const v of [bad, [bad], 10n]) {
    assert.throws(() => new Technology({ objects: [], complete: false }, { diagnostics: [{ severity: 'error', message: v, file: v, line: v }] }), ResolveError);
    assert.throws(() => Technology.fromResolved({ ...fixture('level0_routing').resolved, grid_nm: v }), StencilError);
    assert.throws(() => qr.device('FET').selectModel(v), AmbiguousError);
    assert.throws(() => qr.minSpacing('M1', { sameNet: v }), TypeError);
    assert.throws(() => qr.rules({ on: v }), TypeError);
    assert.throws(() => qr.ruleValue([v], 'M1'), TypeError);
  }
});

test('rejections keep their error class for numbers that cannot be printed', () => {
  const badQ = Object.assign(new Q(1n, 2n), { toString: 0 });
  const grid1 = Technology.fromResolved(fixture('query_more'));                       // a 1 nm grid
  assert.throws(() => grid1.dbu(badQ), RangeError);
  assert.throws(() => grid1.dbu(Object.assign(new Q(2n ** 60n), { toString: 0 })), RangeError);
  assert.throws(() => grid1.nm(JSON.parse('{"toString":0}')), TypeError);
  assert.throws(() => qr.device('FET').wEff({ nfin: badQ }), RangeError);
  assert.throws(() => qr.device('FET').wEff({ nfin: Object.assign(new Q(9n), { toString: 0 }) }), RangeError);
  // an enclosure rule with a limit that cannot be printed
  const r = structuredClone(fixture('query_rules').resolved);
  r.objects.find((o) => o.name === 'V1_M1X').attrs.limit = JSON.parse('{"toString":0}');
  assert.throws(() => Technology.fromResolved(r).enclosure('V1', 'M1', { width: 20 }), StencilError);
});

test('wEff: omitted, undefined, null and empty sizes are alike', () => {
  const t = Technology.fromSource('stencil 0.1\ntechnology { grid = 1nm }\nlayer CH { role = channel }\nlayer G { role = conductor }\n'
    + 'figure F { layer = CH; width = 10nm; thickness = 2nm }\ncross D { gate = G; channel = F; faces = all }\n');
  const d = t.device('D');
  for (const call of [() => d.wEff(), () => d.wEff(undefined), () => d.wEff(null), () => d.wEff({})]) assert.equal(call().toString(), '24');
  const fet = qr.device('FET');                                     // a fin count that is not fixed: each form needs it
  for (const call of [() => fet.wEff(), () => fet.wEff(undefined), () => fet.wEff(null), () => fet.wEff({})]) assert.throws(call, RangeError);
  assert.throws(() => d.wEff([]), TypeError);
  const dw = Technology.fromSource('stencil 0.1\ntechnology { grid = 1nm }\nlayer CH { role = channel }\nlayer G { role = conductor }\n'
    + 'figure F { layer = CH; width = 10nm; thickness = 2nm }\ncross D { gate = G; channel = F; faces = all\n  size w { sets = F.width } }\n').device('D');
  for (const v of [null, undefined]) assert.equal(dw.wEff({ w: v }).toString(), '24');
  for (const v of [null, undefined]) assert.throws(() => fet.wEff({ nfin: v }), RangeError);
});

test('records are frozen', () => {
  const v = qr.minArea('M1');
  assert.ok(Object.isFrozen(v) && Object.isFrozen(qr.device('FET')) && Object.isFrozen(qr.device('FET').sizes));
  assert.ok(Object.isFrozen(qr.rules({ kind: 'spacing' })[0].attrs));
});
