// Stencil playground: type on the left, the technology redraws on the right.
// A playground session is a project: a main file plus the files it imports,
// each in its own tab.

import { createEditor, newState, showDiagnostics, jumpTo, setDoc, applyFix, applyFixes } from './editor.js';
import { resolveProject, resolvePath } from '../core/resolve.js';
import { parse } from '../core/parser.js';
import { hashResolved } from '../core/canon.js';
import { buildModel, renderTop, renderStack, renderDevice, swatchDefs } from './render.js';

const EXAMPLES = [
  { main: 'level0_routing.stencil', label: 'Level 0: routing layers' },
  { main: 'level1_nanosheet.stencil', label: 'Level 1: nanosheet devices' },
  { main: 'level1_finfet.stencil', label: 'Level 1: FinFET devices' },
  { main: 'level2_rules.stencil', label: 'Level 2: rules & derived masks' },
  { main: 'compose/gear_ratio.stencil', label: 'Level 3: imports: one front side, two gear ratios' },
  { main: 'pdk/gt2n/bspdn.stencil', label: 'GT2N: backside power (4 modules)' },
  { main: 'pdk/gt2n/fspdn.stencil', label: 'GT2N: front-side power (same modules)' },
  { main: 'pdk/asap7/asap7.stencil', label: 'ASAP7: 7.5-track FinFET' },
  { main: 'pdk/probe3/probe3_finfet.stencil', label: 'PROBE3: FinFET' },
  { main: 'transplant/probe3_asap7_grid.stencil', label: 'Transplant: PROBE3 devices on the ASAP7 routing grid' },
  { main: 'transplant/gt2n_device_probe3_grid.stencil', label: 'Transplant: GT2N devices on the PROBE3 routing grid' },
];
const KEYS = { project: 'stencil.playground.project', hidden: 'stencil.playground.hidden', theme: 'stencil.playground.theme' };
const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = {
  hidden: new Set(JSON.parse(store.get(KEYS.hidden) ?? '[]')),
  files: new Map(),          // path -> text (the active file's text lives in the view)
  states: new Map(),         // path -> CodeMirror state, for inactive files
  main: 'main.stencil',
  active: 'main.stencil',
  last: null,
  lastSnapshot: null,
  cursorObj: null,
  hoverObj: null,
  tab: 'stack',
  timer: 0,
  seq: 0,
};

const theme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

// ---- project loading ------------------------------------------------------------

async function fetchText(path) {
  const r = await fetch(`../examples/${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`cannot load ${path}`);
  return r.text();
}

// Load an example and, transitively, every module it imports.
async function loadExample(mainPath) {
  const files = new Map();
  const queue = [mainPath];
  while (queue.length) {
    const p = queue.shift();
    if (files.has(p)) continue;
    let text;
    try { text = await fetchText(p); } catch { continue; }
    files.set(p, text);
    for (const st of parse(text).ast.stmts) if (st.type === 'Import') queue.push(resolvePath(p, st.path));
  }
  return files;
}

function encodeHash(obj) {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(obj))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeHash() {
  const m = location.hash.match(/^#(code|project)=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[2].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (m[1] === 'code') return { main: 'main.stencil', files: { 'main.stencil': text } };   // old single-file links
    return JSON.parse(text);
  } catch { return null; }
}

function snapshot() {
  const files = {};
  for (const [p, t] of state.files) files[p] = p === state.active ? view.state.doc.toString() : t;
  return { main: state.main, files };
}

function saveProject() { store.set(KEYS.project, JSON.stringify(snapshot())); }

// ---- startup ----------------------------------------------------------------------

const select = $('examples');
select.innerHTML = `<option value="">Examples...</option>` + EXAMPLES.map((e, i) => `<option value="${i}">${e.label}</option>`).join('');

let initial = decodeHash();
if (!initial) { try { initial = JSON.parse(store.get(KEYS.project) ?? 'null'); } catch { initial = null; } }
if (!initial?.files?.[initial.main]) {
  const files = await loadExample(EXAMPLES[0].main).catch(() => new Map([['main.stencil', 'stencil 0.1\n']]));
  initial = { main: [...files.keys()][0], files: Object.fromEntries(files) };
}

const view = createEditor($('editor'), initial.files[initial.main], {
  onChange: () => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    clearTimeout(state.timer);
    state.timer = setTimeout(update, 90);
  },
  onCursor: (pos) => { state.cursorObj = objectAt(pos); paintHighlight(); },
});

function openProject(p) {
  state.files = new Map(Object.entries(p.files));
  state.states = new Map();
  state.main = p.main;
  state.active = p.main;
  view.setState(newState(state.files.get(p.main)));
  renderTabs();
}
openProject(initial);

function switchTo(path) {
  if (path === state.active || !state.files.has(path)) return;
  state.files.set(state.active, view.state.doc.toString());
  state.states.set(state.active, view.state);
  state.active = path;
  view.setState(state.states.get(path) ?? newState(state.files.get(path)));
  renderTabs();
  if (state.last) showDiagnostics(view, state.last.diags.filter((d) => d.file === state.active));
}

function renderTabs() {
  const bar = $('file-tabs');
  bar.innerHTML = '';
  const paths = [state.main, ...[...state.files.keys()].filter((p) => p !== state.main).sort()];
  for (const p of paths) {
    const b = document.createElement('button');
    b.className = `title file-tab${p === state.active ? ' active' : ''}`;
    b.textContent = p;
    const n = state.last?.diags.filter((d) => d.file === p && d.severity === 'error').length ?? 0;
    if (n) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = n; b.appendChild(badge); }
    b.title = p === state.main ? 'main file' : 'imported module';
    b.addEventListener('click', () => switchTo(p));
    bar.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'title add-file';
  add.textContent = '+';
  add.title = 'Add a module file';
  add.addEventListener('click', () => {
    const name = prompt('Module path (e.g. lib/frontside.stencil):', 'lib/module.stencil');
    if (!name) return;
    const path = name.endsWith('.stencil') ? name : `${name}.stencil`;
    if (!state.files.has(path)) state.files.set(path, 'stencil 0.1\n');
    switchTo(path);
    update();
  });
  bar.appendChild(add);
}

select.addEventListener('change', async () => {
  const ex = EXAMPLES[+select.value];
  select.value = '';
  if (!ex) return;
  try {
    const files = await loadExample(ex.main);
    openProject({ main: ex.main, files: Object.fromEntries(files) });
    update();
  } catch (e) { toast(e.message); }
});

$('share').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#project=${encodeHash(snapshot())}`;
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); toast('Link copied. It contains every file of the project.'); } catch { toast('The link is in the address bar.'); }
});

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').textContent = t === 'dark' ? 'Light' : 'Dark';
  store.set(KEYS.theme, t);
}
$('theme').addEventListener('click', () => { setTheme(theme() === 'dark' ? 'light' : 'dark'); update(); });
setTheme(theme());

$('fix-all').addEventListener('click', () => {
  if (!state.last || state.lastSnapshot !== JSON.stringify(snapshot())) return;
  const n = applyFixes(view, state.last.diags.filter((d) => d.fix && d.file === state.active).map((d) => d.fix));
  toast(`Applied ${n} fix${n === 1 ? '' : 'es'} in ${state.active}. Ctrl-Z undoes them all.`);
});

// ---- update loop ------------------------------------------------------------------

function update() {
  const snap = snapshot();
  const seq = ++state.seq;
  let r;
  try {
    r = resolveProject({ main: snap.main, load: (p) => snap.files[p] ?? null });
  } catch (e) {
    console.error(e);
    showStatus([{ severity: 'error', code: 'BUG', file: state.active, message: `front end crashed: ${e.message}`, line: 1, col: 1 }], null);
    return;
  }
  state.last = r;
  state.lastSnapshot = JSON.stringify(snap);
  showDiagnostics(view, r.diags.filter((d) => d.file === state.active));
  try {
    const model = buildModel(r.resolved, theme());
    $('defs').innerHTML = swatchDefs(model);
    const top = renderTop(model, state.hidden);
    $('top').innerHTML = top.svg;
    topZoom.apply();
    renderLegend(top.legend);
    $('stack').innerHTML = renderStack(model);
    $('device').innerHTML = renderDevice(model);
    $('json').textContent = JSON.stringify(r.resolved, (k, v) => (k === 'attr_src' ? undefined : v), 2);
  } catch (e) {
    console.error(e);
    r.diags.push({ severity: 'error', code: 'VIEW', file: state.main, message: `viewer error: ${e.message}`, line: 1, col: 1 });
  }
  showStatus(r.diags, r);
  renderTabs();
  state.cursorObj = objectAt(view.state.selection.main.head);
  paintHighlight();
  saveProject();
  hashResolved(r.resolved).then((h) => { if (seq === state.seq) { $('hash').textContent = h.slice(0, 19) + '...'; $('hash').title = h; } });
}

// Go to file:line:col, switching tabs if needed.
function goTo(file, line, col) {
  if (file && file !== state.active) switchTo(file);
  jumpTo(view, line, col);
}

function showStatus(diags, r) {
  const errs = diags.filter((d) => d.severity === 'error').length;
  const warns = diags.filter((d) => d.severity === 'warning').length;
  const summary = $('diag-summary');
  summary.className = errs ? 'has-errors' : warns ? 'has-warnings' : 'ok';
  summary.textContent = errs || warns
    ? [errs && `${errs} error${errs > 1 ? 's' : ''}`, warns && `${warns} warning${warns > 1 ? 's' : ''}`].filter(Boolean).join('   ')
    : 'resolved, no problems';
  const mods = r?.resolved.modules.length ?? 0;
  $('objects').textContent = r ? `${r.resolved.objects.length} objects${mods ? `, ${mods} modules` : ''}, ${r.ms.toFixed(1)} ms` : '';
  const fixable = diags.filter((d) => d.fix && d.file === state.active).length;
  $('fix-all').hidden = fixable < 1;
  $('fix-all').textContent = `Fix all (${fixable})`;

  const list = $('diag-list');
  list.innerHTML = '';
  for (const d of diags.slice(0, 80)) {
    const row = document.createElement('div');
    row.className = `diag ${d.severity}`;
    const where = d.file && d.file !== state.main ? `${d.file}:${d.line}` : `${d.line}:${d.col}`;
    row.innerHTML = `<span class="loc">${where}</span><span class="code">${d.code}</span><span class="msg"></span>`;
    row.querySelector('.msg').textContent = (d.instance ? `[${d.instance}] ` : '') + (d.hint ? `${d.message}, ${d.hint}` : d.message);
    if (d.fix) {
      const b = document.createElement('button');
      b.className = 'fix';
      b.textContent = d.fix.label;
      b.title = `Apply: ${JSON.stringify(d.fix.insert)}`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.lastSnapshot !== JSON.stringify(snapshot())) return;
        if (d.file !== state.active) switchTo(d.file);
        applyFix(view, { from: d.fix.from, to: d.fix.to, insert: d.fix.insert });
      });
      row.appendChild(b);
    }
    row.addEventListener('click', () => goTo(d.file, d.line, d.col));
    list.appendChild(row);
  }
  list.hidden = diags.length === 0;
}

// ---- editor <-> drawing links -----------------------------------------------------

function objectAt(pos) {
  let best = null;
  for (const s of state.last?.spans ?? []) {
    if (s.file !== state.active) continue;
    if (s.from <= pos && pos <= s.to && (!best || s.to - s.from < best.to - best.from)) best = s;
  }
  return best?.path ?? null;
}

function paintHighlight() {
  const path = state.hoverObj ?? state.cursorObj;
  if (!path) { $('hl-style').textContent = ''; return; }
  const sel = `[data-obj="${CSS.escape(path)}"]`;
  $('hl-style').textContent = `
    svg ${sel}, svg ${sel} * { stroke: var(--hl-stroke) !important; stroke-width: 2px !important; vector-effect: non-scaling-stroke; opacity: 1 !important; }
    tr${sel} td, .derived-list ${sel}, h4${sel} { background: var(--hl) !important; }
    .legend-chip[data-name="${CSS.escape(path)}"] { background: var(--hl); }`;
}

// data-src is "file:line:col" (or "line:col" for older output).
function parseSrc(src) {
  const m = src?.match(/^(?:(.*):)?(\d+):(\d+)$/);
  return m ? { file: m[1] ?? state.main, line: +m[2], col: +m[3] } : null;
}

for (const id of ['top', 'stack', 'device']) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    if (topZoom.dragged) return;
    const hit = e.target.closest('[data-src]');
    const loc = parseSrc(hit?.getAttribute('data-src'));
    if (loc) goTo(loc.file, loc.line, loc.col);
  });
  if (id !== 'top') {
    el.addEventListener('mouseover', (e) => { const hit = e.target.closest('[data-obj]'); state.hoverObj = hit?.dataset.obj ?? null; paintHighlight(); });
    el.addEventListener('mouseleave', () => { state.hoverObj = null; paintHighlight(); });
  }
}

function renderLegend(items) {
  const box = $('legend');
  box.innerHTML = '';
  for (const it of items) {
    const chip = document.createElement('button');
    chip.className = `legend-chip${state.hidden.has(it.name) ? ' off' : ''}`;
    chip.dataset.name = it.name;
    chip.title = 'click: hide / show, shift-click: go to definition';
    chip.innerHTML = `${it.swatch}${it.name}`;
    chip.addEventListener('click', (e) => {
      const loc = parseSrc(it.src);
      if (e.shiftKey && loc) { goTo(loc.file, loc.line, loc.col); return; }
      if (state.hidden.has(it.name)) state.hidden.delete(it.name); else state.hidden.add(it.name);
      store.set(KEYS.hidden, JSON.stringify([...state.hidden]));
      update();
    });
    box.appendChild(chip);
  }
}

// ---- pan & zoom on the top view ---------------------------------------------------

const topZoom = (() => {
  const box = $('top');
  let vb = null;
  let drag = null;
  const svg = () => box.querySelector('svg');
  const cur = () => { const b = svg().viewBox.baseVal; return [b.x, b.y, b.width, b.height]; };
  const toUser = (x, y) => {
    const s = svg();
    const p = s.createSVGPoint();
    p.x = x; p.y = y;
    return p.matrixTransform(s.getScreenCTM().inverse());
  };
  const api = {
    dragged: false,
    apply() { if (vb && svg()) svg().setAttribute('viewBox', vb.join(' ')); },
  };
  box.addEventListener('wheel', (e) => {
    if (!svg()) return;
    e.preventDefault();
    const c = vb ?? cur();
    const p = toUser(e.clientX, e.clientY);
    const k = Math.exp(e.deltaY * 0.0015);
    vb = [p.x - (p.x - c[0]) * k, p.y - (p.y - c[1]) * k, c[2] * k, c[3] * k];
    api.apply();
  }, { passive: false });
  box.addEventListener('pointerdown', (e) => {
    if (!svg() || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, vb: vb ?? cur(), scale: 1 / svg().getScreenCTM().a };
    api.dragged = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!api.dragged && Math.hypot(dx, dy) < 4) return;
    api.dragged = true;
    box.classList.add('panning');
    vb = [drag.vb[0] - dx * drag.scale, drag.vb[1] - dy * drag.scale, drag.vb[2], drag.vb[3]];
    api.apply();
  });
  window.addEventListener('pointerup', () => {
    drag = null;
    box.classList.remove('panning');
    setTimeout(() => { api.dragged = false; }, 0);
  });
  box.addEventListener('dblclick', () => { vb = null; update(); });
  return api;
})();

// ---- layout -----------------------------------------------------------------------

for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b === btn);
    for (const id of ['stack', 'device', 'json']) $(id).hidden = id !== state.tab;
  });
}

(() => {
  const split = $('splitter');
  const main = $('main');
  let active = false;
  split.addEventListener('pointerdown', (e) => { active = true; split.setPointerCapture(e.pointerId); });
  split.addEventListener('pointermove', (e) => {
    if (!active) return;
    const r = main.getBoundingClientRect();
    const frac = Math.min(0.75, Math.max(0.2, (e.clientX - r.left) / r.width));
    main.style.gridTemplateColumns = `${frac}fr 10px ${1 - frac}fr`;
  });
  split.addEventListener('pointerup', () => { active = false; });
})();

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ?tab=device|json opens that tab; ?theme=dark|light forces the theme;
// ?example=PATH (a menu entry's main file, e.g. transplant/probe3_asap7_grid.stencil)
// or ?example=N (its position in the menu) loads an example, for links in the docs
const params = new URLSearchParams(location.search);
document.querySelector(`[data-tab="${params.get('tab')}"]`)?.click();
if (params.get('theme') === 'dark' || params.get('theme') === 'light') setTheme(params.get('theme'));
const linked = params.get('example');
const ex = linked === null ? undefined : EXAMPLES.find((e) => e.main === linked) ?? (/^\d+$/.test(linked) ? EXAMPLES[+linked] : undefined);
if (ex) {
  openProject({ main: ex.main, files: Object.fromEntries(await loadExample(ex.main)) });
  select.value = String(EXAMPLES.indexOf(ex));
}

update();
view.focus();

// ?selftest drives the editor and reports into the page (see selftest.js)
if (params.has('selftest')) import('./selftest.js').then((m) => m.selftest({ view, $, update, switchTo, state }));
