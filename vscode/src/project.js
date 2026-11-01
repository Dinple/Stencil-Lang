// Editor-independent logic of the extension: resolve an open file as the main
// module of a project, and decide which diagnostics each file shows.
// No `vscode` import here, so it is tested with plain node (test/*.test.mjs).

import * as path from 'node:path';
import { resolveProject } from '../../core/resolve.js';

/**
 * Resolve `mainAbs` with imports looked up from `rootAbs`.
 * `read(abs)` returns the text of a file (open editor first, then disk) or null.
 * Returns { result, files, byFile } where `files` are the absolute paths the
 * project loaded and `byFile` maps an absolute path to its diagnostics.
 */
export function resolveFile(mainAbs, rootAbs, read) {
  const rel = (abs) => path.relative(rootAbs, abs).split(path.sep).join('/');
  const abs = (r) => path.resolve(rootAbs, ...r.split('/'));
  const files = new Set();
  const main = rel(mainAbs);
  const result = resolveProject({
    main,
    load: (p) => {
      const t = read(abs(p));
      if (t != null) files.add(abs(p));
      return t;
    },
  });
  const byFile = new Map();
  for (const d of result.diags) {
    const f = abs(d.file ?? main);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(d);
  }
  return { result, files, byFile, main: mainAbs, root: rootAbs, rel, abs };
}

/**
 * Diagnostics shown per file, from the resolutions of every open main file.
 * A file imported by another open file shows what that importer's resolution
 * says about it (bindings and patches apply there); a file nobody imports
 * shows its own resolution. Duplicates (same code and place) are dropped.
 */
export class DiagnosticBook {
  constructor() { this.byMain = new Map(); }

  set(entry) { this.byMain.set(entry.main, entry); }
  delete(main) { this.byMain.delete(main); }

  // every file any entry knows about
  files() {
    const out = new Set();
    for (const e of this.byMain.values()) { for (const f of e.files) out.add(f); out.add(e.main); for (const f of e.byFile.keys()) out.add(f); }
    return out;
  }

  // diagnostics for one file
  forFile(file) {
    const importers = [...this.byMain.values()].filter((e) => e.main !== file && e.files.has(file));
    const sources = importers.length ? importers : [this.byMain.get(file)].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const e of sources) {
      for (const d of e.byFile.get(file) ?? []) {
        const key = `${d.code}|${d.from}|${d.to}|${d.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(d);
      }
    }
    return out;
  }
}

// Root folder for imports: the configured root (relative to the workspace
// folder), else the workspace folder, else the file's own folder.
export function rootFor(fileAbs, workspaceFolderAbs, configuredRoot) {
  if (workspaceFolderAbs) return configuredRoot ? path.resolve(workspaceFolderAbs, configuredRoot) : workspaceFolderAbs;
  return path.dirname(fileAbs);
}

// data-src in the preview is "file:line:col" (file relative to the root) or "line:col".
export function parseSrc(src, mainRel) {
  const m = /^(?:(.*):)?(\d+):(\d+)$/.exec(src ?? '');
  return m ? { file: m[1] ?? mainRel, line: +m[2], col: +m[3] } : null;
}
