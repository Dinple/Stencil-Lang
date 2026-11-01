// Resolver regression tests, set 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject } from '../core/resolve.js';

const H = 'stencil 0.1\n';
const T = H + 'technology { grid = 1nm }\n';
const project = (files, main = 'main.stencil') => resolveProject({ main, load: (p) => files[p] ?? null });
const codes = (r) => r.diags.filter((d) => d.severity === 'error').map((d) => d.code);
const orders = ['import "left" as a\nimport "right" as b', 'import "right" as b\nimport "left" as a'];

test('1: a direct child patch against a sibling drop of that child is C052 in both orders', () => {
  const files = {
    'common.stencil': H + 'layer L { role = conductor }\nsite S {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top }\n}',
    'left.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'right.stencil': H + 'import "common" as c\n&c.S.R { edge = bottom }',
  };
  for (const o of orders) {
    const r = project({ ...files, 'main.stencil': T + o });
    assert.ok(codes(r).includes('C052'), `${o}: ${JSON.stringify(r.diags)}`);
    assert.equal(r.resolved.complete, false);
  }
});

test('2: sibling declarations of different kinds under one child name are C052', () => {
  const files = {
    'common.stencil': H + 'layer L { role = conductor }\nsite S { width = 1nm; height = 1nm }',
    'left.stencil': H + 'import "common" as c\n&c.S { rail L { layer = c.L; edge = top } }',
    'right.stencil': H + 'import "common" as c\n&c.S { tracks L { use = [1] } }',
  };
  for (const o of orders) {
    const r = project({ ...files, 'main.stencil': T + o });
    assert.ok(codes(r).includes('C052'), `${o}: ${JSON.stringify(r.diags)}`);
  }
});

test('3: a qualified drop typo is reported once base is applied', () => {
  const r = project({ 'main.stencil': T + 'layer A { role = conductor }\nlayer B { base = A }\ndrop B.widht' });
  assert.ok(codes(r).includes('C050'), JSON.stringify(r.diags));
  const ok = project({ 'main.stencil': T + 'layer A { role = conductor; masks = 2 }\nlayer B { base = A }\ndrop B.masks' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
  assert.equal(ok.resolved.objects.find((o) => o.name === 'B').attrs.masks, 1);
});
