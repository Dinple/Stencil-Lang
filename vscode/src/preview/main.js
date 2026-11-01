// Webview side of the Stencil preview: draws the resolved form the extension
// sends, with the playground's renderer (playground/render.js), and reports
// clicks back so the editor can jump to the source.

import { buildModel, swatchDefs, renderTop, renderStack, renderDevice } from '../../../playground/render.js';

const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const saved = vscode.getState() ?? {};
const state = { hidden: new Set(saved.hidden ?? []), tab: saved.tab ?? 'stack', last: null, cursorObj: null, hoverObj: null };
const save = () => vscode.setState({ hidden: [...state.hidden], tab: state.tab });

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'update') { state.last = m; draw(); }
  if (m.type === 'cursor') { state.cursorObj = m.path; paintHighlight(); }
});

function draw() {
  const m = state.last;
  if (!m) return;
  document.documentElement.dataset.theme = m.theme;
  try {
    const model = buildModel(m.resolved, m.theme);
    $('defs').innerHTML = swatchDefs(model);
    const top = renderTop(model, state.hidden);
    $('top').innerHTML = top.svg;
    topZoom.apply();
    renderLegend(top.legend);
    $('stack').innerHTML = renderStack(model);
    $('device').innerHTML = renderDevice(model);
    $('json').textContent = JSON.stringify(m.resolved, (k, v) => (k === 'attr_src' ? undefined : v), 2);
  } catch (err) {
    $('top').textContent = `Preview error: ${err.message}`;
  }
  $('file-label').textContent = `Top view, ${m.file}`;
  const status = $('status');
  status.className = m.errors ? 'has-errors' : m.warnings ? 'has-warnings' : 'ok';
  status.textContent = `${m.errors ? `${m.errors} error${m.errors > 1 ? 's' : ''}  ` : ''}${m.warnings ? `${m.warnings} warning${m.warnings > 1 ? 's' : ''}  ` : ''}${!m.errors && !m.warnings ? '' : ''}${m.objects} objects${m.modules ? `, ${m.modules} modules` : ''}`;
  paintHighlight();
}

// ---- links back to the source ------------------------------------------------------

for (const id of ['top', 'stack', 'device']) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    if (topZoom.dragged) return;
    const hit = e.target.closest('[data-src]');
    if (hit) vscode.postMessage({ type: 'reveal', src: hit.getAttribute('data-src') });
  });
  if (id !== 'top') {
    el.addEventListener('mouseover', (e) => { state.hoverObj = e.target.closest('[data-obj]')?.dataset.obj ?? null; paintHighlight(); });
    el.addEventListener('mouseleave', () => { state.hoverObj = null; paintHighlight(); });
  }
}

function paintHighlight() {
  const p = state.hoverObj ?? state.cursorObj;
  if (!p) { $('hl-style').textContent = ''; return; }
  const sel = `[data-obj="${CSS.escape(p)}"]`;
  $('hl-style').textContent = `
    svg ${sel}, svg ${sel} * { stroke: var(--hl-stroke) !important; stroke-width: 2px !important; vector-effect: non-scaling-stroke; opacity: 1 !important; }
    tr${sel} td, .derived-list ${sel}, h4${sel} { background: var(--hl) !important; }
    .legend-chip[data-name="${CSS.escape(p)}"] { background: var(--hl); }`;
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
      if (e.shiftKey && it.src) { vscode.postMessage({ type: 'reveal', src: it.src }); return; }
      if (state.hidden.has(it.name)) state.hidden.delete(it.name); else state.hidden.add(it.name);
      save();
      draw();
    });
    box.appendChild(chip);
  }
}

// ---- tabs ------------------------------------------------------------------------------

function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const id of ['stack', 'device', 'json']) $(id).hidden = id !== tab;
  save();
}
for (const btn of document.querySelectorAll('[data-tab]')) btn.addEventListener('click', () => showTab(btn.dataset.tab));
showTab(state.tab);

// ---- pan & zoom on the top view (as in the playground) --------------------------------

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
  const api = { dragged: false, apply() { if (vb && svg()) svg().setAttribute('viewBox', vb.join(' ')); } };
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
  window.addEventListener('pointerup', () => { drag = null; box.classList.remove('panning'); setTimeout(() => { api.dragged = false; }, 0); });
  box.addEventListener('dblclick', () => { vb = null; draw(); });
  return api;
})();

vscode.postMessage({ type: 'ready' });
