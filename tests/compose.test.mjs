// Core 0.2 composition: imports, bindings, rename, GDS shift, scale,
// placement, cascading drops across modules, checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, resolvePath } from '../core/resolve.js';

function project(files, main = 'main.stencil') {
  return resolveProject({ main, load: (p) => files[p] ?? null });
}
const errors = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errors(r).map((d) => d.code);
const obj = (r, name) => r.resolved.objects.find((o) => o.name === name);
const H = 'stencil 0.1\n';

const FRONT = H + [
  'MP1 = required',
  'LANDING = required',
  'layer V0 { role = cut; gds = [18, 0] }',
  'layer M1 { role = conductor; direction = vertical; width = 14nm; pitch = MP1; gds = [19, 0] }',
  'connector VIA0 { lower = LANDING; cut = V0; upper = M1; size = 12nm }',
  'rule M1_SP { kind = spacing; on = M1; value = 15nm }',
  'check M1_FITS { holds = M1.pitch >= M1.width + M1_SP.value; message = "M1 pitch too small for width + spacing" }',
].join('\n');

const DEVICE = H + [
  'CPP = 45nm',
  'layer CH { role = channel; gds = [2, 0] }',
  'layer GATE { role = conductor; direction = vertical; gds = [7, 0] }',
  'layer MD { role = conductor; gds = [8, 0] }',
  'stratum DEV { layers = [CH, MD] }',
].join('\n');

test('module paths resolve from the root, or relative with ./', () => {
  assert.equal(resolvePath('main.stencil', 'gt2n/device'), 'gt2n/device.stencil');
  assert.equal(resolvePath('gt2n/full.stencil', './device'), 'gt2n/device.stencil');
  assert.equal(resolvePath('a/b/c.stencil', '../x.stencil'), 'a/x.stencil');
});

test('import with bindings: parameters flow from the importer', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm; stack = [dev, fs] }\nimport "device" as dev\nimport "front" as fs { MP1 = 2/3 * dev.CPP; LANDING = dev.MD }',
    'device.stencil': DEVICE,
    'front.stencil': FRONT,
  });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(obj(r, 'M1').attrs.pitch, 30);
  assert.deepEqual(obj(r, 'VIA0').attrs.lower, { ref: 'MD' });
  // stack order: device layers below the front-side layers
  assert.deepEqual(['CH', 'GATE', 'MD', 'V0', 'M1'].map((n) => obj(r, n).attrs.order), [1, 2, 3, 4, 5]);
  assert.equal(obj(r, 'CH').attrs.side, 'device');
  assert.equal(obj(r, 'M1').attrs.side, 'front');
  assert.equal(obj(r, 'M1').module, 'fs');
});

test('a failing check reports both sides of the comparison', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm; stack = [dev, fs] }\nimport "device" as dev\nimport "front" as fs { MP1 = 2/3 * 42nm; LANDING = dev.MD }',
    'device.stencil': DEVICE,
    'front.stencil': FRONT,
  });
  const d = errors(r).find((x) => x.code === 'V100');
  assert.ok(d, JSON.stringify(r.diags));
  assert.equal(d.file, 'front.stencil');
  assert.match(d.message, /28nm >= 29nm/);
  assert.match(d.hint, /MP1 \(main\.stencil:4\)/);
});

test('unbound required parameter and unknown binding are reported at the import', () => {
  const r = project({
    'main.stencil': H + 'import "front" as fs { MP1 = 30nm; MPX = 1nm }',
    'front.stencil': FRONT,
  });
  const c = codes(r);
  assert.ok(c.includes('C013'), JSON.stringify(r.diags));
  assert.ok(c.includes('C012'));
  assert.ok(errors(r).some((d) => d.code === 'C012' && d.file === 'main.stencil'));
});

test('name clashes between modules are errors; rename and prefix fix them', () => {
  const other = H + 'layer M1 { role = conductor; gds = [119, 0] }\nlayer M2 { role = conductor; gds = [120, 0] }';
  const clash = project({
    'main.stencil': H + 'import "a" as a\nimport "b" as b',
    'a.stencil': H + 'layer M1 { role = conductor; gds = [19, 0] }',
    'b.stencil': other,
  });
  assert.ok(codes(clash).includes('C060'));
  const renamed = project({
    'main.stencil': H + 'import "a" as a\nimport "b" as b { rename { M1 = BM1 } }',
    'a.stencil': H + 'layer M1 { role = conductor; gds = [19, 0] }',
    'b.stencil': other,
  });
  assert.deepEqual(codes(renamed), [], JSON.stringify(renamed.diags));
  assert.ok(obj(renamed, 'BM1') && obj(renamed, 'M1') && obj(renamed, 'M2'));
  const prefixed = project({
    'main.stencil': H + 'import "a" as a\nimport "b" as b { rename { prefix = "PK_" } }',
    'a.stencil': H + 'layer M1 { role = conductor; gds = [19, 0] }',
    'b.stencil': other,
  });
  assert.deepEqual(codes(prefixed), []);
  assert.ok(obj(prefixed, 'PK_M1') && obj(prefixed, 'PK_M2'));
});

test('GDS collisions are errors; gds { shift } moves a whole module', () => {
  const files = {
    'a.stencil': H + 'layer M0 { role = conductor; gds = [20, 0] }',
    'b.stencil': H + 'layer M2 { role = conductor; gds = [20, 0] }',
  };
  const clash = project({ ...files, 'main.stencil': H + 'import "a" as a\nimport "b" as b' });
  assert.ok(codes(clash).includes('V021'), JSON.stringify(clash.diags));
  const shifted = project({ ...files, 'main.stencil': H + 'import "a" as a\nimport "b" as b { gds { shift = 1000 } }' });
  assert.deepEqual(codes(shifted), []);
  assert.deepEqual(obj(shifted, 'M2').attrs.gds, [1020, 0]);
});

test('scale multiplies the module\'s own length literals, exactly; z attributes use scale.z', () => {
  const beol = H + [
    'MP = 200nm',
    'layer MET1 { role = conductor; direction = horizontal; width = 90nm; pitch = MP; gds = [31, 0] }',
    'rule MET1_A { kind = area; on = MET1; value = 200nm * 100nm }',
    'figure F { layer = MET1; width = 90nm; thickness = 100nm }',
  ].join('\n');
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "beol" as be { scale { xy = 36/200; z = 1/2; snap = true } }',
    'beol.stencil': beol,
  });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(obj(r, 'MET1').attrs.pitch, 36);
  assert.equal(obj(r, 'MET1').attrs.width, 16);           // 16.2 snapped to the 1nm grid
  assert.equal(obj(r, 'MET1_A').attrs.value, 648);         // 36nm * 18nm
  assert.equal(obj(r, 'F').attrs.thickness, 50);           // z factor
  const strict = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "beol" as be { scale { xy = 36/200 } }',
    'beol.stencil': beol,
  });
  const off = errors(strict).find((d) => d.code === 'C070');
  assert.ok(off && off.file === 'beol.stencil', JSON.stringify(strict.diags));
  assert.match(off.hint, /snap = true/);
});

test('values bound by the importer are not rescaled', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "m" as m { P = 40nm; scale { xy = 1/2 } }',
    'm.stencil': H + 'P = required\nlayer L { role = conductor; pitch = P; width = 20nm }',
  });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(obj(r, 'L').attrs.pitch, 40);
  assert.equal(obj(r, 'L').attrs.width, 10);
});

test('below / above / level_with place layers; a delta can insert under a stack', () => {
  const r = project({
    'main.stencil': H + [
      'technology { grid = 1nm; stack = [fs] }',
      'import "front" as fs { MP1 = 30nm; LANDING = MD }',
      'layer MD { role = conductor; below = fs.V0 }',
      'layer BM0 { role = conductor; below = MD; side = back }',
      'layer GATE { role = conductor; level_with = MD }',
    ].join('\n'),
    'front.stencil': FRONT,
  });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  const ord = (n) => obj(r, n).attrs.order;
  assert.ok(ord('BM0') < ord('MD') && ord('MD') < ord('V0') && ord('V0') < ord('M1'));
  assert.equal(ord('GATE'), ord('MD'));
  assert.equal(obj(r, 'BM0').attrs.side, 'back');
});

test('patching and dropping imported objects; drops cascade across modules', () => {
  const r = project({
    'main.stencil': H + [
      'import "device" as dev',
      'import "front" as fs { MP1 = 30nm; LANDING = dev.MD }',
      '&fs.M1 { masks = 2 }',
      'drop fs.V0',
    ].join('\n'),
    'device.stencil': DEVICE,
    'front.stencil': FRONT,
  });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.equal(obj(r, 'M1').attrs.masks, 2);
  assert.equal(obj(r, 'V0'), undefined);
  assert.equal(obj(r, 'VIA0'), undefined);                 // its cut was dropped
  assert.ok(r.diags.some((d) => d.code === 'I020' && /VIA0/.test(d.message)));
});

test('import cycles and missing modules are errors', () => {
  const cyc = project({ 'main.stencil': H + 'import "a" as a', 'a.stencil': H + 'import "main" as m' });
  assert.ok(codes(cyc).includes('C010'));
  const missing = project({ 'main.stencil': H + 'import "nope" as n' });
  assert.ok(codes(missing).includes('C011'));
});

test('qualified references to unknown names get a did-you-mean', () => {
  const r = project({
    'main.stencil': H + 'import "device" as dev\nX = dev.CPX',
    'device.stencil': DEVICE,
  });
  const d = errors(r).find((x) => x.code === 'C021');
  assert.equal(d.file, 'main.stencil');
  assert.equal(d.hint, "did you mean 'CPP'?");
});

test('std/0 additions: area values, axis, x_ rule kinds, regions in rules, geometric signatures', () => {
  const r = project({
    'main.stencil': H + [
      'technology { grid = 1nm }',
      'layer M1 { role = conductor }',
      'layer CH { role = channel }',
      'region R { from = grow(CH, 5nm) }',
      'rule A { kind = area; on = M1; value = 288nm * 10nm }',
      'rule B { kind = enclosure; on = [R, M1]; axis = x; value = 3nm }',
      'rule C { kind = x_lab_corner; on = M1; value = 4nm }',
      'layer BAD { role = marker; from = gaps(CH, diagonal) }',
    ].join('\n'),
  });
  assert.deepEqual(codes(r), ['V003'], JSON.stringify(r.diags));   // only the bad gaps() axis
  assert.equal(obj(r, 'A').attrs.value, 2880);
  assert.ok(r.diags.some((d) => d.code === 'W001' && /x_lab_corner/.test(d.message)));
});

test('hardening: rule values typed by kind, failing checks, placements, safe integers, complete flag', () => {
  const r = project({
    'main.stencil': H + [
      'technology { grid = 1nm }',
      'layer M1 { role = conductor }',
      'layer M2 { role = conductor; below = M3 }',
      'layer M3 { role = conductor; below = M2 }',
      'rule A { kind = area; on = M1; value = 2nm }',
      'rule S { kind = spacing; on = M1; value = 2nm * 2nm }',
      'check NO { holds = 1 > 2 }',
      'check BAD { holds = M1.nothing > 2nm }',
      'layer BIG { role = conductor; width = 9007199254740993nm }',
    ].join('\n'),
  });
  const c = codes(r);
  for (const code of ['V034', 'V100', 'V101', 'V031', 'C071']) assert.ok(c.includes(code), `${code} missing: ${JSON.stringify(r.diags.map((d) => d.code + ' ' + d.message))}`);
  assert.equal(r.resolved.complete, false);
  assert.equal(obj(r, 'BIG').attrs.width, '9007199254740993');
});

test('snapping is reported, and a dropped dependency turns a check into a warning', () => {
  const r = project({
    'main.stencil': H + 'technology { grid = 1nm }\nimport "m" as m { scale { xy = 1/3; snap = true } }\ndrop m.M1',
    'm.stencil': H + 'layer M1 { role = conductor; width = 20nm }\nlayer M2 { role = conductor; width = 10nm }\ncheck C { holds = M1.width > 1nm }',
  });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  assert.ok(r.diags.some((d) => d.code === 'I030' && /10nm -> 3nm/.test(d.message)), JSON.stringify(r.diags));
  assert.ok(r.diags.some((d) => d.code === 'W040'));
  assert.equal(r.resolved.complete, true);
});

test('a value computed from an object that the cascade removes later is an error', () => {
  const r = project({
    'main.stencil': H + [
      'technology { grid = 1nm }',
      'layer V0 { role = cut }',
      'layer M0 { role = conductor; width = 20nm }',
      'connector C { lower = M0; cut = V0; upper = M1; size = 10nm }',
      'layer M1 { role = conductor; width = C.size }',
      'drop V0',
    ].join('\n'),
  });
  // C is cascaded (its cut was dropped); M1.width was computed from C.size before that.
  assert.ok(errors(r).some((d) => d.code === 'C051' && /M1\.width/.test(d.message)), JSON.stringify(r.diags));
});

test('sibling modules patching one shared object differently is a conflict (C052)', () => {
  const r = project({
    'main.stencil': H + 'import "a" as a\nimport "b" as b',
    'a.stencil': H + 'import "base" as base\n&base.M { width = 10nm }',
    'b.stencil': H + 'import "base" as base\n&base.M { width = 12nm }',
    'base.stencil': H + 'layer M { role = conductor; width = 8nm }',
  });
  assert.ok(codes(r).includes('C052'), JSON.stringify(r.diags));
});

test('== compares object identity, not names; mod() works in checks', () => {
  const r = project({
    'main.stencil': H + [
      'technology { grid = 1nm }',
      'import "x" as a { rename { prefix = "A_" } }',
      'import "x" as b { rename { prefix = "B_" } }',
      'check SAME { holds = a.L == b.L; severity = warning }',
      'check ROW { holds = mod(144nm, 26nm) == 0nm; message = "row is not a whole number of M0 pitches" }',
    ].join('\n'),
    'x.stencil': H + 'layer L { role = conductor; gds = [1, 0] }',
  });
  assert.ok(r.diags.some((d) => d.code === 'V100' && d.severity === 'warning' && /SAME/.test(d.message)), JSON.stringify(r.diags));
  assert.ok(r.diags.some((d) => d.code === 'V100' && /144nm, 26nm\) == 0nm is 14nm == 0nm/.test(d.message)), JSON.stringify(r.diags));
});
