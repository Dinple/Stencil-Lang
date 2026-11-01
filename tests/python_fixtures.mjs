// Fixtures for the Python port's tests (python/tests/data/), so they run
// without Node:
//
//   node tests/python_fixtures.mjs
//
//   rule_cases.json   every rule conformance case and invariance variant,
//                     resolved, with the hand-derived verdict counts and the
//                     JavaScript checker's full result
//   examples/*.json   example technologies, resolved, with diagnostics (the
//                     form `cli.mjs resolve --with-diagnostics` writes)
//
// tests/python_fixtures.test.mjs fails when the files are stale.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveProject } from '../core/resolve.js';
import { hashResolved } from '../core/canon.js';
import { exportCases } from './conformance/rule_cases_export.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const DATA = join(ROOT, 'python', 'tests', 'data');
// name -> [root, main]
export const EXAMPLES = {
  gt2n_bspdn: ['examples', 'pdk/gt2n/bspdn.stencil'],
  gt2n_fspdn: ['examples', 'pdk/gt2n/fspdn.stencil'],
  level0_routing: ['examples', 'level0_routing.stencil'],
  level1_finfet: ['examples', 'level1_finfet.stencil'],
  level1_nanosheet: ['examples', 'level1_nanosheet.stencil'],
  level2_rules: ['examples', 'level2_rules.stencil'],
  gear_ratio: ['examples/compose', 'gear_ratio.stencil'],
  query_rules: ['python/tests/data/src', 'query_rules.stencil'],
  query_more: ['python/tests/data/src', 'query_more.stencil'],
  invalid_rule: ['python/tests/data/src', 'invalid_rule.stencil'],
  query_deep: ['python/tests/data/src', 'query_deep.stencil'],
  query_r6: ['python/tests/data/src', 'query_r6.stencil'],
  query_r7: ['python/tests/data/src', 'query_r7.stencil'],
  invalid_child: ['python/tests/data/src', 'invalid_child.stencil'],
  query_huge: ['python/tests/data/src', 'query_huge.stencil'],
  query_r16: ['python/tests/data/src', 'query_r16.stencil'],
};

export async function bundle([root, main]) {
  const load = (p) => { try { return readFileSync(join(ROOT, root, p), 'utf8'); } catch { return null; } };
  const r = resolveProject({ main, load });
  const resolved = { ...r.resolved, hash: await hashResolved(r.resolved) };
  const diagnostics = r.diags.map(({ code, severity, message, hint, file, line, col, end_line, end_col, instance }) => ({ code, severity, message, hint, file, line, col, end_line, end_col, instance }));
  return JSON.stringify({ resolved, diagnostics }) + '\n';
}

export async function fixtures() {
  const files = { 'rule_cases.json': JSON.stringify(exportCases()) + '\n' };
  for (const [name, spec] of Object.entries(EXAMPLES)) files[`examples/${name}.json`] = await bundle(spec);
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(DATA, 'examples'), { recursive: true });
  for (const [f, text] of Object.entries(await fixtures())) writeFileSync(join(DATA, f), text);
  console.error(`wrote ${DATA}`);
}
