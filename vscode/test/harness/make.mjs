// Build a standalone HTML page that runs the preview webview script with a fake
// VS Code API and a real resolved project, for screenshots in a browser.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProject } from '../../../core/resolve.js';

const [main, theme = 'light', tab = 'stack', out = 'test/harness/preview.html'] = process.argv.slice(2);
const root = '../examples';
const r = resolveProject({ main, load: (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return null; } } });
const msg = { type: 'update', resolved: r.resolved, theme, file: main, errors: r.diags.filter((d) => d.severity === 'error').length, warnings: r.diags.filter((d) => d.severity === 'warning').length, objects: r.resolved.objects.length, modules: r.resolved.modules.length };
const html = `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<style>${readFileSync('dist/style.css', 'utf8')}</style><style>${readFileSync('dist/preview.css', 'utf8')}</style><style id="hl-style"></style></head><body>
<div id="viz-pane">
  <section class="window" id="top-win">
    <div class="titlebar"><span class="title" id="file-label">Top view</span></div>
    <div class="toolbar"><div id="legend"></div><span class="hint">scroll: zoom, drag: pan, double-click: fit, click: go to source</span></div>
    <div class="canvas" id="top"></div>
  </section>
  <section class="window" id="bottom-win">
    <div class="titlebar tabs">
      <button data-tab="stack" class="title active">Stack</button>
      <button data-tab="device" class="title">Device</button>
      <button data-tab="json" class="title">Resolved JSON</button>
      <span id="status"></span>
    </div>
    <div class="pane" id="stack"></div><div class="pane" id="device" hidden></div><pre class="pane" id="json" hidden></pre>
  </section>
</div><div id="defs"></div>
<script>
window.sent = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.sent.push(m); document.title = JSON.stringify(window.sent.slice(-1)); }, getState: () => ({ tab: ${JSON.stringify(tab)} }), setState: () => {} });
</script>
<script>${readFileSync('dist/preview.js', 'utf8')}</script>
<script>window.postMessage(${JSON.stringify(msg)}, '*');</script>
</body></html>`;
writeFileSync(out, html);
console.log(out, r.diags.filter((d) => d.severity === 'error').length, 'errors');
