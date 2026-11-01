// Regressions for the M1 review, round 4 .
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject } from '../core/resolve.js';
import { checkProfile } from '../core/profile.js';

const H = 'stencil 0.1\n';
const T = H + 'technology { grid = 1nm }\n';
const project = (files, main = 'main.stencil') => resolveProject({ main, load: (p) => files[p] ?? null });
const errors = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errors(r).map((d) => d.code);
const obj = (r, name) => r.resolved.objects.find((o) => o.name === name);

test('B1: one sibling drops a child, another restores or modifies it: C052 in both orders', () => {
  const files = {
    'common.stencil': H + 'layer L { role = conductor }\nsite S {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top }\n}',
    'left.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'right.stencil': H + 'import "common" as c\n&c.S { rail R { layer = c.L; edge = bottom } }',
  };
  for (const order of ['import "left" as a\nimport "right" as b', 'import "right" as b\nimport "left" as a']) {
    const r = project({ ...files, 'main.stencil': T + order });
    assert.ok(codes(r).includes('C052'), `${order}: ${JSON.stringify(r.diags)}`);
    assert.equal(r.resolved.complete, false);
  }
  // Two siblings that both modify the child consistently are fine.
  const ok = project({ ...files, 'left.stencil': files['right.stencil'], 'main.stencil': T + 'import "left" as a\nimport "right" as b' });
  assert.ok(!codes(ok).includes('C052'), JSON.stringify(ok.diags));
});

test('F1: a nested drop typo is reported even when the child inherits through base', () => {
  const r = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite A {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top }\n}\nsite B {\n  width = 1nm; height = 1nm\n  rail R { base = A.R }\n}\n&B { rail R { drop widht } }' });
  assert.ok(codes(r).includes('C050'), JSON.stringify(r.diags));
  // and a correct deferred drop of an inherited attribute is fine
  const ok = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite A {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; width = 4nm }\n}\nsite B {\n  width = 1nm; height = 1nm\n  rail R { base = A.R }\n}\n&B { rail R { drop width } }' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
  assert.equal(obj(ok, 'B').children[0].attrs.width, undefined);
});

test('F2: layers are emitted in physical order', () => {
  const r = project({ 'main.stencil': T + 'layer A { role = conductor }\nlayer C { role = conductor }\nlayer B { role = conductor; level_with = A }' });
  const orders = r.resolved.objects.filter((o) => o.kind === 'layer').map((o) => o.attrs.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test('F3/F4: profile scope covers every site and rules on derived regions', () => {
  const r = project({ 'main.stencil': T + 'layer A { role = conductor; pitch = 10nm }\nlayer B { role = conductor }\nsite S1 { width = 1nm; height = 1nm; pins = [A] }\nsite S2 { width = 1nm; height = 1nm; pins = [B] }\nregion RG { from = grow(A, 1nm) }\nrule AR { kind = area; on = RG; value = 1nm * 1nm }\nprofile P { needs_tracks = true; rule_kinds = [width] }' });
  const f = checkProfile(r.resolved, obj(r, 'P'));
  assert.ok(f.some((x) => x.object === 'B'), JSON.stringify(f));
  assert.ok(f.some((x) => /area/.test(x.message)), JSON.stringify(f));
});
