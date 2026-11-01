// Regressions for the M1 review .
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject } from '../core/resolve.js';

const H = 'stencil 0.1\n';
const project = (files, main = 'main.stencil') => resolveProject({ main, load: (p) => files[p] ?? null });
const errors = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errors(r).map((d) => d.code);
const obj = (r, name) => r.resolved.objects.find((o) => o.name === name);

test('F1: conflicting sibling patches are C052, in either import order', () => {
  const files = {
    'left.stencil': H + 'import "common" as c\n&c.L { width = 2nm }',
    'right.stencil': H + 'import "common" as c\n&c.L { width = 3nm }',
    'common.stencil': H + 'layer L { role = conductor; width = 1nm }',
  };
  for (const order of ['import "left" as a\nimport "right" as b', 'import "right" as b\nimport "left" as a']) {
    const r = project({ ...files, 'main.stencil': H + 'technology { grid = 1nm }\n' + order });
    assert.ok(codes(r).includes('C052'), order);
    assert.equal(r.resolved.complete, false);
  }
  // Identical patches from siblings are not a conflict.
  const same = project({ ...files, 'right.stencil': files['left.stencil'], 'main.stencil': H + 'technology { grid = 1nm }\nimport "left" as a\nimport "right" as b' });
  assert.ok(!codes(same).includes('C052'));
});

test('F2: cascades reach numeric dependencies and checks', () => {
  const r = project({ 'main.stencil': H + [
    'technology { grid = 1nm }',
    'layer A { role = conductor }',
    'figure F { layer = A; width = 10nm }',
    'layer B { role = conductor; width = F.width }',
    'check C { holds = F.width >= 1nm }',
    'drop A',
  ].join('\n') });
  assert.ok(errors(r).some((d) => d.code === 'C051' && /B\.width/.test(d.message)), JSON.stringify(r.diags));
  assert.ok(r.diags.some((d) => d.code === 'W040' && /'C'/.test(d.message)), JSON.stringify(r.diags));
  assert.equal(r.resolved.complete, false);
});

test('F3: two instances of one module are different objects', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "lib" as a { rename { prefix = "A_" } }\nimport "lib" as b { rename { prefix = "B_" } }\ncheck SAME { holds = a.L == b.L }',
    'lib.stencil': H + 'layer L { role = conductor }',
  });
  assert.ok(errors(r).some((d) => d.code === 'V100' && /SAME/.test(d.message)), JSON.stringify(r.diags));
});

test('F4: placement guarantees are relative order (SPEC 3.9); impossible ones are V031', () => {
  const ok = project({ 'main.stencil': H + 'technology { grid = 1nm }\nlayer A { role = conductor; below = C }\nlayer B { role = conductor; below = C }\nlayer C { role = conductor }' });
  assert.deepEqual(codes(ok), []);
  const ord = (n) => obj(ok, n).attrs.order;
  assert.ok(ord('A') < ord('C') && ord('B') < ord('C'));
  const bad = project({ 'main.stencil': H + 'technology { grid = 1nm }\nlayer A { role = conductor; below = B }\nlayer B { role = conductor; below = A }' });
  assert.ok(codes(bad).includes('V031'));
});

test('F5: dropping an inherited attribute does not resurrect it', () => {
  const r = project({ 'main.stencil': H + 'technology { grid = 1nm }\nlayer A { role = conductor; masks = 2 }\nlayer B { base = A; masks = 3 }\n&B { drop masks }' });
  assert.deepEqual(codes(r), []);
  assert.equal(obj(r, 'B').attrs.masks, 1);
  const r2 = project({ 'main.stencil': H + 'technology { grid = 1nm }\nlayer A { role = conductor; masks = 2 }\nlayer B { base = A }\n&B { drop masks }' });
  assert.deepEqual(codes(r2), [], JSON.stringify(r2.diags));
  assert.equal(obj(r2, 'B').attrs.masks, 1);
  const r3 = project({ 'main.stencil': H + 'technology { grid = 1nm }\nlayer A { role = conductor; masks = 2 }\nlayer B { base = A }\n&B { drop masks }\n&B { masks = 4 }' });
  assert.equal(obj(r3, 'B').attrs.masks, 4);
});

test('F6: an array axis given through a parameter still gets the z scale', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "lib" as m { scale { xy = 2; z = 3 } }',
    'lib.stencil': H + 'AX = z\nlayer L { role = conductor }\nfigure F { layer = L; width = 1nm }\narray ZS { of = F; axis = AX; count = 2; pitch = 10nm }',
  });
  assert.equal(obj(r, 'ZS').attrs.pitch, 30);
});

test('F7: large integers stay exact or are reported', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "lib" as m { gds { shift = 9007199254740992 } }\nlayer X { role = conductor; masks = 9007199254740993 }',
    'lib.stencil': H + 'layer L { role = conductor; gds = [1, 0] }',
  });
  assert.equal(obj(r, 'L').attrs.gds[0], '9007199254740993');
  assert.equal(obj(r, 'X').attrs.masks, '9007199254740993');
  assert.ok(codes(r).filter((c) => c === 'C071').length >= 2, JSON.stringify(r.diags));
  assert.equal(r.resolved.complete, false);
});

test('F8: table cells are checked against the rule kind', () => {
  const r = project({ 'main.stencil': H + 'technology { grid = 1nm }\nlayer L { role = conductor }\nrule R {\n  kind = area\n  on = L\n  table { width = [1nm]; values = [[2nm]] }\n}' });
  assert.ok(codes(r).includes('V034'), JSON.stringify(r.diags));
});

test('F9: a type error in a referenced object does not crash validation', () => {
  const r = project({ 'main.stencil': H + 'technology { grid = 1nm }\nlayer L { role = channel }\nstratum S { layers = [L]; polarity = n }\nsite CORE {\n  width = 1nm\n  height = 1nm\n  band n { stratum = S; y = 0nm..1nm }\n}' });
  assert.ok(codes(r).includes('V003'));
  assert.equal(r.resolved.complete, false);
});

test('F10: children added by an importer patch point at the importer file', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "lib" as m\n&m.S {\n  rail VDD { layer = m.L }\n}',
    'lib.stencil': H + 'layer L { role = conductor }\nsite S { width = 1nm; height = 1nm }',
  });
  const d = errors(r).find((x) => x.code === 'V004');
  assert.equal(d.file, 'main.stencil');
  assert.equal(d.line, 5);
  const rail = obj(r, 'S').children.find((c) => c.name === 'VDD');
  assert.match(rail.src, /^main\.stencil:5:/);
});
