// GT2N rules checked against the wording of the GT2N DRC deck. Each case
// runs the real composed GT2N technology through the reference checker on a
// geometry whose verdict is read off the source DRC deck
// (PDK/GT2N/icv_runset/Include). Grid 0.5nm: 1 DBU = 0.5nm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProject } from '../core/resolve.js';
import { checkRules } from '../core/rulecheck.js';

const EX = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const r = resolveProject({ main: 'pdk/gt2n/bspdn.stencil', load: (p) => { try { return readFileSync(join(EX, p), 'utf8'); } catch { return null; } } });
assert.equal(r.diags.filter((d) => d.severity === 'error').length, 0);
assert.equal(r.resolved.grid_nm, '1/2');
const only = (name) => ({ ...r.resolved, objects: r.resolved.objects.filter((o) => o.kind !== 'rule' || o.name === name) });
const R = (layer, x0, y0, x1, y1) => ({ layer, rect: [x0, y0, x1, y1] });
const verdict = (rule, shapes) => { const c = checkRules(only(rule), { shapes }); assert.ok(c.complete, JSON.stringify(c.unsupported)); return c.violations.length; };

test('VBPR.3 interacting(VBPR, GCUT, include_touch = NONE): touching passes, overlap fails', () => {
  assert.equal(verdict('VBPR_NO_GCUT', [R('VBPR', 0, 0, 40, 40), R('GCUT', 40, 0, 80, 40)]), 0);
  assert.equal(verdict('VBPR_NO_GCUT', [R('VBPR', 0, 0, 40, 40), R('GCUT', 40, 40, 80, 80)]), 0);
  assert.equal(verdict('VBPR_NO_GCUT', [R('VBPR', 0, 0, 40, 40), R('GCUT', 39, 0, 80, 40)]), 1);
});

test('M0.5 external_corner1(M0, distance < 0.015, CONVEX_TO_CONVEX)', () => {
  assert.equal(verdict('M0_CORNER', [R('M0', 0, 0, 20, 20), R('M0', 38, 44, 58, 64)]), 0);   // 15nm exactly
  assert.equal(verdict('M0_CORNER', [R('M0', 0, 0, 20, 20), R('M0', 38, 43, 58, 63)]), 1);   // sqrt(853)/2 < 15nm
  assert.equal(verdict('M0_CORNER', [R('M0', 0, 0, 20, 20), R('M0', 22, 10, 42, 30)]), 0);   // side by side: not a corner pair
});

test('V0.6 external_corner1(V0, distance < 0.018, CONVEX_TO_CONVEX)', () => {
  assert.equal(verdict('V0_CORNER', [R('V0', 0, 0, 20, 20), R('V0', 41, 68, 61, 88)]), 0); // gx 21, gy 48: > 18nm
  assert.equal(verdict('V0_CORNER', [R('V0', 0, 0, 20, 20), R('V0', 41, 48, 61, 68)]), 1);   // sqrt(441 + 784) = 35 DBU < 36
});

test('VG.5 not_inside(VG, GATE, include_touch = ALL) and its edge-coincidence text', () => {
  const gate = R('GATE', 0, 0, 32, 400);
  assert.equal(verdict('VG_IN_GATE', [R('VG', 0, 100, 32, 140), gate]), 0);
  assert.equal(verdict('VG_IN_GATE', [R('VG', 0, 390, 32, 410), gate]), 1);
  assert.equal(verdict('VG_GATE_EDGES', [R('VG', 0, 100, 32, 140), gate]), 0);
  assert.equal(verdict('VG_GATE_EDGES', [R('VG', 2, 100, 30, 140), gate]), 1);              // inside, edges do not coincide
});

test('VSD.5 not_inside(VSD, M0, include_touch = ALL)', () => {
  assert.equal(verdict('VSD_IN_LAND', [R('VSD', 10, 0, 30, 20), R('M0', 0, 0, 100, 20)]), 0);
  assert.equal(verdict('VSD_IN_LAND', [R('VSD', 90, 0, 110, 20), R('M0', 0, 0, 100, 20)]), 1);
});

// Cell edges against the GDS of gt2_6t_inv_x1_w31_lvt (2 CPP wide), in nm:
//   GATE 3/0 x -7..7 and 77..91, y 0..144; DUMMY 4/0 the same; GCUT 5/0 x -7..91, y -5..5 and 139..149.
test('GT2N cell-edge features expand to the inverter GDS (DBU = 0.5nm)', async () => {
  const { expandSite } = await import('../core/template.js');
  const t = expandSite(r.resolved, 'gt2_6t', { units: 2 });
  assert.deepEqual(t.problems, []);
  const nm = (e) => [e.layer, e.x0 / 2, e.y0 / 2, e.x1 / 2, e.y1 / 2];
  assert.deepEqual(t.edges.map(nm), [
    ['DUMMY', -7, 0, 7, 144], ['DUMMY', 77, 0, 91, 144],
    ['GATE', -7, 0, 7, 144], ['GATE', 77, 0, 91, 144],
    ['GCUT', -7, 139, 91, 149], ['GCUT', -7, -5, 91, 5],
  ]);
});

test('GATE.1 / SDCON.1 are exact widths (distance == 0.014 / 0.016)', () => {
  assert.equal(verdict('GATE_W', [R('GATE', 0, 0, 28, 288)]), 0);
  assert.equal(verdict('GATE_W', [R('GATE', 0, 0, 30, 288)]), 1);     // wider fails too
  assert.equal(verdict('SDCON_W', [R('SDCON', 0, 0, 32, 100)]), 0);
  assert.equal(verdict('SDCON_W', [R('SDCON', 0, 0, 31, 100)]), 1);
});

