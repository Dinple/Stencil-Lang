// In-browser self-test of the live loop: open /playground/?selftest
// Results are written to <pre id="selftest"> and document.body.dataset.selftest.

import { startCompletion, currentCompletions } from './vendor/codemirror.js';

export async function selftest({ view, $ }) {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = () => view.state.doc.length;
  const type = (text, at = end()) => view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' });
  const removeLine = (prefix) => {
    const doc = view.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const l = doc.line(i);
      if (l.text.startsWith(prefix)) { view.dispatch({ changes: { from: l.from, to: Math.min(l.to + 1, doc.length) } }); return; }
    }
  };
  const completions = async (text) => {
    type(text);
    startCompletion(view);
    await wait(250);
    const labels = currentCompletions(view.state).map((o) => o.label);
    const from = end() - text.length;
    view.dispatch({ changes: { from, to: end() } });
    return labels;
  };

  const BASE = [
    'stencil 0.1', 'technology { grid = 1nm }',
    'layer M0 { role = conductor; direction = horizontal; width = 20nm; pitch = 40nm }',
    'site CORE { width = 48nm; height = 240nm }', '',
  ].join('\n');
  try {
    view.dispatch({ changes: { from: 0, to: end(), insert: BASE } });
    await wait(300);
    const rectsBefore = $('top').querySelectorAll('rect').length;
    type('\nlayer M2 { role = conductor; direction = horizontal; width = 20nm; pitch = 60nm }\n');
    await wait(300);
    check('typing a layer adds it to the legend', [...$('legend').children].some((c) => c.dataset.name === 'M2'));
    check('typing a layer adds shapes', $('top').querySelectorAll('rect').length > rectsBefore, `${rectsBefore} -> ${$('top').querySelectorAll('rect').length}`);

    type('layer BAD { role = conductr }\n');
    await wait(300);
    check('a typo shows an error with a hint', $('diag-summary').className === 'has-errors' && $('diag-list').textContent.includes("did you mean 'conductor'"), $('diag-list').textContent.slice(0, 120));
    check('the drawing is kept while there is an error', $('top').querySelectorAll('[data-obj="M2"]').length > 0);

    removeLine('layer BAD');
    await wait(300);
    check('fixing the typo clears the error', $('diag-summary').className === 'ok', $('diag-summary').textContent);

    type('layer FIXME { role = conductr }\n');
    await wait(300);
    $('diag-list').querySelector('.fix')?.click();
    await wait(300);
    check('clicking a fix in the lint box repairs the code', view.state.doc.toString().includes('layer FIXME { role = conductor }') && $('diag-summary').className === 'ok',
      $('diag-list').textContent.slice(0, 120));
    removeLine('layer FIXME');

    type('layer FIX2 { role = conductr; pich = 40nm; width = 20 }\n');
    await wait(300);
    const nFix = $('diag-list').querySelectorAll('.fix').length;
    $('fix-all').click();
    await wait(300);
    check('Fix all applies every fix at once', nFix === 3 && view.state.doc.toString().includes('layer FIX2 { role = conductor; pitch = 40nm; width = 20nm }') && $('diag-summary').className === 'ok',
      `${nFix} fixes; ${$('diag-list').textContent.slice(0, 120)}`);
    removeLine('layer FIX2');
    await wait(300);

    check('the stack table lists the layer with tracks per row', ($('stack').querySelector('tr[data-obj="M2"]')?.textContent ?? '').includes('/ row'),
      $('stack').querySelector('tr[data-obj="M2"]')?.textContent.replace(/\s+/g, ' '));
    $('theme').click();
    await wait(100);
    const dark = document.documentElement.dataset.theme === 'dark';
    $('theme').click();
    await wait(100);
    check('the theme button switches dark and back', dark && document.documentElement.dataset.theme === 'light');

    $('top').querySelector('[data-obj="M2"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(50);
    const lineText = view.state.doc.lineAt(view.state.selection.main.head).text;
    check('clicking a shape jumps to its definition', lineText.startsWith('layer M2'), lineText);
    check('the cursor highlights the object it is in', $('hl-style').textContent.includes('"M2"'));

    const attrs = await completions('layer M3 { pi');
    check('completion suggests attributes of the enclosing kind', attrs.includes('pitch'), attrs.slice(0, 8).join(','));
    const roles = await completions('layer M4 { role = ');
    check('completion suggests enum values', roles.includes('conductor') && roles.includes('cut'), roles.slice(0, 8).join(','));
    const refs = await completions('connector VX { lower = ');
    check('completion suggests declared layers', refs.includes('M0') && refs.includes('M2'), refs.slice(0, 8).join(','));
    const kinds = await completions('\nsit');
    check('completion suggests object kinds at top level', kinds.includes('site'), kinds.slice(0, 8).join(','));

    view.dispatch({ changes: { from: 0, to: end(), insert: 'stencil 0.1\ntechnology { grid = 1nm }\nlayer A { role = conductor; pitch = 2/3 * 44nm }\n' } });
    await wait(300);
    check('an off-grid value is reported', $('diag-list').textContent.includes('not on the 1nm grid'), $('diag-list').textContent.slice(0, 120));
  } catch (e) {
    check('self-test ran to completion', false, e.stack ?? e.message);
  }

  const pre = document.createElement('pre');
  pre.id = 'selftest';
  pre.textContent = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   [${r.detail}]`}`).join('\n');
  document.body.appendChild(pre);
  document.body.dataset.selftest = results.every((r) => r.ok) ? 'pass' : 'fail';
}
