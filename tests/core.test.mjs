// Core front-end tests. Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveSource } from '../core/resolve.js';
import { hashResolved } from '../core/canon.js';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', 'examples');

const HEAD = 'stencil 0.1\ntechnology { grid = 1nm }\n';
const run = (body, head = HEAD) => resolveSource(head + body);
const errors = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errors(r).map((d) => d.code);
const obj = (r, name) => r.resolved.objects.find((o) => o.name === name);

test('every example resolves without errors or warnings', () => {
  for (const f of readdirSync(examples).filter((f) => f.endsWith('.stencil'))) {
    const r = resolveSource(readFileSync(join(examples, f), 'utf8'));
    assert.deepEqual(r.diags, [], `${f}: ${JSON.stringify(r.diags)}`);
  }
});

test('exact arithmetic: 2/3 * 45nm is 30nm', () => {
  const r = run('CPP = 45nm\nlayer M1 { role = conductor; pitch = 2/3 * CPP }');
  assert.deepEqual(codes(r), []);
  assert.equal(obj(r, 'M1').attrs.pitch, 30);
});

test('off-grid length is an error with the nearest legal values', () => {
  const r = run('layer M1 { role = conductor; pitch = 2/3 * 45nm }', 'stencil 0.1\ntechnology { grid = 0.7nm }\n');
  const d = errors(r).find((x) => x.code === 'C070');
  assert.ok(d, JSON.stringify(r.diags));
  assert.match(d.hint, /nearest/);
  assert.equal(obj(r, 'M1').invalid, true);
});

test('snap() puts a value on the grid', () => {
  const r = run('layer M1 { role = conductor; pitch = snap(2/3 * 44nm) }');
  assert.deepEqual(codes(r), []);
  assert.equal(obj(r, 'M1').attrs.pitch, 29);
});

test('a length without a unit gets a hint', () => {
  const r = run('layer M1 { role = conductor; width = 20 }');
  const d = errors(r).find((x) => x.code === 'V003');
  assert.match(d.hint, /20nm/);
});

test('adding a number to a length is a dimension error', () => {
  assert.ok(codes(run('A = 20nm + 3')).includes('C031'));
});

test('misspelled attribute: did you mean', () => {
  const d = errors(run('layer M1 { role = conductor; pich = 20nm }')).find((x) => x.code === 'V002');
  assert.equal(d.hint, "did you mean 'pitch'?");
  assert.equal(d.line, 3);
});

test('misspelled enum value: did you mean', () => {
  const d = errors(run('layer M1 { role = conductr }'))[0];
  assert.equal(d.hint, "did you mean 'conductor'?");
});

test('unknown layer reference: did you mean', () => {
  const r = run('layer M1 { role = conductor }\nsite S { width = 1nm; height = 1nm\n rail VDD { layer = M11; edge = top } }');
  const d = errors(r).find((x) => x.code === 'C021');
  assert.equal(d.hint, "did you mean 'M1'?");
});

test('parameter cycle is reported', () => {
  assert.ok(codes(run('A = B\nB = A')).includes('C030'));
});

test('a syntax error does not stop the rest of the file', () => {
  const r = run('layer M0 { role = conductor }\nlayer M1 { role = = }\nlayer M2 { role = conductor }');
  assert.ok(codes(r).includes('C001'));
  assert.ok(obj(r, 'M0') && obj(r, 'M2'));
});

test('an unclosed block still resolves what it has', () => {
  const r = run('layer M0 { role = conductor; pitch = 40nm');
  assert.equal(obj(r, 'M0').attrs.pitch, 40);
  assert.ok(codes(r).includes('C001'));
});

test('keyword-style attributes get a hint', () => {
  const d = errors(run('layer M0 {\n role conductor\n}')).find((x) => x.code === 'C001');
  assert.match(d.hint, /role = conductor/);
});

test('patch then base: derived objects see patched children', () => {
  const r = run([
    'layer M0 { role = conductor }',
    'stratum DEV { layers = [M0] }',
    'site CORE { width = 50nm; height = 200nm; rail VDD { layer = M0; edge = top } }',
    'site TALL { base = CORE; height = 300nm }',
    '&CORE { band n { stratum = DEV; y = 0nm .. 100nm } }',
  ].join('\n'));
  assert.deepEqual(codes(r), []);
  const tall = obj(r, 'TALL');
  assert.equal(tall.attrs.height, 300);
  assert.equal(tall.attrs.width, 50);
  assert.deepEqual(tall.children.map((c) => c.name).sort(), ['VDD', 'n']);
});

test('patching a nested child merges by name', () => {
  const r = run([
    'layer M0 { role = conductor }',
    'layer BM0 { role = conductor }',
    'site CORE { width = 50nm; height = 200nm; rail VDD { layer = M0; edge = top } }',
    'site BS { base = CORE\n rail VDD { layer = BM0 } }',
  ].join('\n'));
  assert.deepEqual(codes(r), []);
  const vdd = obj(r, 'BS').children.find((c) => c.name === 'VDD');
  assert.deepEqual(vdd.attrs, { layer: { ref: 'BM0' }, edge: 'top' });
});

test('inheritance cycle is reported', () => {
  const r = run('site A { base = B; width = 1nm; height = 1nm }\nsite B { base = A; width = 1nm; height = 1nm }');
  assert.ok(codes(r).includes('C041'));
});

test('drop cascades through references and reports what went', () => {
  const r = run('layer M0 { role = conductor }\nlayer M1 { role = conductor }\ndrop M0\nsite S { width = 1nm; height = 1nm\n rail VDD { layer = M0; edge = top }\n pins = [M0, M1] }');
  assert.deepEqual(codes(r), [], JSON.stringify(r.diags));
  const site = obj(r, 'S');
  assert.deepEqual(site.children, []);
  assert.deepEqual(site.attrs.pins, [{ ref: 'M1' }]);
  assert.ok(r.diags.some((d) => d.code === 'I020' && /VDD/.test(d.message)));
});

test('a numeric dependency on a dropped object is an error', () => {
  const r = run('layer M0 { role = conductor; width = 20nm }\nlayer M1 { role = conductor; width = M0.width }\ndrop M0');
  assert.ok(codes(r).includes('C051'), JSON.stringify(r.diags));
});

test('connector cut must sit between lower and upper', () => {
  const r = run('layer M0 { role = conductor }\nlayer M1 { role = conductor }\nlayer V0 { role = cut }\nconnector X { lower = M0; cut = V0; upper = M1 }');
  assert.ok(codes(r).includes('V010'));
});

test('names are unique across kinds', () => {
  assert.ok(codes(run('layer V0 { role = cut }\nconnector V0 { lower = V0; cut = none; upper = V0 }')).includes('C020'));
});

test('layer order follows the file', () => {
  const r = run('layer A { role = conductor }\nlayer B { role = cut }\nlayer C { role = conductor }');
  assert.deepEqual(['A', 'B', 'C'].map((n) => obj(r, n).attrs.order), [1, 2, 3]);
});

test('hash ignores comments and layout but not values', async () => {
  const a = await hashResolved(run('layer M0 { role = conductor; pitch = 40nm }').resolved);
  const b = await hashResolved(run('# comment\nlayer M0 {\n  role  = conductor\n  pitch = 40nm\n}').resolved);
  const c = await hashResolved(run('layer M0 { role = conductor; pitch = 42nm }').resolved);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// Apply every non-overlapping fix, as the playground's "Fix all" does.
function applyFixes(src, diags) {
  // Right to left; at equal positions the later fix goes first, so the earlier one's text ends up in front.
  const fixes = diags.filter((d) => d.fix).map((d, i) => ({ ...d.fix, i })).sort((a, b) => b.from - a.from || b.i - a.i);
  let out = src;
  let limit = Infinity;
  for (const f of fixes) {
    if (f.to > limit) continue;
    out = out.slice(0, f.from) + f.insert + out.slice(f.to);
    limit = f.from;
  }
  return out;
}

test('quick fixes repair common mistakes', () => {
  const src = [
    'layer M0 { role = conductr; pich = 40nm; width = 20 }',
    'layer V0 { role = cut }',
    'layer M1 { role = conductor; pitch = 2/3 * 44nm }',
    'connector VIA0 { lower = M00; cut = V0; upper = M1 }',
    'site S { width = 44nm; height = 200nm; pins = M1 }',
    'layer M2 {',
    '  role conductor',
    '}',
  ].join('\n');
  const before = resolveSource(src);
  assert.ok(before.diags.filter((d) => d.fix).length >= 7, JSON.stringify(before.diags.map((d) => [d.code, d.message])));
  const cur = applyFixes(src, before.diags);
  const after = resolveSource(cur);
  assert.deepEqual(after.diags.filter((d) => d.severity === 'error'), [], cur);
  assert.match(cur, /^stencil 0\.1\ntechnology \{ grid = 1nm \}/);
  assert.match(cur, /role = conductor; pitch = 40nm; width = 20nm/);
  assert.match(cur, /snap\(2\/3 \* 44nm\)/);
  assert.match(cur, /lower = M0;/);
  assert.match(cur, /pins = \[M1\]/);
  assert.match(cur, /role = conductor\n/);
});

test('every prefix of every example resolves without throwing (typing, keystroke by keystroke)', () => {
  for (const f of readdirSync(examples).filter((f) => f.endsWith('.stencil'))) {
    const src = readFileSync(join(examples, f), 'utf8');
    for (let i = 0; i <= src.length; i++) {
      try { resolveSource(src.slice(0, i)); } catch (e) { assert.fail(`${f} prefix ${i}: ${e.stack}`); }
    }
  }
});

test('deleting any single line of an example never throws', () => {
  for (const f of readdirSync(examples).filter((f) => f.endsWith('.stencil'))) {
    const lines = readFileSync(join(examples, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const src = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n');
      try { resolveSource(src); } catch (e) { assert.fail(`${f} without line ${i + 1}: ${e.stack}`); }
    }
  }
});
