// Runs inside the VS Code extension host (see run.mjs).
const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');

const ws = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`); await sleep(100); }
}
const codes = (uri) => vscode.languages.getDiagnostics(uri).map((d) => d.code);

const log = [];
async function run() {
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { log.push(`FAIL ${name}: ${e.message}`); throw e; }
    log.push(`ok  ${name}`);
  };
  const main = vscode.Uri.file(path.join(ws(), 'main.stencil'));
  const lib = vscode.Uri.file(path.join(ws(), 'lib', 'front.stencil'));
  const doc = await vscode.workspace.openTextDocument(main);
  const ed = await vscode.window.showTextDocument(doc);

  await step('the language is registered and the extension activates', async () => {
    assert.equal(doc.languageId, 'stencil');
    await until(() => vscode.extensions.getExtension('dinple.stencil-lang')?.isActive, 'activation');
  });

  await step('diagnostics: the off-grid pitch is C070, with no other errors', async () => {
    await until(() => codes(main).includes('C070'), 'C070 on main.stencil');
    const errs = vscode.languages.getDiagnostics(main).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.deepEqual(errs.map((d) => d.code), ['C070']);
    assert.equal(errs[0].range.start.line, doc.getText().split('\n').findIndex((l) => l.includes('2/3 * 44nm')));
  });

  await step('a library imported by an open file shows no standalone errors', async () => {
    await vscode.workspace.openTextDocument(lib);
    await sleep(800);
    assert.deepEqual(codes(lib), []);
  });

  await step('quick fix: snap the value onto the grid', async () => {
    const diag = vscode.languages.getDiagnostics(main).find((d) => d.code === 'C070');
    const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', main, diag.range);
    const fix = actions.find((a) => a.kind?.value === 'quickfix');
    assert.ok(fix, JSON.stringify(actions.map((a) => a.title)));
    await vscode.workspace.applyEdit(fix.edit);
    await until(() => !codes(main).includes('C070'), 'C070 cleared after the fix');
  });

  await step('completion offers attributes of the enclosing kind', async () => {
    await ed.edit((e) => e.insert(new vscode.Position(doc.lineCount, 0), '\nlayer M3 { dir'));
    const end = doc.positionAt(doc.getText().length);
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', main, end);
    assert.ok(list.items.some((i) => (i.label.label ?? i.label) === 'direction'));
    await ed.edit((e) => e.insert(doc.positionAt(doc.getText().length), 'ection = vertical }\n'));
  });

  await step('hover documents an attribute', async () => {
    const pos = doc.positionAt(doc.getText().indexOf('pitch') + 1);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', main, pos);
    const text = hovers.flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join('\n');
    assert.match(text, /layer\.pitch/);
  });

  await step('outline lists the objects', async () => {
    await until(() => !codes(main).includes('C070'), 'resolved');
    const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', main);
    const names = syms.map((s) => s.name);
    for (const n of ['M2', 'V1', 'VIA1']) assert.ok(names.includes(n), JSON.stringify(names));
  });

  await step('go to definition jumps into the imported module', async () => {
    const pos = doc.positionAt(doc.getText().indexOf('fs.M1') + 4);
    const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', main, pos);
    assert.ok(defs.length > 0 && (defs[0].uri ?? defs[0].targetUri).fsPath === lib.fsPath, JSON.stringify(defs));
  });

  await step('the preview opens beside the editor', async () => {
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('stencil.openPreviewToSide');
    await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputWebview && /Preview main\.stencil/.test(t.label)), 'preview tab');
  });

  await step('show resolved JSON opens a JSON document', async () => {
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('stencil.showResolved');
    await until(() => vscode.window.activeTextEditor?.document.languageId === 'json', 'json editor');
    const json = JSON.parse(vscode.window.activeTextEditor.document.getText());
    assert.ok(json.objects.some((o) => o.name === 'VIA1'));
  });

  return log;
}

// Results also go to a file next to this script (the Windows launcher does
// not pass the exit code back through WSL).
async function runAndReport() {
  const fs = require('node:fs');
  const out = path.join(__dirname, 'results.json');
  try {
    const log = await run();
    fs.writeFileSync(out, JSON.stringify({ ok: true, log }, null, 2));
  } catch (e) {
    fs.writeFileSync(out, JSON.stringify({ ok: false, log, error: String(e && e.stack || e) }, null, 2));
    throw e;
  }
}

module.exports = { run: runAndReport };
