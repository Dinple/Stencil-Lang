// Renderer robustness: the playground redraws on every keystroke, so every
// prefix of every example must render, with no NaN/undefined leaking into SVG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveSource } from '../core/resolve.js';
import { buildModel, renderTop, renderStack, renderDevice, swatchDefs } from '../playground/render.js';

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

function renderAll(src, theme) {
  const m = buildModel(resolveSource(src).resolved, theme);
  return renderTop(m).svg + renderStack(m) + renderDevice(m) + swatchDefs(m);
}

test('complete examples render cleanly in both themes', () => {
  for (const f of readdirSync(examples).filter((f) => f.endsWith('.stencil'))) {
    for (const theme of ['light', 'dark']) {
      const out = renderAll(readFileSync(join(examples, f), 'utf8'), theme);
      assert.doesNotMatch(out, /NaN|undefined|Infinity/, `${f} (${theme})`);
    }
  }
});

test('every prefix of every example renders without throwing', () => {
  for (const f of readdirSync(examples).filter((f) => f.endsWith('.stencil'))) {
    const src = readFileSync(join(examples, f), 'utf8');
    for (let i = 0; i <= src.length; i += 3) {
      try { renderAll(src.slice(0, i), 'light'); } catch (e) { assert.fail(`${f} prefix ${i}: ${e.stack}`); }
    }
  }
});

test('stack table reports tracks per row and the gear ratio', () => {
  const m = buildModel(resolveSource(readFileSync(join(examples, 'level1_nanosheet.stencil'), 'utf8')).resolved);
  const text = renderStack(m).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /9 \/ row, 7 signal/);
  assert.match(text, /gear ratio M1 : gate = 3 : 2/);
  assert.match(text, /2\/3\*CPP/);
});

test('device card computes W_eff for every sizing option', () => {
  const ns = buildModel(resolveSource(readFileSync(join(examples, 'level1_nanosheet.stencil'), 'utf8')).resolved);
  assert.match(renderDevice(ns), /<td>120<\/td><td>180<\/td><td>240<\/td>/);
  const ff = buildModel(resolveSource(readFileSync(join(examples, 'level1_finfet.stencil'), 'utf8')).resolved);
  assert.match(renderDevice(ff), /<td>99<\/td><td>198<\/td><td>297<\/td>/);
});
