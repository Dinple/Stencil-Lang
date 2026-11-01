// Resolver regression tests, set 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject } from '../core/resolve.js';

const H = 'stencil 0.1\n';
const T = H + 'technology { grid = 1nm }\n';
const project = (files, main = 'main.stencil') => resolveProject({ main, load: (p) => files[p] ?? null });
const errors = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errors(r).map((d) => d.code);
const obj = (r, name) => r.resolved.objects.find((o) => o.name === name);
const child = (r, o, c) => obj(r, o).children.find((x) => x.name === c);

test('S1: a sibling drop competing with a sibling assignment is C052, in both orders', () => {
  const files = {
    'common.stencil': H + 'layer L { role = conductor; masks = 1 }',
    'left.stencil': H + 'import "common" as c\n&c.L { drop masks }',
    'right.stencil': H + 'import "common" as c\n&c.L { masks = 2 }',
  };
  for (const order of ['import "left" as a\nimport "right" as b', 'import "right" as b\nimport "left" as a']) {
    const r = project({ ...files, 'main.stencil': T + order });
    assert.ok(codes(r).includes('C052'), order);
    assert.equal(r.resolved.complete, false);
  }
});

test('S2: a base merged into an inherited child is applied, in any declaration order', () => {
  const A = 'site A {\n  width = 1nm; height = 100nm\n  rail R { layer = L; edge = bottom }\n  rail Q { layer = L; edge = top; width = 9nm; net = "VDD" }\n}\n';
  const B = 'site B {\n  base = A\n  rail R { base = A.Q }\n}\n';
  for (const body of [A + B, B + A]) {
    const r = project({ 'main.stencil': T + 'layer L { role = conductor }\n' + body });
    assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
    assert.equal(child(r, 'B', 'R').attrs.width, 9);
    assert.equal(child(r, 'B', 'R').attrs.base, undefined);
  }
});

test('S3: specialising a clone does not erase the source object\'s drop', () => {
  const C = 'site C {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; width = 5nm }\n}\n';
  const B = 'site B {\n  base = A\n  rail R { width = 9nm }\n}\n';
  const A = 'site A {\n  width = 1nm; height = 1nm\n  rail R { base = C.R; drop width }\n}\n';
  for (const body of [C + B + A, C + A + B]) {
    const r = project({ 'main.stencil': T + 'layer L { role = conductor }\n' + body });
    assert.equal(child(r, 'A', 'R').attrs.width, undefined, body);
    assert.equal(child(r, 'B', 'R').attrs.width, 9);
  }
});

test('S4: a qualified child drop survives inheritance', () => {
  const r = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite A {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = bottom }\n}\nsite B {\n  base = A\n  rail R { edge = top }\n}\ndrop B.R' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.deepEqual(obj(r, 'B').children, []);
});

test('F1: GDS shifts are checked on the final value only', () => {
  const r = project({
    'main.stencil': T + 'import "lib" as m { gds { shift = -2 } }',
    'lib.stencil': H + 'layer L { role = conductor; gds = [9007199254740993, 0] }',
  });
  assert.deepEqual(obj(r, 'L').attrs.gds, [9007199254740991, 0]);
  assert.deepEqual(codes(r), []);
});

test('F2: two placements on one layer are rejected even when nothing would move', () => {
  const r = project({ 'main.stencil': T + 'layer A { role = conductor }\nlayer B { role = conductor; above = A; below = C }\nlayer C { role = conductor }' });
  assert.ok(codes(r).includes('V031'));
});

test('F3: dropping a nonexistent attribute in a nested patch is C050', () => {
  const r = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite A {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = bottom }\n}\nsite B {\n  base = A\n  rail R { edge = top }\n}\n&B { rail R { drop widht } }' });
  assert.ok(codes(r).includes('C050'), JSON.stringify(r.diags));
});
