// Build the extension: dist/extension.js (Node, CommonJS) and dist/preview.js
// (webview, browser), bundling the language from ../core and the renderer from
// ../playground; copy the stylesheet and icon next to them.
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });
copyFileSync('../playground/style.css', 'dist/style.css');
copyFileSync('media/preview.css', 'dist/preview.css');
copyFileSync('media/icon.svg', 'dist/icon.svg');

const targets = [
  { entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node18' },
  { entryPoints: ['src/preview/main.js'], outfile: 'dist/preview.js', platform: 'browser', format: 'iife', target: 'es2022' },
];
for (const t of targets) {
  const opts = { bundle: true, sourcemap: false, minify: false, logLevel: 'info', ...t };
  if (watch) await (await context(opts)).watch();
  else await build(opts);
}
