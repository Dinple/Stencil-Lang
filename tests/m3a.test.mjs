// M3a: qualified-drop conflict policy and typed module parameters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject } from '../core/resolve.js';

const H = 'stencil 0.1\n';
const T = H + 'technology { grid = 1nm }\n';
const project = (files, main = 'main.stencil') => resolveProject({ main, load: (p) => files[p] ?? null });
const errors = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errors(r).map((d) => d.code);
const obj = (r, name) => r.resolved.objects.find((o) => o.name === name);
const orders = ['import "left" as a\nimport "right" as b', 'import "right" as b\nimport "left" as a'];
const COMMON = H + 'layer L { role = conductor; masks = 1 }\nsite S {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top }\n}';

test('a qualified drop conflicts with a sibling patch of the same object (C052), both orders', () => {
  for (const [drop, patch] of [['drop c.S.R', '&c.S.R { edge = bottom }'], ['drop c.L', '&c.L { masks = 2 }']]) {
    const files = { 'common.stencil': COMMON, 'left.stencil': H + `import "common" as c\n${drop}`, 'right.stencil': H + `import "common" as c\n${patch}` };
    for (const o of orders) {
      const r = project({ ...files, 'main.stencil': T + o });
      assert.ok(codes(r).includes('C052'), `${drop} / ${o}: ${JSON.stringify(r.diags)}`);
      assert.equal(r.resolved.complete, false);
    }
  }
});

test('a patch below an ancestor that a sibling dropped is C052 in both orders', () => {
  const files = {
    'common.stencil': COMMON,
    'left.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'right.stencil': H + 'import "common" as c\n&c.S.R { edge = bottom }',
  };
  for (const o of orders) assert.ok(codes(project({ ...files, 'main.stencil': T + o })).includes('C052'), o);
});

test('the importer may still drop what its own imports declare', () => {
  const r = project({ 'main.stencil': T + 'import "common" as c\n&c.L { masks = 2 }\ndrop c.S.R', 'common.stencil': COMMON });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.deepEqual(obj(r, 'S').children, []);
});

const LIB = H + 'LANDING = required(layer)\nMP = 30nm\nN = 3\nlayer M1 { role = conductor; pitch = MP }\nconnector C { lower = LANDING; cut = none; upper = M1 }';

test('typed parameters: required(T) and the default\'s type are enforced (C014)', () => {
  const good = project({ 'main.stencil': T + 'layer MD { role = conductor; below = l.M1 }\nimport "lib" as l { LANDING = MD; MP = 40nm; N = 4 }', 'lib.stencil': LIB });
  assert.deepEqual(codes(good), [], JSON.stringify(good.diags));
  for (const [bind, re] of [['LANDING = 30nm', /expects a layer, got the length 30nm/], ['LANDING = MD; MP = 4', /MP' of l expects a len/], ['LANDING = MD; N = 4nm', /N' of l expects a number/], ['LANDING = S', /expects a layer, got the site/]]) {
    const r = project({ 'main.stencil': T + 'layer MD { role = conductor; below = l.M1 }\nsite S { width = 1nm; height = 1nm }\nimport "lib" as l { ' + bind + ' }', 'lib.stencil': LIB });
    const d = errors(r).find((x) => x.code === 'C014');
    assert.ok(d && re.test(d.message), `${bind}: ${JSON.stringify(r.diags)}`);
    assert.equal(d.file, 'main.stencil');
  }
});

test('an unknown parameter type is reported where it is declared', () => {
  const r = project({ 'main.stencil': T + 'X = required(lyaer)' });
  const d = errors(r).find((x) => x.code === 'C014');
  assert.equal(d.hint, "did you mean 'layer'?");
});

test('the common importer settles a sibling conflict with its own patch or drop', () => {
  const files = {
    'common.stencil': COMMON,
    'left.stencil': H + 'import "common" as c\n&c.L { masks = 2 }',
    'right.stencil': H + 'import "common" as c\n&c.L { masks = 3 }',
  };
  const bad = project({ ...files, 'main.stencil': T + 'import "left" as a\nimport "right" as b' });
  assert.ok(codes(bad).includes('C052'));
  for (const settle of ['&a.c.L { masks = 4 }', 'drop a.c.L']) {
    const r = project({ ...files, 'main.stencil': T + 'import "left" as a\nimport "right" as b\n' + settle });
    assert.ok(!codes(r).includes('C052'), `${settle}: ${JSON.stringify(r.diags)}`);
  }
});

test('typed parameters: unused bad bindings, untyped required, list defaults are untyped', () => {
  const lib = H + 'UNUSED = 3nm\nANY = required\nLST = [1, 2]\nlayer M { role = conductor }';
  const r = project({ 'main.stencil': T + 'import "lib" as l { UNUSED = 5; ANY = 5; LST = 7nm }', 'lib.stencil': lib });
  const c14 = errors(r).filter((d) => d.code === 'C014');
  assert.equal(c14.length, 1, JSON.stringify(r.diags));
  assert.match(c14[0].message, /UNUSED/);
});

test('a default that depends on another parameter types the binding by its evaluated value', () => {
  const lib = H + 'CPP = 45nm\nMP = 2/3 * CPP\nlayer M { role = conductor; pitch = MP }';
  assert.deepEqual(codes(project({ 'main.stencil': T + 'import "lib" as l { MP = 30nm }', 'lib.stencil': lib })), []);
  assert.ok(codes(project({ 'main.stencil': T + 'import "lib" as l { MP = 2 }', 'lib.stencil': lib })).includes('C014'));
});

// ---- ------------------------------------------
const both = (files, imports) => [imports.join('\n'), [...imports].reverse().join('\n')].map((o) => project({ ...files, 'main.stencil': T + o + (files.__tail ?? '') }));

test('R1: identical drops are idempotent, in every form and both orders', () => {
  for (const d of ['drop c.L', 'drop c.S.R', '&c.S { drop R }']) {
    const files = { 'common.stencil': COMMON.replace('rail R { layer = L; edge = top }', 'rail R { layer = L; edge = top }') + '\nlayer K { role = conductor }', 'left.stencil': H + `import "common" as c\n${d}`, 'right.stencil': H + `import "common" as c\n${d}` };
    for (const r of both(files, ['import "left" as a', 'import "right" as b'])) assert.deepEqual(codes(r), [], `${d}: ${JSON.stringify(r.diags)}`);
  }
});

test('R1: a common importer repeating an existing drop settles a drop/patch conflict', () => {
  const files = { 'common.stencil': COMMON, 'left.stencil': H + 'import "common" as c\ndrop c.S.R', 'right.stencil': H + 'import "common" as c\n&c.S.R { edge = bottom }', __tail: '\ndrop a.c.S.R' };
  for (const r of both(files, ['import "left" as a', 'import "right" as b'])) assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
});

test('R2: settlement by the common importer holds in both import orders', () => {
  const base = { 'common.stencil': COMMON, 'left.stencil': H + 'import "common" as c\n&c.S { drop R }', 'right.stencil': H + 'import "common" as c\n&c.S.R { edge = bottom }' };
  for (const tail of ['\ndrop a.c.S', '\n&a.c.S { rail R { layer = a.c.L; edge = bottom } }']) {
    for (const r of both({ ...base, __tail: tail }, ['import "left" as a', 'import "right" as b'])) assert.deepEqual(codes(r), [], `${tail}: ${JSON.stringify(r.diags)}`);
  }
  for (const r of both(base, ['import "left" as a', 'import "right" as b'])) assert.ok(codes(r).includes('C052'), JSON.stringify(r.diags));
});

test('R3: an override by a module that imports the patcher is legal in both orders (import graph)', () => {
  const files = { 'common.stencil': H + 'layer L { role = conductor; masks = 1 }', 'left.stencil': H + 'import "common" as c\n&c.L { masks = 2 }', 'join.stencil': H + 'import "left" as a\n&a.c.L { masks = 3 }' };
  for (const r of both(files, ['import "left" as a', 'import "join" as j'])) {
    assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
    assert.equal(obj(r, 'L').attrs.masks, 3);
  }
  const sib = { 'common.stencil': H + 'layer L { role = conductor; masks = 1 }', 'left.stencil': H + 'import "common" as c\n&c.L { masks = 2 }', 'right.stencil': H + 'import "common" as c\n&c.L { masks = 3 }', 'join.stencil': H + 'import "left" as a\nimport "right" as b\n&a.c.L { masks = 4 }' };
  for (const r of both(sib, ['import "left" as a', 'import "join" as j'])) assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
});

test('R4: a parameter bound twice is an error and cannot launder its type', () => {
  for (const decl of ['X = required(layer)', 'X = 1nm']) {
    const r = project({ 'main.stencil': T + 'import "lib" as l { X = 1; X = 2 }', 'lib.stencil': H + decl });
    assert.ok(codes(r).includes('C020') && codes(r).includes('C014'), `${decl}: ${JSON.stringify(r.diags)}`);
  }
});

test('R5: a typed layer binding does not break a valid drop cascade', () => {
  const r = project({ 'main.stencil': T + 'import "lib" as l { X = L }\nlayer L { role = conductor; below = l.U }\ndrop L', 'lib.stencil': H + 'X = required(layer)\nlayer U { role = conductor }\nconnector C { lower = X; cut = none; upper = U }' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.ok(r.diags.some((d) => d.code === 'I020'));
});

test('follow-ups: aliases are not modules, own-property kinds only, required(T) placement', () => {
  const r1 = project({ 'main.stencil': T + 'import "other" as o\nimport "lib" as l { X = o }', 'lib.stencil': H + 'X = required(module)', 'other.stencil': H });
  assert.ok(codes(r1).includes('C014'), JSON.stringify(r1.diags));
  for (const t of ['constructor', 'toString', '__proto__']) assert.ok(codes(project({ 'main.stencil': T + `X = required(${t})` })).includes('C014'), t);
  for (const src of ['layer L { role = conductor; masks = required(number) }', 'X = [required(layer)]', 'layer L { role = conductor }\n&L { masks = required(number) }']) {
    assert.ok(codes(project({ 'main.stencil': T + src })).includes('C014'), src);
  }
});

// ---- ---------------------------------------
test('R2-1: repeated drops are idempotent when base is present', () => {
  const r = project({ 'main.stencil': T + 'layer A { role = conductor }\nlayer B { base = A; masks = 2 }\n&B { drop masks }\n&B { drop masks }' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  const lib = H + 'layer A { role = conductor }\nlayer B { base = A; masks = 2 }';
  for (const [l, rr] of [['&c.B { drop masks }', '&c.B { drop masks }'], ['drop c.B.masks', '&c.B { drop masks }'], ['drop c.B.masks', 'drop c.B.masks']]) {
    const files = { 'common.stencil': lib, 'left.stencil': H + `import "common" as c\n${l}`, 'right.stencil': H + `import "common" as c\n${rr}` };
    for (const res of both(files, ['import "left" as a', 'import "right" as b'])) assert.deepEqual(codes(res), [], `${l} / ${rr}: ${JSON.stringify(res.diags)}`);
  }
});

test('R2-2: a patch deferred against a dropped target is still checked, in both orders', () => {
  const base = { 'common.stencil': COMMON, 'left.stencil': H + 'import "common" as c\n&c.S { drop R }', __tail: '\ndrop a.c.S' };
  for (const [patch, code] of [['&c.S.R { drop TYPO }', 'C050'], ['&c.S.R { edge = required(name) }', 'C014'], ['&c.S.R.TYPO { x_foo = 1 }', 'C050']]) {
    for (const r of both({ ...base, 'right.stencil': H + `import "common" as c\n${patch}` }, ['import "left" as a', 'import "right" as b'])) {
      assert.ok(codes(r).includes(code), `${patch}: ${JSON.stringify(r.diags)}`);
      assert.equal(r.resolved.complete, false);
    }
  }
});

test('R2-3: an identical sibling drop does not hide C051', () => {
  const files = {
    'common.stencil': COMMON,
    'left.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'right.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'join.stencil': H + 'import "left" as a\n&a.c.S.R { edge = bottom }',
  };
  for (const tail of ['', '\ndrop a.c.S']) {
    for (const o of ['import "left" as a\nimport "right" as b\nimport "join" as j', 'import "right" as b\nimport "left" as a\nimport "join" as j']) {
      const r = project({ ...files, 'main.stencil': T + o + tail });
      assert.ok(codes(r).includes('C051'), `${o}${tail}: ${JSON.stringify(r.diags)}`);
    }
  }
});

test('R2 follow-up: required(T) is rejected in import option blocks', () => {
  const r = project({ 'main.stencil': T + 'import "lib" as l {\n  rename { prefix = required(string) }\n  gds { shift = required(number) }\n}', 'lib.stencil': H });
  assert.equal(errors(r).filter((d) => d.code === 'C014').length, 2, JSON.stringify(r.diags));
});

// ---- ---------------------------------------
test('R3-1: a deferred tombstone without a retained object gives C050 in both orders', () => {
  const common = H + 'layer L { role = conductor }\nsite A {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top }\n}\nsite S { base = A }';
  for (const patch of ['&c.S.R.TYPO { x_foo = 1 }', '&c.S.R { drop TYPO }', '&c.S.R { edge = required(name) }']) {
    const files = { 'common.stencil': common, 'left.stencil': H + 'import "common" as c\n&c.S { drop R }', 'right.stencil': H + `import "common" as c\n${patch}`, __tail: '\ndrop a.c.S' };
    for (const r of both(files, ['import "left" as a', 'import "right" as b'])) {
      assert.equal(r.resolved.complete, false, `${patch}: ${JSON.stringify(r.diags)}`);
      assert.ok(codes(r).includes('C050'), `${patch}: ${JSON.stringify(r.diags)}`);
    }
  }
});

test('R3-2: patching what an own import drops with a qualified drop is C051', () => {
  for (const [drop, patch] of [['drop c.L', '&a.c.L { masks = 2 }'], ['drop c.S.R', '&a.c.S.R { edge = bottom }'], ['drop c.S', '&a.c.S.R { edge = bottom }']]) {
    const r = project({ 'common.stencil': COMMON, 'left.stencil': H + `import "common" as c\n${drop}`, 'main.stencil': T + 'import "left" as a\n' + patch });
    assert.ok(codes(r).includes('C051'), `${drop} / ${patch}: ${JSON.stringify(r.diags)}`);
  }
  // the importer may still drop what its import patched
  const ok = project({ 'common.stencil': COMMON, 'left.stencil': H + 'import "common" as c\n&c.L { masks = 2 }', 'main.stencil': T + 'import "left" as a\ndrop a.c.L\ndrop a.c.S' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
});

test('R3-3: restoring a child clears its drop provenance', () => {
  const files = {
    'common.stencil': COMMON,
    'left.stencil': H + 'import "common" as c\n&c.S { drop R }\n&c.S { rail R { layer = c.L; edge = bottom } }',
    'right.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'join.stencil': H + 'import "left" as a\n&a.c.S.R { edge = top }',
  };
  for (const o of ['import "left" as a\nimport "right" as b\nimport "join" as j', 'import "right" as b\nimport "left" as a\nimport "join" as j']) {
    const r = project({ ...files, 'main.stencil': T + o + '\ndrop a.c.S' });
    assert.deepEqual(codes(r), [], `${o}: ${JSON.stringify(r.diags)}`);
  }
});

test('R3-4: a nested patch drop that removes a real value survives the base merge', () => {
  const pre = 'layer L { role = conductor }\nsite A {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top }\n}\nsite S {\n  width = 1nm; height = 1nm\n  rail R { base = A.R; width = 2nm }\n}\n';
  for (const tail of ['&S { rail R { drop width } }', '&S.R { drop width }\n&S { rail R { drop width } }']) {
    const r = project({ 'main.stencil': T + pre + tail });
    assert.deepEqual(codes(r), [], `${tail}: ${JSON.stringify(r.diags)}`);
    assert.equal(obj(r, 'S').children[0].attrs.width, undefined);
  }
});

// ---- ---------------------------------------
test('R4-1: an own import dropping the parent is C051 in both orders, next to a sibling tombstone', () => {
  const files = {
    'common.stencil': COMMON,
    'left.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'dropper.stencil': H + 'import "common" as c\ndrop c.S',
    'join.stencil': H + 'import "dropper" as d\n&d.c.S.R { edge = bottom }',
    __tail: '\ndrop a.c.S',
  };
  for (const r of both(files, ['import "left" as a', 'import "join" as j'])) assert.ok(codes(r).includes('C051'), JSON.stringify(r.diags));
});

test('R4-2: a common importer restores a child its import dropped with a qualified drop', () => {
  for (const drop of ['drop c.S.R', '&c.S { drop R }']) {
    const files = {
      'common.stencil': COMMON,
      'left.stencil': H + `import "common" as c\n${drop}`,
      'right.stencil': H + 'import "common" as c\n&c.S.R { edge = bottom }',
      __tail: '\n&a.c.S {\n  rail R { layer = a.c.L; edge = bottom }\n}',
    };
    for (const r of both(files, ['import "left" as a', 'import "right" as b'])) {
      assert.deepEqual(codes(r), [], `${drop}: ${JSON.stringify(r.diags)}`);
      assert.equal(obj(r, 'S').children.find((c) => c.name === 'R')?.attrs.edge, 'bottom');
    }
  }
});

test('R4 follow-up: one C051 per patch', () => {
  const r = project({ 'common.stencil': COMMON + '\n&S.R { width = 1nm }', 'left.stencil': H + 'import "common" as c\ndrop c.S.R.width\ndrop c.S.R', 'main.stencil': T + 'import "left" as a\n&a.c.S.R { edge = bottom; width = 2nm }' });
  assert.equal(errors(r).filter((d) => d.code === 'C051').length, 1, JSON.stringify(r.diags));
});

test('an importer may set an attribute its import dropped', () => {
  const r = project({ 'common.stencil': COMMON, 'left.stencil': H + 'import "common" as c\ndrop c.S.R.edge', 'main.stencil': T + 'import "left" as a\n&a.c.S.R { edge = bottom }' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(obj(r, 'S').children[0].attrs.edge, 'bottom');
});

// ---- ---------------------------------------
const COMMON5 = H + 'layer L { role = conductor }\nsite S {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; width = 2nm }\n}';
const perms = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
const allOrders = (files, imports, tail = '') => perms(imports).map((o) => ({ order: o.join(' | '), r: project({ ...files, 'main.stencil': T + o.join('\n') + tail }) }));
const rail = (r) => obj(r, 'S')?.children.find((c) => c.name === 'R')?.attrs ?? null;

test('R5-1: an unrelated sibling restoring the child does not hide own-import C051', () => {
  for (const drop of ['drop c.S.R', '&c.S { drop R }']) {
    const files = {
      'common.stencil': COMMON5,
      'left.stencil': H + `import "common" as c\n${drop}`,
      'right.stencil': H + 'import "common" as c\n&c.S {\n  rail R { layer = c.L; edge = bottom; width = 4nm }\n}',
      'join.stencil': H + 'import "left" as a\n&a.c.S.R { edge = top }',
    };
    for (const { order, r } of allOrders(files, ['import "left" as a', 'import "right" as b', 'import "join" as j'], '\ndrop a.c.S')) {
      assert.ok(codes(r).includes('C051'), `${drop} / ${order}: ${JSON.stringify(r.diags)}`);
    }
  }
});

test('R5-2: drop + restoration by siblings: unsettled attributes are C052 in every order', () => {
  const files = {
    'common.stencil': COMMON5,
    'left.stencil': H + 'import "common" as c\ndrop c.S.R',
    'right.stencil': H + 'import "common" as c\n&c.S {\n  rail R { layer = c.L; edge = bottom; width = 4nm }\n}',
  };
  // main restores R but leaves width (set by right, dropped by left) unsettled
  for (const { order, r } of allOrders(files, ['import "left" as a', 'import "right" as b'], '\n&a.c.S {\n  rail R { layer = a.c.L; edge = top }\n}')) {
    assert.ok(codes(r).includes('C052'), `${order}: ${JSON.stringify(r.diags)}`);
  }
  // settling every attribute either module set gives one result in every order
  const results = allOrders(files, ['import "left" as a', 'import "right" as b'], '\n&a.c.S {\n  rail R { layer = a.c.L; edge = top; width = 6nm }\n}');
  for (const { order, r } of results) {
    assert.deepEqual(codes(r), [], `${order}: ${JSON.stringify(r.diags)}`);
    assert.deepEqual(rail(r), { layer: { ref: 'L' }, edge: 'top', width: 6 }, order);
  }
  const files2 = {
    'common.stencil': COMMON5,
    'left.stencil': H + 'import "common" as c\n&c.S.R { width = 3nm }',
    'right.stencil': H + 'import "common" as c\n&c.S { drop R }\n&c.S {\n  rail R { layer = c.L; edge = top; width = 4nm }\n}',
  };
  for (const { order, r } of allOrders(files2, ['import "left" as a', 'import "right" as b'], '\n&a.c.S.R { edge = bottom }')) {
    assert.ok(codes(r).includes('C052'), `${order}: ${JSON.stringify(r.diags)}`);
  }
  for (const { order, r } of allOrders(files2, ['import "left" as a', 'import "right" as b'], '\n&a.c.S.R { edge = bottom; width = 5nm }')) {
    assert.deepEqual(codes(r), [], `${order}: ${JSON.stringify(r.diags)}`);
    assert.equal(rail(r).width, 5, order);
  }
});

test('R5-3: patches follow tombstones inside a dropped object, in every order', () => {
  const files = {
    'common.stencil': COMMON5,
    'whole.stencil': H + 'import "common" as c\ndrop c.S',
    'child.stencil': H + 'import "common" as c\n&c.S { drop R }',
    'patch.stencil': H + 'import "common" as c\n&c.S.R { edge = bottom }',
  };
  for (const { order, r } of allOrders(files, ['import "whole" as whole', 'import "child" as child', 'import "patch" as patch'], '\ndrop whole.c.S')) {
    assert.deepEqual(codes(r), [], `${order}: ${JSON.stringify(r.diags)}`);
    assert.equal(obj(r, 'S'), undefined);
  }
  for (const { order, r } of allOrders(files, ['import "whole" as whole', 'import "child" as child', 'import "patch" as patch'])) {
    assert.ok(codes(r).includes('C052'), `${order} (unsettled): ${JSON.stringify(r.diags)}`);
  }
});

test('R5-4: a descendant drop names something real even if a sibling dropped its ancestor', () => {
  for (const [l, rr] of [['drop c.S.R', 'drop c.S'], ['drop c.S.R.width', 'drop c.S.R']]) {
    const files = { 'common.stencil': COMMON5, 'left.stencil': H + `import "common" as c\n${l}`, 'right.stencil': H + `import "common" as c\n${rr}` };
    for (const { order, r } of allOrders(files, ['import "left" as a', 'import "right" as b'])) {
      assert.deepEqual(codes(r), [], `${l} / ${rr} / ${order}: ${JSON.stringify(r.diags)}`);
    }
  }
});

// ---- ---------------------------------------
test('R6-1: a partial restoration keeps what the original declared, for later drops, in every order', () => {
  for (const aSrc of ['drop c.S.R', '&c.S { drop R }']) {
    const files = {
      'common.stencil': COMMON5,
      'a.stencil': H + `import "common" as c\n${aSrc}`,
      'b.stencil': H + 'import "common" as c\n&c.S {\n  rail R { layer = c.L; edge = bottom }\n}',
      'd.stencil': H + 'import "common" as c\ndrop c.S.R.width',
    };
    const imps = ['import "a" as a', 'import "b" as b', 'import "d" as d'];
    for (const { order, r } of allOrders(files, imps, '\ndrop a.c.S')) {
      assert.deepEqual(codes(r), [], `${aSrc} / ${order}: ${JSON.stringify(r.diags)}`);
      assert.equal(r.resolved.complete, true);
    }
    const settled = allOrders(files, imps, '\n&a.c.S {\n  rail R { layer = a.c.L; edge = top; width = 6nm }\n}');
    for (const { order, r } of settled) {
      assert.deepEqual(codes(r), [], `${aSrc} / ${order} (restored): ${JSON.stringify(r.diags)}`);
      assert.deepEqual(rail(r), { layer: { ref: 'L' }, edge: 'top', width: 6 }, order);
    }
  }
});

test('R6-2: children added by a patch are ordinary objects afterwards', () => {
  const single = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite S { width = 1nm; height = 1nm }\n&S {\n  rail R { layer = L; edge = top; width = 2nm }\n}\n&S.R { drop TYPO }' });
  assert.ok(codes(single).includes('C050'), JSON.stringify(single.diags));
  assert.equal(single.resolved.complete, false);
  const fresh = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite S { width = 1nm; height = 1nm }\n&S {\n  rail R { layer = L; edge = top; drop TYPO }\n}' });
  assert.ok(codes(fresh).includes('C050'), JSON.stringify(fresh.diags));
  const files = {
    'common.stencil': COMMON5,
    'a.stencil': H + 'import "common" as c\n&c.S { drop R }\n&c.S {\n  rail R { layer = c.L; edge = top }\n}',
    'b.stencil': H + 'import "common" as c\n&c.S.R { drop TYPO }',
    'd.stencil': H + 'import "common" as c',
  };
  for (const { order, r } of allOrders(files, ['import "a" as a', 'import "b" as b', 'import "d" as d'], '\ndrop a.c.S')) {
    assert.ok(codes(r).includes('C050'), `${order}: ${JSON.stringify(r.diags)}`);
    assert.equal(r.resolved.complete, false);
  }
});

// ---- ---------------------------------------
test('R7-1: nested merges also accept names the replaced child declared, in every order', () => {
  for (const aSrc of ['drop c.S.R', '&c.S { drop R }']) {
    const files = {
      'common.stencil': COMMON5,
      'a.stencil': H + `import "common" as c\n${aSrc}`,
      'b.stencil': H + 'import "common" as c\n&c.S { rail R { layer = c.L; edge = bottom } }',
      'd.stencil': H + 'import "common" as c\n&c.S { rail R { drop width } }',
    };
    const imps = ['import "a" as a', 'import "b" as b', 'import "d" as d'];
    for (const { order, r } of allOrders(files, imps, '\ndrop a.c.S')) assert.deepEqual(codes(r), [], `${aSrc} / ${order}: ${JSON.stringify(r.diags)}`);
    for (const { order, r } of allOrders(files, imps, '\n&a.c.S {\n  rail R { layer = a.c.L; edge = top; width = 6nm }\n}')) {
      assert.deepEqual(codes(r), [], `${aSrc} / ${order} (restored): ${JSON.stringify(r.diags)}`);
      assert.deepEqual(rail(r), { layer: { ref: 'L' }, edge: 'top', width: 6 }, order);
    }
  }
});

test('R7-2: children of a patch body are checked after the body merges, at any depth', () => {
  const r = project({ 'main.stencil': T + 'x_group G {\n  x_child C {\n    x_leaf L { x_value = 1 }\n  }\n}\n&G {\n  x_child C {\n    x_leaf L { drop x_value }\n  }\n}' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(r.resolved.complete, true);
  const r2 = project({ 'main.stencil': T + 'layer L { role = conductor }\nsite S { width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; x_extra { x_leaf K { x_v = 1 } } }\n}\n&S { rail R { x_extra { x_leaf K { drop x_v } } } }' });
  assert.deepEqual(codes(r2), [], JSON.stringify(r2.diags));
  // a genuinely missing name inside a new child is still C050
  const bad = project({ 'main.stencil': T + 'x_group G { }\n&G {\n  x_child C {\n    x_leaf L { drop x_value }\n  }\n}' });
  assert.ok(codes(bad).includes('C050'), JSON.stringify(bad.diags));
});

// ---- ---------------------------------------
test('R8-1: restoration history reaches the replaced child\'s descendants, in every order', () => {
  const common = H + 'x_group G {\n  x_child C {\n    x_leaf L { x_value = 1 }\n  }\n}';
  for (const aSrc of ['drop c.G.C', '&c.G { drop C }']) {
    for (const bBody of ['x_child C {\n    x_leaf L { x_keep = 2 }\n  }', 'x_child C { x_other = 3 }']) {      // L kept, L left out
      for (const dSrc of ['&c.G.C.L { drop x_value }', 'drop c.G.C.L.x_value', '&c.G { x_child C { x_leaf L { drop x_value } } }']) {
        const files = { 'common.stencil': common, 'a.stencil': H + `import "common" as c\n${aSrc}`, 'b.stencil': H + `import "common" as c\n&c.G {\n  ${bBody}\n}`, 'd.stencil': H + `import "common" as c\n${dSrc}` };
        for (const { order, r } of allOrders(files, ['import "a" as a', 'import "b" as b', 'import "d" as d'], '\ndrop a.c.G')) {
          assert.deepEqual(codes(r), [], `${aSrc} / ${bBody} / ${dSrc} / ${order}: ${JSON.stringify(r.diags)}`);
          assert.equal(r.resolved.complete, true);
        }
      }
    }
  }
});

test('R8-2: a drop the same patch body sets again is still checked', () => {
  const pre = 'layer L { role = conductor }\nsite S {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top }\n}\n';
  for (const tail of ['&S {\n  rail R { drop width; width = 2nm }\n}', '&S.R { drop width; width = 2nm }', '&S {\n  rail Q { layer = L; edge = top; drop width; width = 2nm }\n}']) {
    const r = project({ 'main.stencil': T + pre + tail });
    assert.ok(codes(r).includes('C050'), `${tail}: ${JSON.stringify(r.diags)}`);
  }
  const ok = project({ 'main.stencil': T + pre.replace('edge = top }', 'edge = top; width = 1nm }') + '&S {\n  rail R { drop width; width = 2nm }\n}' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
  assert.equal(obj(ok, 'S').children[0].attrs.width, 2);
});

// ---- : drop validity is decided once,
// after inheritance, from what the dropping module can see ------------------------------
test('R9-1: history survives repeated replacement, in every order', () => {
  const common = H + 'x_group G {\n  x_child C {\n    x_leaf L { x_value = 1 }\n  }\n}';
  const aSrc = 'import "common" as c\n&c.G { drop C }\n&c.G { x_child C { x_other = 2 } }\n&c.G { drop C }\n&c.G { x_child C { x_leaf L { x_keep = 3 } } }';
  for (const dSrc of ['&c.G.C.L { drop x_value }', 'drop c.G.C.L.x_value', '&c.G { x_child C { x_leaf L { drop x_value } } }']) {
    const files = { 'common.stencil': common, 'a.stencil': H + aSrc, 'd.stencil': H + `import "common" as c\n${dSrc}` };
    for (const { order, r } of allOrders(files, ['import "a" as a', 'import "d" as d'], '\ndrop a.c.G')) {
      assert.deepEqual(codes(r), [], `${dSrc} / ${order}: ${JSON.stringify(r.diags)}`);
    }
  }
});

test('R9-2: declaring a child after dropping it does not make the drop valid', () => {
  for (const tail of ['&G {\n  x_child C {\n    drop L\n    x_leaf L { x_value = 2 }\n  }\n}', '&G.C { drop L; x_leaf L { x_value = 2 } }', '&G {\n  x_child N {\n    drop L\n    x_leaf L { x_value = 2 }\n  }\n}']) {
    const r = project({ 'main.stencil': T + 'x_group G {\n  x_child C { x_keep = 1 }\n}\n' + tail });
    assert.ok(codes(r).includes('C050'), `${tail}: ${JSON.stringify(r.diags)}`);
  }
  const ok = project({ 'main.stencil': T + 'x_group G {\n  x_child C { x_leaf L { x_value = 1 } }\n}\n&G {\n  x_child C {\n    drop L\n    x_leaf L { x_value = 2 }\n  }\n}' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
});

test('R9-3: re-assignment does not hide an invalid drop on an object with its own base', () => {
  for (const tail of ['&L {\n  drop x_missing\n  x_missing = 2\n}', 'x_group H { x_leaf L2 { base = A } }\n&H { x_leaf L2 { drop x_missing; x_missing = 2 } }']) {
    const r = project({ 'main.stencil': T + 'x_leaf A { x_keep = 1 }\nx_leaf L { base = A }\n' + tail });
    assert.ok(codes(r).includes('C050'), `${tail}: ${JSON.stringify(r.diags)}`);
  }
  const ok = project({ 'main.stencil': T + 'x_leaf A { x_keep = 1 }\nx_leaf L { base = A }\n&L {\n  drop x_keep\n  x_keep = 2\n}' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
});

test('a drop inside an inherited child names what the base declares (formerly deferred)', () => {
  const pre = 'layer L { role = conductor }\nsite A {\n  width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; width = 3nm }\n}\n';
  const r = project({ 'main.stencil': T + pre + 'site B {\n  base = A\n  rail R { drop width }\n}' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(obj(r, 'B').children[0].attrs.width, undefined);
  const bad = project({ 'main.stencil': T + pre + 'site B {\n  base = A\n  rail R { drop nothing_here }\n}' });
  assert.ok(codes(bad).includes('C050'), JSON.stringify(bad.diags));
});

// ---- -------------------------------------
test('R10-1: removing an inheriting object does not invalidate its drops', () => {
  for (const src of [
    'layer A { role = conductor; masks = 2 }\nlayer B { base = A; drop masks }\ndrop B',
    'layer L { role = conductor }\nsite A { width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; width = 3nm } }\nsite B { base = A\n  rail R { drop width } }\ndrop B',
  ]) {
    const r = project({ 'main.stencil': T + src });
    assert.deepEqual(codes(r), [], `${src}: ${JSON.stringify(r.diags)}`);
  }
});

test('R10-2: only a base the dropping module can see counts, in both orders and under transforms', () => {
  const common = H + 'layer A { role = conductor; masks = 2 }\nlayer B { role = conductor }';
  const files = { 'common.stencil': common, 'left.stencil': H + 'import "common" as c\n&c.B { base = c.A }', 'right.stencil': H + 'import "common" as c\n&c.B { drop masks }' };
  for (const r of both(files, ['import "left" as l', 'import "right" as r'])) assert.ok(codes(r).includes('C050'), JSON.stringify(r.diags));
  const wrapped = { ...files, 'wrap.stencil': H + 'import "left" as l\nimport "right" as r' };
  const w = project({ ...wrapped, 'main.stencil': T + 'import "wrap" as w { rename { prefix = "W_" }; scale { xy = 2 } }' });
  assert.ok(codes(w).includes('C050'), JSON.stringify(w.diags));
  // a library drop stays valid when an importer gives the object another base
  const lib = { 'lib.stencil': H + 'layer A { role = conductor; masks = 2 }\nlayer Z { role = conductor }\nlayer B { base = A; drop masks }' };
  const r2 = project({ ...lib, 'main.stencil': T + 'import "lib" as l\n&l.B { base = l.Z }' });
  assert.ok(!codes(r2).includes('C050'), JSON.stringify(r2.diags));
});

test('R10-3: qualified drops follow source order like in-patch drops', () => {
  for (const src of ['layer L { role = conductor }\ndrop L.masks\n&L { masks = 2 }', 'layer L { role = conductor }\n&L { drop masks }\n&L { masks = 2 }']) {
    assert.ok(codes(project({ 'main.stencil': T + src })).includes('C050'), src);
  }
  assert.deepEqual(codes(project({ 'main.stencil': T + 'layer L { role = conductor }\n&L { masks = 2 }\ndrop L.masks' })), []);
});

// ---- -------------------------------------
test('R11-1: a base into the object\'s own descendant terminates', () => {
  const r = project({ 'main.stencil': T + 'x_group A {\n  base = A.C\n  drop x_value\n  x_group C { x_value = 1 }\n}' });
  assert.ok(Array.isArray(r.diags));
  assert.ok(!codes(r).includes('C050'), JSON.stringify(r.diags));
});

test('R11-2: removing an intermediate inheriting object keeps the inheritance path', () => {
  for (const tail of ['drop B\ndrop C', 'drop C', 'drop B']) {
    const r = project({ 'main.stencil': T + 'x_group A { x_leaf L { x_value = 1 } }\nx_group B { base = A }\nx_leaf C { base = B.L; drop x_value }\n' + tail });
    assert.ok(!codes(r).includes('C050'), `${tail}: ${JSON.stringify(r.diags)}`);
  }
  const files = { 'lib.stencil': H + 'x_group A { x_leaf L { x_value = 1 } }\nx_group B { base = A }', 'mid.stencil': H + 'import "lib" as l\nx_leaf C { base = l.B.L; drop x_value }\ndrop l.B' };
  const r = project({ ...files, 'main.stencil': T + 'import "mid" as m { rename { prefix = "P_" }; scale { xy = 2 } }' });
  assert.ok(!codes(r).includes('C050'), JSON.stringify(r.diags));
});

test('R11-3: top-level drops follow source order too', () => {
  for (const src of ['drop L\nlayer L { role = conductor }', 'drop P\nP = 1']) {
    const r = project({ 'main.stencil': T + src });
    assert.ok(codes(r).includes('C050'), `${src}: ${JSON.stringify(r.diags)}`);
    assert.equal(r.resolved.complete, false);
  }
  for (const src of ['layer L { role = conductor }\ndrop L', 'P = 1\ndrop P']) assert.deepEqual(codes(project({ 'main.stencil': T + src })), [], src);
  const r = project({ 'lib.stencil': H + 'layer L { role = conductor }', 'main.stencil': T + 'import "lib" as l\ndrop l.L' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
});

// ---- -------------------------------------
test('R12-1: long acyclic inheritance chains validate drops', () => {
  for (const n of [17, 18, 40]) {
    const body = ['layer A0 { role = conductor; masks = 2 }', ...Array.from({ length: n }, (_, i) => `layer A${i + 1} { base = A${i} }`)];
    for (const tail of [`&A${n} { drop masks }`, `drop A${n}.masks`, `&A${n} { drop masks }\ndrop A${n}`]) {
      const r = project({ 'main.stencil': T + [...body, tail].join('\n') });
      assert.deepEqual(codes(r), [], `${n} / ${tail}: ${JSON.stringify(r.diags)}`);
    }
  }
  // the self-descendant base still terminates
  assert.ok(!codes(project({ 'main.stencil': T + 'x_group A {\n  base = A.C\n  drop x_value\n  x_group C { x_value = 1 }\n}' })).includes('C050'));
});

test('R12-2: unnamed objects as base targets', () => {
  for (const tail of ['x_group B { base = x_group; drop x_value }', 'x_group B { base = x_group }\n&B { drop x_value }', 'x_group B { base = x_group }\ndrop B.x_value', 'x_group B { base = x_group; drop x_value }\ndrop B']) {
    const r = project({ 'main.stencil': T + 'x_group { x_value = 1 }\n' + tail });
    assert.deepEqual(codes(r), [], `${tail}: ${JSON.stringify(r.diags)}`);
  }
});

test('R12-3: a dropped parameter\'s binding is still type-checked', () => {
  for (const [decl, bind] of [['X = required(layer)', '1'], ['X = 3nm', '"s"'], ['X = true', '2nm']]) {
    for (const wrap of [false, true]) {
      const lib = H + decl;
      const r = wrap
        ? project({ 'lib.stencil': lib, 'mid.stencil': H + `import "lib" as l { X = ${bind} }\ndrop l.X`, 'main.stencil': T + 'import "mid" as m { rename { prefix = "P_" }; scale { xy = 2 } }' })
        : project({ 'lib.stencil': lib, 'main.stencil': T + `import "lib" as l { X = ${bind} }\ndrop l.X` });
      assert.ok(codes(r).includes('C014'), `${decl} / ${bind} / ${wrap}: ${JSON.stringify(r.diags)}`);
      assert.equal(r.resolved.complete, false);
    }
  }
  assert.deepEqual(codes(project({ 'lib.stencil': H + 'X = 3nm', 'main.stencil': T + 'import "lib" as l { X = 4nm }\ndrop l.X' })), []);
});

test('drop validation stays fast on deep nested inheritance (object and child both inherit)', () => {
  const lines = ['layer L { role = conductor }', 'site S0 { width = 1nm; height = 1nm\n  rail R { layer = L; edge = top; width = 2nm } }'];
  for (let i = 1; i <= 200; i++) lines.push(`site S${i} { base = S${i - 1}\n  rail R { base = S${i - 1}.R } }`);
  lines.push('&S200.R { drop width }', '&S200.R { drop nothing_here }');
  const t = Date.now();
  const r = project({ 'main.stencil': T + lines.join('\n') });
  assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`);
  assert.deepEqual(codes(r), ['C050'], JSON.stringify(r.diags));   // only the missing name
});

// ---- : inherited names are looked up in
// the materialized inheritance, not searched symbolically -----------------------------------
test('R13-1: a chain that grows before it shrinks validates the drop', () => {
  const chain = 'x_group B0 { x_value = 1 }\nx_group B1 { x_group C { base = B0 } }\nx_group B2 { x_group C { base = B1 } }\nx_group B3 { x_group C { base = B2 } }\nx_group A4 { x_group C { base = B3 } }\nx_group A3 { base = A4.C }\nx_group A2 { base = A3.C }\nx_group A1 { base = A2.C }\n';
  for (const tail of ['x_group A0 { base = A1.C; drop x_value }', 'x_group A0 { base = A1.C }\n&A0 { drop x_value }', 'x_group A0 { base = A1.C }\ndrop A0.x_value', 'x_group A0 { base = A1.C; drop x_value }\ndrop A0']) {
    const r = project({ 'main.stencil': T + chain + tail });
    assert.deepEqual(codes(r), [], `${tail}: ${JSON.stringify(r.diags)}`);
  }
});

test('R13-2: branching descendant bases stay fast', () => {
  const head = 'x_group A {\n  base = A.C\n  drop x_missing\n  x_group C { base = A.D }\n  x_group D {}\n}\n';
  let t = Date.now();
  const r = project({ 'main.stencil': T + head + 'x_group Z {'.repeat(10) + 'x_keep = 1' + '}'.repeat(10) });
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
  assert.ok(codes(r).includes('C050'));
  const chain = Array.from({ length: 30 }, (_, i) => `x_group K${i} { ${i === 0 ? 'x_value = 1' : `base = K${i - 1}`} }`).join('\n');
  t = Date.now();
  const r2 = project({ 'main.stencil': T + chain + '\nx_group A {\n  base = A.C\n  drop x_value\n  x_group C { base = A.D }\n  x_group D { base = K29 }\n}\n' + 'x_group Z {'.repeat(9) + 'x_keep = 1' + '}'.repeat(9) });
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
  assert.deepEqual(codes(r2), [], JSON.stringify(r2.diags));
  assert.equal(r2.resolved.complete, true);
});

test('R13-3: an unnamed object wins over an import alias of the same name, as in inheritance', () => {
  for (const tail of ['x_group B { base = x_group.C; drop x_value }', 'x_group B { base = x_group.C }\n&B { drop x_value }', 'x_group B { base = x_group.C }\ndrop B.x_value', 'x_group B { base = x_group.C; drop x_value }\ndrop B']) {
    const r = project({ 'empty.stencil': H, 'main.stencil': T + 'x_group { x_group C { x_value = 1 } }\nimport "empty" as x_group\n' + tail });
    assert.deepEqual(codes(r), [], `${tail}: ${JSON.stringify(r.diags)}`);
  }
});

// ---- -------------------------------------
test('R14-1: unrelated patches of a base target do not validate a drop', () => {
  const files = { 'common.stencil': H + 'layer A { role = conductor }\nlayer B { base = A }', 'left.stencil': H + 'import "common" as c\n&c.A { masks = 2 }' };
  for (const drop of ['&c.B { drop masks }', 'drop c.B.masks']) {
    const f = { ...files, 'right.stencil': H + `import "common" as c\n${drop}` };
    for (const r of both(f, ['import "left" as l', 'import "right" as r'])) assert.ok(codes(r).includes('C050'), `${drop}: ${JSON.stringify(r.diags)}`);
    const w = project({ ...f, 'wrap.stencil': H + 'import "left" as l\nimport "right" as r', 'main.stencil': T + 'import "wrap" as w { rename { prefix = "W_" }; scale { xy = 2 } }' });
    assert.ok(codes(w).includes('C050'), `${drop} (wrapped)`);
  }
  // control: the importer of both may drop what left added
  const ok = project({ ...files, 'main.stencil': T + 'import "left" as l\n&l.c.B { drop masks }' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
});

test('R14-2: inheritance through several dropped objects', () => {
  for (const tail of ['drop A\ndrop B\ndrop C', 'drop C\ndrop B\ndrop A', 'drop B\ndrop C', 'drop C']) {
    for (const c of ['layer C { base = B; drop masks }', 'layer C { base = B }\n&C { drop masks }', 'layer C { base = B }\ndrop C.masks']) {
      const r = project({ 'main.stencil': T + 'layer A { role = conductor; masks = 2 }\nlayer B { base = A }\n' + c + '\n' + tail });
      assert.deepEqual(codes(r), [], `${c} / ${tail}: ${JSON.stringify(r.diags)}`);
    }
  }
});

test('R14-3: replacing a base target keeps what the original provided', () => {
  for (const repl of ['&G {\n  drop B\n  x_group B { x_keep = 2 }\n}', '&G {\n  drop B\n  x_group B { x_keep = 2 }\n}\n&G {\n  drop B\n  x_group B { x_more = 3 }\n}']) {
    const r = project({ 'main.stencil': T + 'x_group A { x_value = 1 }\nx_group G {\n  x_group B { base = A }\n  x_group C { base = G.B; drop x_value }\n}\n' + repl });
    assert.deepEqual(codes(r), [], `${repl}: ${JSON.stringify(r.diags)}`);
  }
});

test('R14-4: errors on surviving unnamed objects are reported, whatever is dropped', () => {
  for (const [base, code] of [['42', 'C040'], ['Missing', 'C021']]) {
    for (const tail of ['', '\ndrop Gone']) {
      const r = project({ 'main.stencil': T + `x_group { base = ${base}; x_value = 1 }\nx_group Gone { base = x_group }${tail}` });
      assert.ok(codes(r).includes(code), `${base}${tail}: ${JSON.stringify(r.diags)}`);
    }
  }
});

// ---- -------------------------------------
test('R15-1: a qualified drop prefers the local unnamed root over an import alias', () => {
  const r = project({ 'empty.stencil': H + 'x_leaf C { x_other = 2 }', 'main.stencil': T + 'x_group { x_leaf C { x_value = 1 } }\nimport "empty" as x_group\ndrop x_group.C' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(r.resolved.complete, true);
  const names = r.resolved.objects.map((o) => o.name);
  assert.ok(names.includes('C'), 'the imported C survives');
  const grp = r.resolved.objects.find((o) => o.kind === 'x_group');
  assert.deepEqual(grp.children, [], 'the local unnamed root lost its C');
});

test('R15-2: inheritance through a removed source child keeps its historical path', () => {
  for (const tail of ['drop A.L\ndrop A\ndrop B\ndrop C', 'drop A.L', 'drop A.L\ndrop B', '&B { base = Z }']) {
    for (const c of ['x_leaf C { base = B.L; drop x_value }', 'x_leaf C { base = B.L }\n&C { drop x_value }', 'x_leaf C { base = B.L }\ndrop C.x_value']) {
      const r = project({ 'main.stencil': T + 'x_group Z { }\nx_group A { x_leaf L { x_value = 1 } }\nx_group B { base = A }\n' + c + '\n' + tail });
      assert.ok(!codes(r).includes('C050'), `${c} / ${tail}: ${JSON.stringify(r.diags)}`);
    }
  }
});

test('R15-3: dropped descendants of unnamed roots are materialized too', () => {
  for (const c of ['x_leaf C { base = x_group.B.L; drop x_value }', 'x_leaf C { base = x_group.B.L }\n&C { drop x_value }']) {
    for (const rm of ['drop x_group.B', '&x_group { drop B }']) {
      const r = project({ 'main.stencil': T + `x_group A { x_leaf L { x_value = 1 } }\nx_group { x_group B { base = A } }\n${c}\n${rm}\ndrop C` });
      assert.deepEqual(codes(r), [], `${c} / ${rm}: ${JSON.stringify(r.diags)}`);
    }
  }
});

test('R14-4 follow-up: kind mismatches and cycles on unnamed roots are reported', () => {
  // (with Gone dropped, the cycle is broken: the unnamed root's base names a dropped object, C051)
  for (const [pre, plain, dropped] of [['layer K { role = conductor }\nx_group { base = K; x_value = 1 }', 'C040', 'C040'], ['x_group { base = Gone; x_value = 1 }', 'C041', 'C051']]) {
    for (const [tail, code] of [['', plain], ['\ndrop Gone', dropped]]) {
      const r = project({ 'main.stencil': T + `${pre}\nx_group Gone { base = x_group }${tail}` });
      assert.ok(codes(r).includes(code), `${pre}${tail}: ${JSON.stringify(r.diags)}`);
    }
  }
});

// ---- -------------------------------------
test('R16-1: historical base lookup terminates', () => {
  for (const [src, want] of [
    ['x_group Z { x_value = 1 }\nx_group A { base = A.C; drop x_value }\n&A { base = Z }', []],
    ['x_group Z { x_value = 1 }\nx_group A { base = A.C }\n&A { base = Z }\n&A { drop x_value }', []],
    ['x_group Z { x_value = 1 }\nx_group A { base = A.C }\n&A { base = Z }\ndrop A.x_value', []],
  ]) {
    const r = project({ 'main.stencil': T + src });
    assert.deepEqual(codes(r), want, `${src}: ${JSON.stringify(r.diags)}`);
  }
  const bad = project({ 'main.stencil': T + 'x_group A { base = A.C; drop x_missing }' });
  assert.ok(codes(bad).includes('C021'), JSON.stringify(bad.diags));
});

test('R16-2: local names win over an import alias at every level', () => {
  const files = { 'empty.stencil': H + 'x_leaf C { x_other = 2 }', 'lib.stencil': H + 'x_group { x_leaf C { x_value = 1 } }\nimport "empty" as x_group' };
  const r = project({ ...files, 'main.stencil': T + 'import "lib" as l\ndrop l.x_group.C' });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  // the imported top-level C survives with its own attribute (imported unnamed roots are not emitted)
  assert.deepEqual(r.resolved.objects.find((o) => o.name === 'C')?.attrs.x_other, 2);
  const ok = project({ ...files, 'main.stencil': T + 'import "lib" as l\nx_leaf Copy { base = l.x_group.C; drop x_value }' });
  assert.deepEqual(codes(ok), [], JSON.stringify(ok.diags));
  const bad = project({ ...files, 'main.stencil': T + 'import "lib" as l\nx_leaf Copy { base = l.x_group.C; drop x_other }' });
  assert.ok(codes(bad).includes('C050'), JSON.stringify(bad.diags));
});

// ---- -------------------------------------
test('R17-1: lookups are reused, not lost, across several base edges', () => {
  const pre = 'x_group A {\n  x_group C {\n    x_group D { x_value = 1 }\n  }\n}\nx_group B { base = A }\n';
  for (const tail of [
    'x_group Copy { base = B.C; drop x_value }\n&Copy { base = B.C.D }',
    'x_group Copy { base = B.C }\n&Copy { base = B.C.D }\n&Copy { drop x_value }',
    'x_group Copy { base = B.C }\n&Copy { base = B.C.D }\ndrop Copy.x_value',
    'x_group Copy { base = B.C; drop x_value }\n&Copy { base = B.C.D }\ndrop Copy',
  ]) {
    const r = project({ 'main.stencil': T + pre + tail });
    assert.deepEqual(codes(r), [], `${tail}: ${JSON.stringify(r.diags)}`);
    assert.equal(r.resolved.complete, true);
  }
});

// ---- : inheritance as a fixed point ----------
test('R18-1: cyclic historical bases still find every route', () => {
  const pre = 'x_group Z {}\nx_group X { x_group C { x_group D { x_value = 1 } } }\nx_group A { base = B }\nx_group B { base = A }\n&A { base = X }\n&A { base = Z }\n&B { base = Z }\n';
  for (const tail of [
    'x_group Copy { base = A.C; drop x_value }\n&Copy { base = B.C.D }\n&Copy { base = Z }',
    'x_group Copy { base = A.C }\n&Copy { base = B.C.D }\n&Copy { base = Z }\n&Copy { drop x_value }',
    'x_group Copy { base = A.C }\n&Copy { base = B.C.D }\n&Copy { base = Z }\ndrop Copy.x_value',
    'x_group Copy { base = A.C; drop x_value }\n&Copy { base = B.C.D }\n&Copy { base = Z }\ndrop Copy',
  ]) {
    const r = project({ 'main.stencil': T + pre + tail });
    assert.deepEqual(codes(r), [], `${tail}: ${JSON.stringify(r.diags)}`);
    assert.equal(r.resolved.complete, true);
  }
  // control: no route at all
  const bad = project({ 'main.stencil': T + 'x_group Z {}\nx_group Copy { base = Z; drop x_value }' });
  assert.ok(codes(bad).includes('C050'));
});

test('R18-2: repeated base edges do not blow up', () => {
  const src = ['x_group Z {}', 'x_group A0 { x_group C { x_value = 1 } }',
    ...Array.from({ length: 18 }, (_, i) => `x_group A${i + 1} { base = A${i} }\n&A${i + 1} { base = A${i} }\n&A${i + 1} { base = Z }`),
    'x_group Copy { base = A18.C; drop x_value }', '&Copy { base = Z }'].join('\n');
  const t = Date.now();
  const r = project({ 'main.stencil': T + src });
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(r.resolved.complete, true);
});

// ---- : bounded cost --------------------------
test('R19-1: drop validation cost stays small with many modules and deep unrelated nesting', () => {
  for (const [mods, depth, drop] of [[200, 200, true], [200, 200, false], [1, 250, true]]) {   // blocks nest at most 256 deep
    const files = { 'main.stencil': T + 'x_group C {'.repeat(depth) + 'x_keep = 1' + '}'.repeat(depth) };
    for (let i = 0; i < mods; i++) {
      files[`m${i}.stencil`] = H + `x_group A${i} { x_value = 1 }\nx_group B${i} { base = A${i}${drop ? '; drop x_value' : ''} }`;
      files['main.stencil'] += `\nimport "m${i}" as m${i}`;
    }
    const t = Date.now();
    const r = project(files);
    assert.ok(Date.now() - t < 5000, `${mods}/${depth}/${drop}: ${Date.now() - t} ms`);
    assert.deepEqual(codes(r), [], JSON.stringify(r.diags.slice(0, 3)));
    assert.equal(r.resolved.complete, true);
  }
});

// ---- : demand-driven views ------------------
test('R20-1: a shared tree of unproductive bases does not slow down unrelated drops', () => {
  for (const [nested, drop] of [[true, true], [true, false], [false, true]]) {
    const files = {
      'main.stencil': T,
      'common.stencil': H + 'x_group Z {}\n' + (nested ? 'x_group C {base=Z;'.repeat(200) : 'x_group C {base=Z;' + 'x_group C {'.repeat(199)) + 'x_keep=1' + '}'.repeat(200),
    };
    for (let i = 0; i < 50; i++) {
      files[`m${i}.stencil`] = H + 'import "common" as c\n' + `x_group A${i} {x_value=1}\n` + `x_group B${i} {base=A${i}${drop ? ';drop x_value' : ''}}`;
      files['main.stencil'] += `\nimport "m${i}" as m${i}`;
    }
    const t = Date.now();
    const r = project(files);
    assert.ok(Date.now() - t < 3000, `${nested}/${drop}: ${Date.now() - t} ms`);
    assert.deepEqual(codes(r), [], JSON.stringify(r.diags.slice(0, 3)));
    assert.equal(r.resolved.complete, true);
  }
});

// ---- : bounded memory; bounded nesting ------
test('R21-1: a demanded leaf under the deepest legal tree of bases stays small', () => {
  for (const leaf of ['x_group Leaf {base=V;drop x_value}', 'x_group Leaf {base=V}', 'x_group Leaf {base=V;x_value=2;drop x_value}']) {
    const src = 'x_group Z {}\nx_group V {x_value=1}\n' + 'x_group C {base=Z;'.repeat(250) + leaf + '}'.repeat(250);
    const t = Date.now();
    const r = project({ 'main.stencil': T + src });
    assert.ok(Date.now() - t < 3000, `${leaf}: ${Date.now() - t} ms`);
    assert.deepEqual(codes(r), [], JSON.stringify(r.diags.slice(0, 3)));
    assert.equal(r.resolved.complete, true);
  }
});

test('nesting deeper than 256 levels is an error, not a crash', () => {
  for (const src of ['x_group C {'.repeat(3000) + '}'.repeat(3000), 'X = ' + '('.repeat(5000) + '1' + ')'.repeat(5000), 'X = ' + '['.repeat(5000) + ']'.repeat(5000)]) {
    const r = project({ 'main.stencil': T + src });
    assert.ok(codes(r).includes('C001'), src.slice(0, 40));
    assert.equal(r.resolved.complete, false);
  }
});

// ---- -------------------------------------
test('R22-1: many demanded leaves under a deep tree of bases: incremental solving', () => {
  for (const [leaf, nest] of [['drop', true], ['none', true], ['own', true], ['drop', false]]) {
    const body = (i) => (leaf === 'drop' ? `x_group L${i} {base=V;drop x_value}` : leaf === 'none' ? `x_group L${i} {base=V}` : `x_group L${i} {base=V;x_value=2;drop x_value}`);
    const leaves = Array.from({ length: 200 }, (_, i) => body(i)).join(';');
    const src = 'x_group Z {}\nx_group V {x_value=1}\n' + (nest ? 'x_group C {base=Z;'.repeat(250) + leaves + '}'.repeat(250) : leaves);
    const t = Date.now();
    const r = project({ 'main.stencil': T + src });
    assert.ok(Date.now() - t < 3000, `${leaf}/${nest}: ${Date.now() - t} ms`);
    assert.deepEqual(codes(r), [], JSON.stringify(r.diags.slice(0, 3)));
    assert.equal(r.resolved.complete, true);
  }
});

test('R22 follow-up: long operator chains are an error, not a crash', () => {
  for (const src of ['X = ' + '-'.repeat(20000) + '1', 'X = ' + Array(3000).fill('1').join(' + '), 'X = ' + Array(3000).fill('2').join(' * ')]) {
    const r = project({ 'main.stencil': T + src });
    assert.ok(codes(r).includes('C001'), src.slice(0, 30));
  }
  assert.deepEqual(codes(project({ 'main.stencil': T + 'X = ' + '-'.repeat(200) + '1\nY = ' + Array(200).fill('1').join(' + ') })), []);
});

test('R23 follow-up: composed expression depth is bounded too', () => {
  let expr = '1';
  for (let i = 0; i < 64; i++) expr = '-'.repeat(200) + '(' + expr + ')';
  const r = project({ 'main.stencil': T + 'X = ' + expr });
  assert.ok(codes(r).includes('C001'), JSON.stringify(r.diags.slice(0, 2)));
  let ok = '1';
  for (let i = 0; i < 64; i++) ok = '-(' + ok + ')';
  assert.deepEqual(codes(project({ 'main.stencil': T + 'X = ' + ok })), []);
});
