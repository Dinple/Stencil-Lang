// The Python port's fixtures must match what the JavaScript implementation
// produces now (regenerate: node tests/python_fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtures, DATA } from './python_fixtures.mjs';

test('python/tests/data is up to date (node tests/python_fixtures.mjs)', async () => {
  for (const [f, text] of Object.entries(await fixtures())) {
    let have = null;
    try { have = readFileSync(join(DATA, f), 'utf8'); } catch { /* missing */ }
    assert.ok(have === text, `${f} is stale: run node tests/python_fixtures.mjs`);
  }
});
