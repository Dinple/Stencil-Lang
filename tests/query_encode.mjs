// The shared answer encoding of the query API tests (query_cases.json): lengths
// as exact strings, records as objects with snake_case fields; and a call
// adapter from the Python-style case form [name, args, kwargs] to the
// JavaScript API (camelCase methods and options).
import { Q } from '../core/rational.js';
import { StencilError, UnresolvedRuleError } from '../core/query.js';

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export function encode(x) {
  if (x instanceof Q) return x.toString();
  if (Array.isArray(x)) return x.map(encode);
  if (x && typeof x === 'object') {
    // records (fields: snake_case, private fields skipped) vs data mappings (null-prototype objects: keys kept)
    const data = Object.getPrototypeOf(x) === null;
    const out = {};
    for (const [k, v] of Object.entries(x)) if (data || !k.startsWith('_')) out[data ? k : snake(k)] = encode(v);
    return out;
  }
  return x;
}

export function call(target, [name, args = [], kw = {}]) {
  const method = name === 'w_eff' ? 'wEff' : camel(name);
  const attr = target[method];
  if (typeof attr !== 'function') return attr;
  const opts = name === 'w_eff' ? kw : Object.fromEntries(Object.entries(kw).map(([k, v]) => [camel(k), v]));
  return attr.call(target, ...args, ...(Object.keys(kw).length ? [opts] : []));
}

// The error class an API call raised, in the Python names.
export function errorClass(e) {
  if (e instanceof UnresolvedRuleError) return { error: 'UnresolvedRuleError', rules: e.rules };
  if (e instanceof StencilError) return { error: e.name };
  if (e instanceof RangeError) return { error: 'ValueError' };
  if (e instanceof TypeError) return { error: 'TypeError' };
  return { error: `crash:${e?.name}` };
}
