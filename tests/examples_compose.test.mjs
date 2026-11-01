// The multi-file examples and transplant demos, with their expected outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveProject } from '../core/resolve.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const run = (main) => resolveProject({ main, load: (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null) });
const errs = (r) => r.diags.filter((d) => d.severity === 'error');
const obj = (r, n) => r.resolved.objects.find((o) => o.name === n);

test('GT2N as shipped (backside power) composes from four modules', () => {
  const r = run('pdk/gt2n/bspdn.stencil');
  assert.deepEqual(errs(r), []);
  assert.deepEqual(r.resolved.modules.map((m) => m.as), ['bs', 'rail', 'dev', 'fs']);
  assert.equal(obj(r, 'BM1').attrs.side, 'back');
  assert.ok(obj(r, 'BV0').attrs.order < obj(r, 'BPR').attrs.order && obj(r, 'BPR').attrs.order < obj(r, 'ACT').attrs.order);
});

test('GT2N front-side power is the same modules minus the backside', () => {
  const r = run('pdk/gt2n/fspdn.stencil');
  assert.deepEqual(errs(r), []);
  assert.equal(obj(r, 'BM1'), undefined);
  assert.equal(obj(r, 'BPR').attrs.pitch, undefined);
  assert.ok(obj(r, 'VBPR_CS'));
});



test('the gear-ratio example composes; a 1/2 gear ratio fails the front side\'s own check', () => {
  assert.deepEqual(errs(run('compose/gear_ratio.stencil')), []);
  const src = readFileSync(join(root, 'compose/gear_ratio.stencil'), 'utf8').replace('GEAR = 2/3', 'GEAR = 1/2');
  const r = resolveProject({ main: 'compose/gear_ratio.stencil', load: (p) => (p === 'compose/gear_ratio.stencil' ? src : existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null) });
  assert.ok(errs(r).some((d) => d.code === 'V100' && /M1_FITS/.test(d.message)));
});



// ---- ASAP7 and PROBE3 as modules, and the transplant demos ---------------------------
const runEdited = (main, from, to) => {
  const text = readFileSync(join(root, main), 'utf8');
  assert.ok(text.includes(from), from);
  return resolveProject({ main, load: (p) => (p === main ? text.replace(from, to) : existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null) });
};
const failed = (r) => errs(r).filter((d) => d.code === 'V100').map((d) => d.message.match(/check (\w+)/)[1]);

test('ASAP7 composes from its device, front-side and upper-metal modules', () => {
  const r = run('pdk/asap7/asap7.stencil');
  assert.deepEqual(errs(r), []);
  assert.deepEqual(r.resolved.modules.map((m) => m.as), ['dev', 'fs', 'beol']);
  const order = (n) => obj(r, n).attrs.order;
  assert.ok(order('FIN') < order('V0') && order('V0') < order('M1') && order('M3') < order('M4') && order('Pad') < order('BOUNDARY'));
  assert.equal(obj(r, 'VIA0').attrs.upper.ref, 'M1');
  assert.equal(obj(r, 'VIA34').attrs.lower.ref, 'M3');
  const site = obj(r, 'asap7sc7p5t');
  assert.deepEqual(site.children.map((c) => `${c.kind} ${c.name}`).sort(), ['band n', 'band p', 'rail VDD', 'rail VSS', 'tracks M2']);
});

test('PROBE3 composes from device and front side; the row height follows the track count', () => {
  const r = run('pdk/probe3/probe3_finfet.stencil');
  assert.deepEqual(errs(r), []);
  assert.equal(obj(r, 'CORE').attrs.height, 288);                       // 144 nm on the 0.5 nm grid: (4 + 2) x 24 nm
  assert.equal(obj(r, 'CA_M0').attrs.upper.ref, 'M0');
  const r5 = runEdited('pdk/probe3/probe3_finfet.stencil', 'RT   = 4 ', 'RT   = 5 ');
  assert.deepEqual(errs(r5), []);
  assert.equal(obj(r5, 'CORE').attrs.height, 336);                      // 7 x 24 nm
});

test('transplant: PROBE3 devices on the ASAP7 routing grid', () => {
  const main = 'transplant/probe3_asap7_grid.stencil';
  const r = run(main);
  assert.deepEqual(errs(r), []);
  assert.equal(r.resolved.grid_nm, '1/4');
  assert.equal(obj(r, 'PC').attrs.pitch, 180);                          // the PROBE3 gate pitch, 45 nm
  assert.equal(obj(r, 'M2').attrs.pitch, 144);                          // the ASAP7 track pitch, 36 nm
  assert.equal(obj(r, 'CORE').attrs.height, 864);                       // 6 x 36 nm
  assert.equal(obj(r, 'CA_M0').attrs.upper.ref, 'M1');                  // the PROBE3 contact lands on ASAP7 M1
  assert.equal(obj(r, 'M1_CELL_TRK').attrs.pitch, 180);                 // in-cell M1 follows the PROBE3 gates
  assert.equal(obj(r, 'M0'), undefined);                                // no PROBE3 metal is left
  const bad = runEdited(main, 'BOUNDARY = OUTLINE\n', 'BOUNDARY = OUTLINE; CPP = 34nm\n');
  assert.deepEqual(failed(bad), ['M1_ON_GATE_GRID']);
});

test('transplant: GT2N devices on the PROBE3 routing grid', () => {
  const main = 'transplant/gt2n_device_probe3_grid.stencil';
  const r = run(main);
  assert.deepEqual(errs(r), []);
  assert.equal(obj(r, 'GATE').attrs.width, 28);                         // the GT2N gate, 14 nm
  assert.equal(obj(r, 'M0').attrs.pitch, 48);                           // the PROBE3 M0 pitch, 24 nm
  assert.equal(obj(r, 'CVG').attrs.upper.ref, 'M0');
  assert.equal(obj(r, 'BPR'), undefined);                               // no buried rail: the rails are on M0
  const bad = runEdited(main, 'import "../pdk/probe3/frontside" as fs\n', 'import "../pdk/probe3/frontside" as fs { MP0 = 28nm }\n');
  assert.deepEqual(failed(bad), ['ROW_TRACKS']);
});
