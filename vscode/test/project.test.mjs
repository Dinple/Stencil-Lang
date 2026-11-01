// Editor-independent extension logic (src/project.js), with an in-memory file system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveFile, DiagnosticBook, rootFor, parseSrc } from '../src/project.js';

const ROOT = path.resolve('/work/tech');
const P = (r) => path.join(ROOT, ...r.split('/'));
const FILES = {
  'lib/front.stencil': 'stencil 0.1\nMP = required(len)\nlayer M1 { role = conductor; direction = vertical; pitch = MP }\n',
  'main.stencil': 'stencil 0.1\ntechnology { grid = 1nm }\nimport "lib/front" as fs { MP = 30nm }\nlayer M2 { role = conductor; pitch = 2/3 * 44nm }\n',
  'other.stencil': 'stencil 0.1\ntechnology { grid = 1nm }\nimport "lib/front" as fs { MP = 1 }\n',
};
const disk = (abs) => { const r = path.relative(ROOT, abs).split(path.sep).join('/'); return FILES[r] ?? null; };

test('a main file resolves with its imports; diagnostics are grouped by file', () => {
  const e = resolveFile(P('main.stencil'), ROOT, disk);
  assert.deepEqual([...e.files].sort(), [P('lib/front.stencil'), P('main.stencil')]);
  const mine = e.byFile.get(P('main.stencil')).map((d) => d.code);
  assert.ok(mine.includes('C070'), JSON.stringify(mine));                 // 29.33nm off the grid
  assert.equal(e.byFile.has(P('lib/front.stencil')), false);
});

test('unsaved text wins over the disk', () => {
  const open = { [P('main.stencil')]: FILES['main.stencil'].replace('2/3 * 44nm', '30nm') };
  const e = resolveFile(P('main.stencil'), ROOT, (abs) => open[abs] ?? disk(abs));
  assert.equal(e.byFile.size, 0, JSON.stringify([...e.byFile]));
});

test('a library shows what its importers say about it, not its standalone errors', () => {
  const book = new DiagnosticBook();
  book.set(resolveFile(P('lib/front.stencil'), ROOT, disk));                  // standalone: MP not bound (C012)
  assert.ok(book.forFile(P('lib/front.stencil')).some((d) => d.code === 'C012'));
  book.set(resolveFile(P('main.stencil'), ROOT, disk));                       // binds MP: no error in the library
  assert.deepEqual(book.forFile(P('lib/front.stencil')), []);
  book.set(resolveFile(P('other.stencil'), ROOT, disk));                      // binds MP = 1: wrong type, reported at the binding
  assert.ok(book.forFile(P('other.stencil')).some((d) => d.code === 'C014'));
  book.delete(P('main.stencil'));
  book.delete(P('other.stencil'));
  assert.ok(book.forFile(P('lib/front.stencil')).some((d) => d.code === 'C012'));
});

test('duplicate diagnostics from several importers are shown once', () => {
  const files = { ...FILES, 'lib/front.stencil': FILES['lib/front.stencil'] + 'layer M1X { role = conductr }\n', 'other.stencil': FILES['main.stencil'] };
  const d = (abs) => { const r = path.relative(ROOT, abs).split(path.sep).join('/'); return files[r] ?? null; };
  const book = new DiagnosticBook();
  book.set(resolveFile(P('main.stencil'), ROOT, d));
  book.set(resolveFile(P('other.stencil'), ROOT, d));
  const lib = book.forFile(P('lib/front.stencil'));
  assert.equal(lib.filter((x) => x.code === 'V003').length, 1, JSON.stringify(lib));
});

test('root folder and source locations', () => {
  assert.equal(rootFor('/w/a/b.stencil', '/w', ''), '/w');
  assert.equal(rootFor('/w/a/b.stencil', '/w', 'a'), path.resolve('/w/a'));
  assert.equal(rootFor('/x/y/z.stencil', undefined, ''), '/x/y');
  assert.deepEqual(parseSrc('lib/front.stencil:3:1', 'main.stencil'), { file: 'lib/front.stencil', line: 3, col: 1 });
  assert.deepEqual(parseSrc('4:7', 'main.stencil'), { file: 'main.stencil', line: 4, col: 7 });
  assert.equal(parseSrc('nonsense', 'main.stencil'), null);
});
