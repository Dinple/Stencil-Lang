// Stencil for VS Code: diagnostics with quick fixes, completion, hover,
// outline, go to definition, and a live preview beside the editor.
// The language itself comes from ../../core (the same code as the playground
// and the command line); see project.js for the editor-independent parts.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveFile, DiagnosticBook, rootFor, parseSrc } from './project.js';
import { complete, hover } from '../../core/assist.js';

const LANG = 'stencil';
const isStencil = (doc) => doc?.languageId === LANG && doc.uri.scheme === 'file';

let collection;
const book = new DiagnosticBook();
const published = new Set();          // file paths that currently show diagnostics
const fixes = new Map();              // `${file}|${code}|${from}|${to}` -> { fix, version }
const timers = new Map();
let preview = null;

// ---- reading files: open editors first (unsaved text), then disk -------------------

function read(abs) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === abs);
  if (doc) return doc.getText();
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

function rootOf(doc) {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const configured = vscode.workspace.getConfiguration('stencil', doc.uri).get('root') || '';
  return rootFor(doc.uri.fsPath, folder?.uri.fsPath, configured);
}

// ---- resolving and publishing ------------------------------------------------------

function resolveDoc(doc) {
  const entry = resolveFile(doc.uri.fsPath, rootOf(doc), read);
  entry.versions = new Map(vscode.workspace.textDocuments.filter(isStencil).map((d) => [d.uri.fsPath, d.version]));
  book.set(entry);
  return entry;
}

function toDiagnostic(d) {
  const range = new vscode.Range(
    Math.max(0, (d.line ?? 1) - 1), Math.max(0, (d.col ?? 1) - 1),
    Math.max(0, (d.end_line ?? d.line ?? 1) - 1), Math.max(0, (d.end_col ?? (d.col ?? 1) + 1) - 1),
  );
  const severity = d.severity === 'error' ? vscode.DiagnosticSeverity.Error
    : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const message = (d.instance ? `[${d.instance}] ` : '') + d.message + (d.hint ? `, ${d.hint}` : '');
  const diag = new vscode.Diagnostic(range, message, severity);
  diag.source = 'stencil';
  diag.code = d.code;
  return diag;
}

function publish() {
  const files = book.files();
  for (const f of published) if (!files.has(f)) { collection.delete(vscode.Uri.file(f)); published.delete(f); }
  fixes.clear();
  for (const f of files) {
    const ds = book.forFile(f);
    if (!ds.length) { if (published.has(f)) { collection.delete(vscode.Uri.file(f)); published.delete(f); } continue; }
    const version = [...book.byMain.values()].find((e) => e.versions?.has(f))?.versions.get(f);
    for (const d of ds) if (d.fix) fixes.set(`${f}|${d.code}|${d.from}|${d.to}`, { fix: d.fix, version });
    collection.set(vscode.Uri.file(f), ds.map(toDiagnostic));
    published.add(f);
  }
}

// Resolve a document, and every open main that imports it, after a short delay.
function schedule(doc) {
  if (!isStencil(doc)) return;
  const key = doc.uri.fsPath;
  clearTimeout(timers.get(key));
  const delay = vscode.workspace.getConfiguration('stencil').get('diagnostics.delay') ?? 250;
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    const mains = new Set([key]);
    for (const e of book.byMain.values()) if (e.files.has(key)) mains.add(e.main);
    for (const m of mains) {
      const d = vscode.workspace.textDocuments.find((x) => x.uri.fsPath === m);
      if (d) { try { resolveDoc(d); } catch (err) { console.error('stencil:', err); } }
    }
    publish();
    preview?.refresh();
  }, delay));
}

// ---- quick fixes ---------------------------------------------------------------------

class FixProvider {
  provideCodeActions(doc, _range, context) {
    const actions = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== 'stencil') continue;
      const hit = [...fixes.entries()].find(([k]) => {
        const [file, code] = k.split('|');
        return file === doc.uri.fsPath && code === String(diag.code) && rangeOfFix(doc, fixes.get(k).fix).intersection(diag.range);
      });
      if (!hit) continue;
      const { fix, version } = hit[1];
      if (version !== undefined && version !== doc.version) continue;     // stale: wait for the next resolution
      const action = new vscode.CodeAction(fix.label ?? 'Apply fix', vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(doc.uri, rangeOfFix(doc, fix), fix.insert);
      actions.push(action);
    }
    return actions;
  }
}

function rangeOfFix(doc, fix) {
  return new vscode.Range(doc.positionAt(fix.from), doc.positionAt(fix.to));
}

async function fixAll() {
  const ed = vscode.window.activeTextEditor;
  if (!isStencil(ed?.document)) return;
  const doc = ed.document;
  const mine = [...fixes.entries()].filter(([k, v]) => k.startsWith(`${doc.uri.fsPath}|`) && (v.version === undefined || v.version === doc.version))
    .map(([, v]) => v.fix).sort((a, b) => b.from - a.from);
  // apply from the end, skipping overlapping fixes
  const edit = new vscode.WorkspaceEdit();
  let floor = Infinity, n = 0;
  for (const f of mine) { if (f.to > floor) continue; edit.replace(doc.uri, rangeOfFix(doc, f), f.insert); floor = f.from; n++; }
  if (n) await vscode.workspace.applyEdit(edit);
  vscode.window.setStatusBarMessage(`Stencil: applied ${n} fix${n === 1 ? '' : 'es'}`, 3000);
}

// ---- completion, hover, outline, definition --------------------------------------------

const KIND_OF = {
  class: vscode.CompletionItemKind.Class, property: vscode.CompletionItemKind.Property, enum: vscode.CompletionItemKind.EnumMember,
  variable: vscode.CompletionItemKind.Variable, constant: vscode.CompletionItemKind.Constant,
  function: vscode.CompletionItemKind.Function, keyword: vscode.CompletionItemKind.Keyword,
};

const completionProvider = {
  provideCompletionItems(doc, pos, _token, ctx) {
    const offset = doc.offsetAt(pos);
    const r = complete(doc.getText(), offset, ctx.triggerKind === vscode.CompletionTriggerKind.Invoke);
    if (!r) return undefined;
    const range = new vscode.Range(doc.positionAt(r.from), pos);
    return r.items.map((it) => {
      const item = new vscode.CompletionItem(it.label, KIND_OF[it.type] ?? vscode.CompletionItemKind.Text);
      item.range = range;
      item.insertText = it.apply ?? it.label;
      if (it.detail) item.detail = it.detail;
      if (it.info) item.documentation = new vscode.MarkdownString(it.info);
      item.sortText = `${9 - (it.boost ?? 0)}_${it.label}`;
      return item;
    });
  },
};

const hoverProvider = {
  provideHover(doc, pos) {
    const h = hover(doc.getText(), doc.offsetAt(pos));
    if (!h) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${h.title}**\n\n`);
    md.appendText(h.doc);
    return new vscode.Hover(md, new vscode.Range(doc.positionAt(h.from), doc.positionAt(h.to)));
  },
};

// the latest resolution that covers a file (as main, else as an import)
function entryFor(fsPath) {
  return book.byMain.get(fsPath) ?? [...book.byMain.values()].find((e) => e.files.has(fsPath));
}

const SYMBOL_KIND = { layer: vscode.SymbolKind.Field, connector: vscode.SymbolKind.Interface, rule: vscode.SymbolKind.Constant, site: vscode.SymbolKind.Class, cross: vscode.SymbolKind.Struct, check: vscode.SymbolKind.Event, technology: vscode.SymbolKind.Module };

const symbolProvider = {
  provideDocumentSymbols(doc) {
    const e = entryFor(doc.uri.fsPath) ?? resolveDoc(doc);
    const rel = e.rel(doc.uri.fsPath);
    const spans = (e.result.spans ?? []).filter((s) => s.file === rel).sort((a, b) => a.from - b.from);
    const roots = [];
    const byPath = new Map();
    for (const s of spans) {
      const name = s.path.split('.').pop();
      const range = new vscode.Range(doc.positionAt(s.from), doc.positionAt(s.to));
      const sym = new vscode.DocumentSymbol(name, s.kind, SYMBOL_KIND[s.kind] ?? vscode.SymbolKind.Object, range, range);
      byPath.set(s.path, sym);
      const parent = s.path.includes('.') ? byPath.get(s.path.slice(0, s.path.lastIndexOf('.'))) : null;
      (parent ? parent.children : roots).push(sym);
    }
    return roots;
  },
};

const definitionProvider = {
  provideDefinition(doc, pos) {
    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_][\w.]*/);
    if (!range) return undefined;
    const word = doc.getText(range);
    const e = entryFor(doc.uri.fsPath) ?? resolveDoc(doc);
    const rel = e.rel(doc.uri.fsPath);
    const spans = e.result.spans ?? [];
    const last = word.split('.').pop();
    const here = spans.find((s) => s.file === rel && s.path === word);
    const anywhere = spans.filter((s) => s.path === word || s.path === last);
    const target = here ?? (anywhere.length === 1 ? anywhere[0] : anywhere.find((s) => s.path === last));
    if (!target) return undefined;
    const uri = vscode.Uri.file(e.abs(target.file));
    const tdoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (tdoc) return new vscode.Location(uri, tdoc.positionAt(target.from));
    const text = read(uri.fsPath) ?? '';
    const before = text.slice(0, target.from).split('\n');
    return new vscode.Location(uri, new vscode.Position(before.length - 1, before[before.length - 1].length));
  },
};

// ---- preview ---------------------------------------------------------------------------

class Preview {
  constructor(context, column) {
    this.context = context;
    this.doc = vscode.window.activeTextEditor?.document;
    this.panel = vscode.window.createWebviewPanel('stencilPreview', 'Stencil Preview', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'icon.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => { preview = null; });
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
  }

  html() {
    const w = this.panel.webview;
    const res = (f) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', f));
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!doctype html>
<html lang="en" data-theme="${themeName()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${res('style.css')}">
<link rel="stylesheet" href="${res('preview.css')}">
<style id="hl-style"></style>
</head>
<body>
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
    <div class="pane" id="stack"></div>
    <div class="pane" id="device" hidden></div>
    <pre class="pane" id="json" hidden></pre>
  </section>
</div>
<div id="defs"></div>
<script nonce="${nonce}" src="${res('preview.js')}"></script>
</body>
</html>`;
  }

  follow(doc) {
    if (!isStencil(doc)) return;
    this.doc = doc;
    this.refresh();
  }

  refresh() {
    if (!this.doc) return;
    const e = book.byMain.get(this.doc.uri.fsPath) ?? resolveDoc(this.doc);
    const r = e.result;
    const errors = r.diags.filter((d) => d.severity === 'error').length;
    const warnings = r.diags.filter((d) => d.severity === 'warning').length;
    this.panel.title = `Preview ${path.basename(this.doc.uri.fsPath)}`;
    this.panel.webview.postMessage({
      type: 'update', resolved: r.resolved, theme: themeName(), file: e.rel(this.doc.uri.fsPath),
      errors, warnings, objects: r.resolved.objects.length, modules: r.resolved.modules.length,
    });
    this.sendCursor();
  }

  // highlight the object under the editor cursor
  sendCursor() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !this.doc || ed.document !== this.doc) return;
    const e = book.byMain.get(this.doc.uri.fsPath);
    if (!e) return;
    const rel = e.rel(this.doc.uri.fsPath);
    const pos = this.doc.offsetAt(ed.selection.active);
    let best = null;
    for (const s of e.result.spans ?? []) {
      if (s.file !== rel || pos < s.from || pos > s.to) continue;
      if (!best || s.to - s.from < best.to - best.from) best = s;
    }
    this.panel.webview.postMessage({ type: 'cursor', path: best?.path ?? null });
  }

  async onMessage(m) {
    if (m.type === 'ready') { this.refresh(); return; }
    if (m.type !== 'reveal' || !this.doc) return;
    const e = book.byMain.get(this.doc.uri.fsPath);
    const loc = parseSrc(m.src, e?.rel(this.doc.uri.fsPath));
    if (!loc || !e) return;
    const uri = vscode.Uri.file(e.abs(loc.file));
    const pos = new vscode.Position(loc.line - 1, Math.max(0, loc.col - 1));
    const column = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.fsPath === uri.fsPath)?.viewColumn
      ?? (this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
    const ed = await vscode.window.showTextDocument(uri, { viewColumn: column, selection: new vscode.Range(pos, pos) });
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

function themeName() {
  const k = vscode.window.activeColorTheme.kind;
  return k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast ? 'dark' : 'light';
}

function openPreview(context, column) {
  const doc = vscode.window.activeTextEditor?.document;
  if (!isStencil(doc)) { vscode.window.showInformationMessage('Open a .stencil file first.'); return; }
  if (!book.byMain.has(doc.uri.fsPath)) resolveDoc(doc);
  if (preview) { preview.panel.reveal(column, true); preview.follow(doc); return; }
  preview = new Preview(context, column);
}

async function showResolved() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!isStencil(doc)) return;
  const e = resolveDoc(doc);
  const json = JSON.stringify(e.result.resolved, (k, v) => (k === 'attr_src' ? undefined : v), 2);
  const out = await vscode.workspace.openTextDocument({ language: 'json', content: json });
  await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

// ---- activation ------------------------------------------------------------------------

export function activate(context) {
  collection = vscode.languages.createDiagnosticCollection('stencil');
  const sel = { language: LANG, scheme: 'file' };
  context.subscriptions.push(
    collection,
    vscode.languages.registerCodeActionsProvider(sel, new FixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCompletionItemProvider(sel, completionProvider, '=', ' ', '{', '(', '[', ','),
    vscode.languages.registerHoverProvider(sel, hoverProvider),
    vscode.languages.registerDocumentSymbolProvider(sel, symbolProvider),
    vscode.languages.registerDefinitionProvider(sel, definitionProvider),
    vscode.commands.registerCommand('stencil.openPreview', () => openPreview(context, vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('stencil.openPreviewToSide', () => openPreview(context, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('stencil.showResolved', showResolved),
    vscode.commands.registerCommand('stencil.fixAll', fixAll),
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (!isStencil(doc)) return;
      book.delete(doc.uri.fsPath);
      publish();
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (preview && isStencil(ed?.document)) preview.follow(ed.document); }),
    vscode.window.onDidChangeTextEditorSelection((e) => { if (preview && e.textEditor.document === preview.doc) preview.sendCursor(); }),
    vscode.window.onDidChangeActiveColorTheme(() => preview?.refresh()),
  );
  for (const doc of vscode.workspace.textDocuments) schedule(doc);
}

export function deactivate() {
  for (const t of timers.values()) clearTimeout(t);
}
