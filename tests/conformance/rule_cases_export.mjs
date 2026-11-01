// The exported form of the rule conformance cases (see export_cases.mjs).
import { resolveSource } from '../../core/resolve.js';
import { checkRules } from '../../core/rulecheck.js';
import { TECH, CASES, variantsOf } from './rule_cases.mjs';

export function exportCases() {
  const cases = [];
  const resolvedOf = new Map();
  const techs = [];
  const techIndex = (rules) => {
    if (!resolvedOf.has(rules)) {
      const r = resolveSource(TECH + rules);
      const errs = r.diags.filter((d) => d.severity === 'error');
      if (errs.length) throw new Error(`${rules}: ${errs.map((d) => d.message).join('; ')}`);
      resolvedOf.set(rules, techs.length);
      techs.push(r.resolved);
    }
    return resolvedOf.get(rules);
  };
  for (const c of CASES) {
    const [name, rules, shapes, nViol, nUnsup = 0] = c;
    for (const [variant, rs, sh] of [['as given', rules, shapes], ...variantsOf(c)]) {
      const tech = techIndex(rs);
      cases.push({ name, variant, tech, shapes: sh, violations: nViol, unsupported: nUnsup, js: checkRules(techs[tech], { shapes: sh }) });
    }
  }
  return { techs, cases };
}
