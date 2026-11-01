// JavaScript reference outputs for the Python port's differential tests.
//
//   node tests/reference.mjs < requests.json > results.json
//
// requests: [{ op, ... }] with op one of
//   resolve   { source }                      -> { resolved, errors }
//   check     { resolved, shapes, mode? }     -> checkRules()
//   recognize { resolved, shapes }            -> recognizeDevices()
//   expand    { resolved, name, units? }      -> expandSite()
//   profile   { resolved, profile }           -> { findings, scope }
//   api       { resolved, incomplete, calls } -> { construct, results }, the query API
//             (core/query.js); calls are [name, args, kwargs, then?] in the
//             Python form, answers in the shared encoding (query_encode.mjs)
// A request that throws answers { error: message }.
import { resolveSource } from '../core/resolve.js';
import { checkRules, recognizeDevices } from '../core/rulecheck.js';
import { expandSite } from '../core/template.js';
import { checkProfile } from '../core/profile.js';
import { Technology } from '../core/query.js';
import { encode, call, errorClass } from './query_encode.mjs';

function api(q) {
  let t;
  try { t = Technology.fromResolved(q.resolved, { allowIncomplete: q.incomplete }); } catch (e) { return { construct: errorClass(e), results: [] }; }
  return {
    construct: 'ok',
    results: q.calls.map(([name, args, kw, then]) => {
      try {
        let x = call(t, [name, args, kw]);
        if (then) x = call(x, then);
        return encode(x);
      } catch (e) { return errorClass(e); }
    }),
  };
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const answer = (q) => {
  switch (q.op) {
    case 'resolve': {
      const r = resolveSource(q.source);
      return { resolved: r.resolved, errors: r.diags.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`) };
    }
    case 'check': return checkRules(q.resolved, { shapes: q.shapes }, { mode: q.mode });
    case 'recognize': return recognizeDevices(q.resolved, { shapes: q.shapes });
    case 'expand': return expandSite(q.resolved, q.name, { units: q.units });
    case 'profile': { const f = checkProfile(q.resolved, q.profile); return { findings: [...f], scope: f.scope ?? null }; }
    case 'api': return api(q);
    default: throw new Error(`unknown op ${q.op}`);
  }
};
const out = JSON.parse(input).map((q) => { try { return answer(q); } catch (e) { return { error: e.message }; } });
process.stdout.write(JSON.stringify(out));
