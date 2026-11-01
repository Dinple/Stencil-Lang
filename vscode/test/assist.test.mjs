// Completion and hover (core/assist.js), shared with the playground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, hover } from '../../core/assist.js';

const at = (s) => [s.replace('|', ''), s.indexOf('|')];

test('top-level kinds, attributes of the enclosing kind, enum values, declared layers', () => {
  let [t, p] = at('stencil 0.1\nlay|');
  assert.ok(complete(t, p).items.some((i) => i.label === 'layer' && i.type === 'class'));
  [t, p] = at('stencil 0.1\nlayer M1 { dir| }');
  const attrs = complete(t, p).items;
  assert.ok(attrs.some((i) => i.label === 'direction' && i.type === 'property'));
  assert.ok(attrs.find((i) => i.label === 'role').boost > 0, 'required attributes first');
  [t, p] = at('stencil 0.1\nlayer M1 { direction = | }');
  assert.ok(complete(t, p, true).items.some((i) => i.label === 'vertical' && i.type === 'enum'));
  [t, p] = at('stencil 0.1\nlayer M1 { role = conductor }\nlayer V1 { role = cut }\nconnector C { lower = | }');
  const refs = complete(t, p, true).items.filter((i) => i.type === 'variable').map((i) => i.label);
  assert.deepEqual(refs.sort(), ['M1', 'V1']);
  [t, p] = at('stencil 0.1\nsite S { width = 1nm; height = 1nm\n  r| }');
  assert.ok(complete(t, p).items.some((i) => i.label === 'rail' && i.type === 'class'));
});

test('nothing is offered in the middle of a value or a comment-free gap without a word', () => {
  const [t, p] = at('stencil 0.1\nlayer M1 { role = conductor; |');
  assert.equal(complete(t, p), null);
});

test('hover documents attributes, kinds and functions', () => {
  const t = 'stencil 0.1\nlayer M1 { pitch = 30nm }\nlayer N { role = marker; from = grow(M1, 2nm) }';
  assert.match(hover(t, t.indexOf('pitch') + 1).title, /^layer\.pitch/);
  assert.match(hover(t, t.indexOf('layer') + 2).title, /^layer \(level/);
  assert.match(hover(t, t.indexOf('grow') + 1).title, /^grow/);
  assert.equal(hover(t, t.indexOf('30nm') + 1), null);
});
