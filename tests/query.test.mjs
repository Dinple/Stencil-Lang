// The shared query API cases (tests/query_cases.json) on the JavaScript API.
// The same file runs against the Python API (python/tests/test_queries.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, call } from './query_encode.mjs';
import * as api from '../core/query.js';
import { Technology } from '../core/query.js';

const here = (p) => new URL(p, import.meta.url);
const { cases } = JSON.parse(readFileSync(here('./query_cases.json'), 'utf8'));
const techs = new Map();
const tech = (name, incomplete = false) => {
  const key = `${name}:${incomplete}`;
  const folder = name.startsWith('raw_') ? 'raw' : 'examples';
  if (!techs.has(key)) techs.set(key, Technology.fromResolved(JSON.parse(readFileSync(here(`../python/tests/data/${folder}/${name}.json`), 'utf8')), { allowIncomplete: incomplete }));
  return techs.get(key);
};

function pick(x, path) {
  const get = (v, segs) => (!segs.length ? v : segs[0] === '*' ? v.map((e) => get(e, segs.slice(1))) : get(Array.isArray(v) ? v[Number(segs[0])] : v[segs[0]], segs.slice(1)));
  const paths = path.split(',');
  return paths.length === 1 ? get(x, paths[0].split('.')) : Object.fromEntries(paths.map((p) => [p, get(x, p.split('.'))]));
}
const ERRORS = { ValueError: RangeError, TypeError };

test('the shared query cases', () => {
  assert.ok(cases.length > 90);
  for (const c of cases) {
    let x;
    try {
      x = call(tech(c.tech, c.incomplete ?? false), c.q);
      if (c.then) x = call(x, c.then);
    } catch (e) {
      if (!c.error) throw new Error(`${c.name}: ${e.stack}`);
      assert.ok(e instanceof (ERRORS[c.error] ?? api[c.error]), `${c.name}: expected ${c.error}, got ${e.name}: ${e.message}`);
      if (c.needs) assert.deepEqual(e.rules, c.needs, c.name);
      continue;
    }
    assert.ok(!c.error, `${c.name}: expected ${c.error}, got ${JSON.stringify(encode(x))}`);
    let got = encode(x);
    if (c.pick) got = pick(got, c.pick);
    assert.deepEqual(got, c.want, c.name);
  }
});
