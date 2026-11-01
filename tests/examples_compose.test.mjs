// The multi-file examples, with their expected outcomes.
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



test('the ASAP7 and PROBE3 FinFET descriptions resolve without errors', () => {
  for (const main of ['pdk/asap7/asap7.stencil', 'pdk/probe3/probe3_finfet.stencil']) {
    const r = run(main);
    assert.deepEqual(errs(r), [], main);
  }
});
