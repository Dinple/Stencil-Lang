// Regressions for the M1 review, round 2 .
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject } from '../core/resolve.js';

const H = 'stencil 0.1\n';
const T = H + 'technology { grid = 1nm }\n';
const project = (files, main = 'main.stencil') => resolveProject({ main, load: (p) => files[p] ?? null });
const errors = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errors(r).map((d) => d.code);
const all = (r) => r.diags.map((d) => d.code);
const obj = (r, name) => r.resolved.objects.find((o) => o.name === name);
const orders = (a, b) => [`${a}\n${b}`, `${b}\n${a}`];

test('R1: same patch text, different values in different scopes, is C052 in both orders', () => {
  const files = {
    'left.stencil': H + 'W = 2nm\nimport "common" as c\n&c.L { width = W }',
    'right.stencil': H + 'W = 3nm\nimport "common" as c\n&c.L { width = W }',
    'common.stencil': H + 'layer L { role = conductor; width = 1nm }',
  };
  for (const o of orders('import "left" as a', 'import "right" as b')) {
    const r = project({ ...files, 'main.stencil': T + o });
    assert.ok(codes(r).includes('C052'), o);
    assert.equal(r.resolved.complete, false);
  }
  // Same value through different text is not a conflict.
  const same = project({ ...files, 'right.stencil': H + 'import "common" as c\n&c.L { width = 1nm + 1nm }', 'main.stencil': T + 'import "left" as a\nimport "right" as b' });
  assert.ok(!codes(same).includes('C052'), JSON.stringify(same.diags));
});

test('R2: a shared file under different import options is a different instance, in either order', () => {
  const files = {
    'left.stencil': H + 'import "common" as c',
    'right.stencil': H + 'import "common" as c',
    'common.stencil': H + 'layer L { role = conductor; width = 1nm; gds = [1, 0] }',
  };
  const A = 'import "left" as a { rename { prefix = "A_" }; scale { xy = 2 }; gds { shift = 100 } }';
  const B = 'import "right" as b { rename { prefix = "B_" }; scale { xy = 3 }; gds { shift = 200 } }';
  for (const o of orders(A, B)) {
    const r = project({ ...files, 'main.stencil': T + o + '\ncheck DIFF { holds = a.c.L != b.c.L }' });
    assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
    assert.equal(obj(r, 'A_L').attrs.width, 2);
    assert.deepEqual(obj(r, 'A_L').attrs.gds, [101, 0]);
    assert.equal(obj(r, 'B_L').attrs.width, 3);
    assert.deepEqual(obj(r, 'B_L').attrs.gds, [201, 0]);
  }
  // Without options the file is still shared (diamond).
  const shared = project({ ...files, 'main.stencil': T + 'import "left" as a\nimport "right" as b\ncheck SAME { holds = a.c.L == b.c.L }' });
  assert.deepEqual(codes(shared), []);
  assert.equal(shared.resolved.objects.filter((o) => o.name === 'L').length, 1);
});

test('R3: dependencies on a cascaded child and on compared references are followed', () => {
  const r = project({ 'main.stencil': T + [
    'layer A { role = conductor }',
    'site S {\n  width = 1nm\n  height = 1nm\n  rail R { layer = A; edge = top; width = 10nm }\n}',
    'layer B { role = conductor; width = S.R.width }',
    'check C { holds = S.R.width >= 1nm }',
    'drop A',
  ].join('\n') });
  assert.ok(errors(r).some((d) => d.code === 'C051' && /B\.width/.test(d.message)), JSON.stringify(r.diags));
  assert.ok(all(r).includes('W040'));
  assert.equal(r.resolved.complete, false);
  const r2 = project({ 'main.stencil': T + 'layer A { role = conductor }\nfigure F { layer = A; width = 10nm }\ncheck C { holds = F == F }\ndrop A' });
  assert.ok(all(r2).includes('W040'), JSON.stringify(r2.diags));
});

test('R4: cascades reach their fixed point at any depth', () => {
  const body = ['layer L { role = marker }', ...Array.from({ length: 150 }, (_, i) => `region R${i} { from = ${i === 149 ? 'L' : `R${i + 1}`} }`), 'drop L'].join('\n');
  const r = project({ 'main.stencil': T + body });
  assert.equal(r.resolved.objects.filter((o) => o.kind === 'region').length, 0);
  assert.deepEqual(codes(r), []);
});

test('R5: drops inside merged children and re-declaration after a drop', () => {
  const A = 'layer L { role = conductor }\nsite A {\n  width = 1nm\n  height = 1nm\n  rail R { layer = L; edge = bottom }\n}\n';
  const r1 = project({ 'main.stencil': T + A + 'site B {\n  base = A\n  rail R { edge = top; drop edge }\n}' });
  assert.ok(codes(r1).includes('V004'), JSON.stringify(r1.diags));
  const r2 = project({ 'main.stencil': T + A + 'site B {\n  base = A\n  drop R\n  rail R { layer = L; edge = top }\n}' });
  assert.deepEqual(codes(r2), [], JSON.stringify(r2.diags));
  assert.equal(obj(r2, 'B').children.find((c) => c.name === 'R').attrs.edge, 'top');
  const r3 = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite S { width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; width = 5nm } }\n&S { rail R { drop width } }' });
  assert.deepEqual(codes(r3), [], JSON.stringify(r3.diags));
  assert.equal(obj(r3, 'S').children[0].attrs.width, undefined);
});

test('R6: base works on nested objects', () => {
  const r = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite A {\n  width = 1nm\n  height = 1nm\n  rail R { layer = L; edge = top }\n}\nsite B {\n  width = 1nm\n  height = 1nm\n  rail R { base = A.R }\n}' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.deepEqual(obj(r, 'B').children[0].attrs, { layer: { ref: 'L' }, edge: 'top' });
});

test('R7: grid and shifted GDS numbers are exact', () => {
  const g = project({ 'main.stencil': H + 'technology { grid = 9007199254740993nm }' });
  assert.equal(g.resolved.grid_nm, '9007199254740993');
  assert.ok(codes(g).includes('C071'));
  const s = project({
    'main.stencil': T + 'import "lib" as m { gds { shift = 1 } }',
    'lib.stencil': H + 'layer L { role = conductor; gds = [9007199254740993, 0] }',
  });
  assert.deepEqual(obj(s, 'L').attrs.gds, ['9007199254740994', 0]);
  assert.equal(s.resolved.complete, false);
});

test('R8: non-numeric table cells are rejected', () => {
  const r = project({ 'main.stencil': T + 'layer L { role = conductor }\nrule R {\n  kind = area\n  on = L\n  table { width = [1nm]; values = [["oops"]] }\n}' });
  assert.ok(codes(r).includes('V034'), JSON.stringify(r.diags));
  assert.equal(r.resolved.complete, false);
});

test('R9: satisfiable placement chains are accepted; cycles are V031', () => {
  const r = project({ 'main.stencil': T + 'layer A { role = conductor; above = B }\nlayer B { role = conductor; above = C }\nlayer C { role = conductor }' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  const o = (n) => obj(r, n).attrs.order;
  assert.ok(o('C') < o('B') && o('B') < o('A'));
  const cyc = project({ 'main.stencil': T + 'layer A { role = conductor; above = B }\nlayer B { role = conductor; above = A }' });
  assert.ok(codes(cyc).includes('V031'));
});

test('level_with holds even when no placement pass is needed', () => {
  const r = project({ 'main.stencil': T + 'layer GATE { role = conductor }\nlayer MD { role = conductor; level_with = GATE }\nlayer M0 { role = conductor }' });
  assert.deepEqual(codes(r), []);
  assert.equal(obj(r, 'MD').attrs.order, obj(r, 'GATE').attrs.order);
  assert.ok(obj(r, 'M0').attrs.order > obj(r, 'MD').attrs.order);
});
