// Conformance cases for the normative rule semantics (VOCABULARY.md section 3).
// Every expected verdict is derived by hand from the definitions, never from
// the checker; the invariance tests then re-run each case translated,
// mirrored, with x and y exchanged, and with the shapes permuted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource } from '../../core/resolve.js';
import { checkRules } from '../../core/rulecheck.js';
import { TECH, R, CASES, variantsOf } from './rule_cases.mjs';

function tech(rules) {
  const r = resolveSource(TECH + rules);
  const errs = r.diags.filter((d) => d.severity === 'error');
  assert.deepEqual(errs, [], rules);
  return r.resolved;
}
const run = (rules, shapes, opts) => checkRules(tech(rules), { shapes }, opts);

for (const [name, rules, shapes, nViol, nUnsup = 0] of CASES) {
  test(`conformance: ${name}`, () => {
    const r = run(rules, shapes);
    assert.equal(r.violations.length, nViol, JSON.stringify(r));
    assert.equal(r.unsupported.length, nUnsup, JSON.stringify(r.unsupported));
    assert.equal(r.complete, nUnsup === 0);
  });
}

test('conformance verdicts are invariant under translation, mirroring, rotation, permutation and x/y exchange', () => {
  for (const c of CASES) {
    const [name, , , nViol, nUnsup = 0] = c;
    for (const [k, rs, sh] of variantsOf(c)) {
      const r = run(rs, sh);
      assert.equal(r.violations.length, nViol, `${name} / ${k}: ${JSON.stringify(r)}`);
      assert.equal(r.unsupported.length, nUnsup, `${name} / ${k}`);
    }
  }
});

test('checker mode checks checker_only rules', () => {
  assert.equal(run('rule W { kind = width; on = M1; value = 20nm; intent = checker_only }', [R('M1', 0, 0, 10, 100)], { mode: 'checker' }).violations.length, 1);
});

test('violations name the rule, subjects, measurement and threshold', () => {
  const r = run('rule S { kind = spacing; on = M1; value = 5.1nm }', [R('M1', 0, 0, 10, 10), R('M1', 13, 14, 23, 24)]);
  assert.deepEqual(r.violations, [{ rule: 'S', kind: 'spacing', subjects: [0, 1], measured: 'sqrt(25)', threshold: '51/10', limit: 'min' }]);
});

// Rule structure is validated at resolve time (VOCABULARY.md section 3.5-3.6).
const STRUCT = [
  ['rule S { kind = spacing; on = M1; within = 3nm; value = 5nm }', 'V035'],
  ['rule S { kind = width; on = [M1, M2]; value = 5nm }', 'V035'],
  ['rule S { kind = width; on = C; value = 5nm }', 'V035'],
  ['rule S { kind = enclosure; on = M1; value = 5nm }', 'V035'],
  ['rule S { kind = extension; on = [M1, M2]; value = 5nm }', 'V035'],
  ['rule S { kind = spacing; on = M1; limit = max; value = 5nm }', 'V036'],
  ['rule S { kind = min_length; on = M1; limit = exact; value = 5nm }', 'V036'],
  ['rule S { kind = spacing; on = M1 }', 'V038'],
  ['rule S { kind = inside; on = [V1, M1]; value = 0nm }', 'V038'],
  ['rule S { kind = spacing; on = M1; value = 5nm\n table { width = [0nm]; values = [[5nm]] } }', 'V038'],
  ['rule S { kind = width; on = M1\n alternative a { margins = [0nm, 0nm, 0nm, 0nm] } }', 'V038'],
  ['rule S { kind = enclosure; on = [V1, M1]\n alternative a { margins = [0nm, 0nm, 0nm] } }', 'V038'],
  ['rule S { kind = spacing; on = M1\n case wide { value = 5nm } }', 'V037'],
  ['rule S { kind = width; on = M1\n table { width = [0nm]; values = [[5nm]] } }', 'V039'],
  ['rule S { kind = spacing; on = M1\n table { width = [0nm, 20nm]; values = [[5nm]] } }', 'V039'],
  ['rule S { kind = spacing; on = M1\n table { width = [5nm, 20nm]; values = [[5nm], [6nm]] } }', 'V039'],
  ['rule S { kind = spacing; on = M1\n table { width = [0nm, 20nm, 10nm]; values = [[5nm], [6nm], [7nm]] } }', 'V039'],
  ['rule S { kind = spacing; on = M1; width_below = -1nm; value = 2nm }', 'V034'],
  ['rule S { kind = eol_spacing; on = M1; axis = x; within = -1nm; value = 2nm }', 'V034'],
  ['rule S { kind = spacing; on = M1; prl = -1nm; value = 2nm }', 'V034'],
  ['region G { from = grow(V1, 0nm) }\nrule S { kind = cut_spacing; on = G; value = 2nm }', 'V035'],
  ['rule S { kind = cut_spacing; on = M1; value = 2nm }', 'V035'],          // a conductor
  ['rule S { kind = cut_spacing; on = MK; value = 2nm }', 'V035'],          // a marker
];
test('cut_spacing accepts a drawn cut layer and a connector', () => {
  for (const src of ['rule S { kind = cut_spacing; on = V1; value = 2nm }', 'rule S { kind = cut_spacing; on = C; value = 2nm }']) {
    assert.deepEqual(resolveSource(TECH + src).diags.filter((d) => d.severity === 'error'), [], src);
  }
});

test('rule structure is validated (V035-V039)', () => {
  for (const [src, code] of STRUCT) {
    const r = resolveSource(TECH + src);
    assert.ok(r.diags.some((d) => d.code === code && d.severity === 'error'), `${src}: want ${code}, got ${JSON.stringify(r.diags.map((d) => d.code))}`);
  }
});

test('an unevaluated operand (unbound parameter) adds no V035', () => {
  const r = resolveSource(TECH + 'X = required(layer)\nrule I { kind = inside; on = [V1, X] }');
  assert.deepEqual(r.diags.filter((d) => d.severity === 'error').map((d) => d.code), ['C012']);
});

// ---- expected verdicts from section 3 ----------------
const LIB = `stencil 0.1
technology { grid = 1nm }
layer A { role = conductor }
layer B { role = conductor }
layer M { role = marker }
`;
const runL = (rules, shapes) => checkRules(resolveSource(LIB + rules).resolved, { shapes });
const nV = (rules, shapes) => { const r = runL(rules, shapes); assert.ok(r.complete, JSON.stringify(r.unsupported)); return r.violations.length; };

test('M3b-1: scope on a one-operand pair is order independent (either member in scope)', () => {
  const rule = 'rule T { kind = spacing; on = A; scope = M; value = 2nm }';
  assert.equal(nV(rule, [R('A', 0, 0, 1, 1), R('A', 2, 0, 3, 1), R('M', 2, 0, 3, 1)]), 1);
  assert.equal(nV(rule, [R('A', 2, 0, 3, 1), R('A', 0, 0, 1, 1), R('M', 2, 0, 3, 1)]), 1);
});

test('M3b-2: operations use merged components', () => {
  assert.equal(nV('rule T { kind = enclosure; on = [A, B]; value = 0nm }', [R('A', 1, 1, 3, 3), R('B', 0, 0, 2, 4), R('B', 2, 0, 4, 4)]), 0);
  assert.equal(nV('rule T { kind = interacting; on = [A, B] }', [R('A', 0, 0, 2, 2), R('A', 2, 0, 4, 2), R('B', -1, 0, 0, 2)]), 0);
  assert.equal(nV('region RR { from = shrink(A, 1nm) }\nrule T { kind = width; on = RR; value = 100nm }', [R('A', 0, 0, 2, 4), R('A', 2, 0, 4, 4)]), 1);
});

test('M3b-3: eol width conditions are on the end, also with same_net', () => {
  assert.equal(nV('rule T { kind = eol_spacing; on = A; axis = x; width_below = 3nm; same_net = true; value = 2nm }', [R('A', 0, 0, 10, 2, { net: 'n' }), R('A', 11, 0, 21, 10, { net: 'n' })]), 1);
});

test('M3b-4: distances and areas are exact beyond 2^53', () => {
  assert.equal(nV('rule T { kind = spacing; on = [A, B]; value = 100000001nm }', [R('A', 0, 0, 1, 1), R('B', 100000002, 2, 100000003, 3)]), 0);
  assert.equal(nV('rule T { kind = area; on = A; value = 9007199515875290nm * 1nm }', [R('A', 0, 0, 94906267, 94906267)]), 1);   // 94906267^2 = 9007199515875289 > 2^53
  assert.equal(nV('rule T { kind = area; on = A; value = 9007199515875289nm * 1nm }', [R('A', 0, 0, 94906267, 94906267)]), 0);   // a float product rounds to ...288 or ...290
});

test('M3b-5: negative thresholds are rejected', () => {
  assert.ok(resolveSource(LIB + 'rule T { kind = spacing; on = [A, B]; value = -1nm }').diags.some((d) => d.code === 'V034'));
});

test('M3b-6: regularized regions; minus into several rectangles', () => {
  assert.equal(nV('region RR { from = intersect(A, B) }\nrule T { kind = interacting; on = [A, RR] }', [R('A', 0, 0, 2, 2), R('B', 2, 0, 4, 2)]), 1);
  assert.equal(nV('region RR { from = minus(A, B) }\nrule T { kind = width; on = RR; axis = x; value = 2nm }', [R('A', 0, 0, 6, 2), R('B', 2, -1, 4, 3)]), 0);
  assert.equal(nV('region RR { from = minus(A, B) }\nrule T { kind = width; on = RR; axis = x; value = 3nm }', [R('A', 0, 0, 6, 2), R('B', 2, -1, 4, 3)]), 2);
  assert.equal(runL('region RR { from = minus(A, B) }\nrule T { kind = width; on = RR; value = 1nm }', [R('A', 0, 0, 6, 6), R('B', 2, 2, 4, 4)]).complete, false);   // non-rectangular component
});

test('M3b-7: corner spacing ignores overlapping pairs', () => {
  assert.equal(nV('rule T { kind = corner_spacing; on = [A, B]; value = 1nm }', [R('A', 0, 0, 2, 2), R('B', 1, 1, 3, 3)]), 0);
});

test('M3b-8: operand and limit validation agree with section 3', () => {
  const c = (src) => resolveSource(LIB + src).diags.filter((d) => d.severity === 'error').map((d) => d.code);
  assert.ok(c('rule T { kind = cut_spacing; on = [A, B]; value = 1nm }').includes('V035'));
  assert.ok(c('rule T { kind = extension; on = [A, B]; axis = x; limit = max; value = 1nm }').includes('V036'));
  assert.ok(c('rule T { kind = inside; on = [A, B]; limit = min }').includes('V036'));
});

test('M3b follow-ups: provenance through grow, [R, R] is R', () => {
  assert.equal(nV('region G { from = grow(A, 0nm) }\nrule T { kind = spacing; on = G; same_net = false; value = 5nm }', [R('A', 0, 0, 1, 1, { net: 'a' }), R('A', 3, 0, 4, 1, { net: 'b' })]), 1);
  assert.equal(nV('region G { from = grow(A, 0nm) }\nrule T { kind = spacing; on = [G, G]; value = 1nm }', [R('A', 0, 0, 1, 1), R('A', 3, 0, 4, 1)]), 0);
});

test('an injected negative centre-distance threshold is unsupported, not decided', () => {
  const t = tech('rule S { kind = cut_spacing; on = C; measure = center; value = 1nm }');
  const bad = { ...t, objects: t.objects.map((o) => (o.name === 'S' ? { ...o, attrs: { ...o.attrs, value: -10 } } : o)) };
  const r = checkRules(bad, { shapes: [R('V1', 0, 0, 10, 10, { connector: 'C' }), R('V1', 18, 0, 28, 10, { connector: 'C' })] });
  assert.equal(r.complete, false);
  assert.equal(r.violations.length, 0);
});
