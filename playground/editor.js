// CodeMirror setup: Stencil highlighting, inline diagnostics, and
// vocabulary-driven autocompletion (VOCABULARY.md is the only source of names).

import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  EditorState, StreamLanguage, LanguageSupport, syntaxHighlighting, HighlightStyle, bracketMatching,
  indentOnInput, tags, setDiagnostics, lintGutter, autocompletion, closeBrackets, closeBracketsKeymap,
  completionKeymap, defaultKeymap, history, historyKeymap, indentWithTab, searchKeymap, highlightSelectionMatches,
} from './vendor/codemirror.js';
import { KEYWORDS, LITERALS } from '../core/lexer.js';
import { complete } from '../core/assist.js';

// ---- highlighting -----------------------------------------------------------------

const stencilLang = StreamLanguage.define({
  name: 'stencil',
  startState: () => ({ expectName: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    const ch = stream.peek();
    if (ch === '#') { stream.skipToEnd(); return 'comment'; }
    if (ch === '"') {
      stream.next();
      while (!stream.eol()) { const c = stream.next(); if (c === '\\') { stream.next(); continue; } if (c === '"') break; }
      return 'string';
    }
    if (stream.match(/^\d+(\.\d+)?(nm|um)?/)) return 'number';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current();
      if (state.expectName) { state.expectName = false; if (stream.match(/^\s*\{/, false)) return 'def'; }
      if (KEYWORDS.has(w)) return 'keyword';
      if (LITERALS.has(w)) return 'atom';
      if (stream.match(/^\s*=/, false)) return 'attr';
      if (stream.match(/^\s*\(/, false)) return 'fn';
      if (stream.match(/^\s*([A-Za-z_]\w*\s*)?\{/, false)) { state.expectName = true; return 'kind'; }
      return 'name';
    }
    if (stream.match('..') || stream.match(/^[=+\-*/]/)) return 'operator';
    if (stream.match('&')) return 'keyword';
    stream.next();
    return 'punct';
  },
  tokenTable: {
    comment: tags.comment, string: tags.string, number: tags.number, keyword: tags.keyword, atom: tags.atom,
    attr: tags.propertyName, fn: tags.function(tags.variableName), kind: tags.typeName,
    def: tags.definition(tags.variableName), name: tags.variableName, operator: tags.operator, punct: tags.punctuation,
  },
  languageData: { commentTokens: { line: '#' } },
});

// Colours come from CSS variables so the light/dark switch needs no reconfiguration.
const highlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--code-keyword)', fontWeight: '600' },
  { tag: tags.typeName, color: 'var(--code-kind)', fontWeight: '600' },
  { tag: tags.definition(tags.variableName), color: 'var(--code-def)', fontWeight: '700' },
  { tag: tags.propertyName, color: 'var(--code-attr)' },
  { tag: tags.number, color: 'var(--code-number)' },
  { tag: tags.string, color: 'var(--code-string)' },
  { tag: tags.atom, color: 'var(--code-atom)' },
  { tag: tags.function(tags.variableName), color: 'var(--code-atom)', fontStyle: 'italic' },
  { tag: tags.variableName, color: 'var(--ink)' },
  { tag: tags.operator, color: 'var(--code-punct)' },
  { tag: tags.punctuation, color: 'var(--code-punct)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--paper)', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--ink)', padding: '8px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--paper-2)', color: 'var(--muted)', borderRight: '1px solid var(--faint)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hl) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--hl)', outline: '1px solid var(--muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--paper)', border: '1.5px solid var(--rule)', boxShadow: '3px 3px 0 var(--rule)', color: 'var(--ink)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--ink)', color: 'var(--paper)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'italic', marginLeft: '1em' },
  '.cm-completionInfo': { maxWidth: '320px', padding: '6px 9px', whiteSpace: 'pre-wrap' },
  '.cm-diagnostic': { fontFamily: 'var(--mono)', fontSize: '12px', padding: '4px 8px' },
  '.cm-diagnosticAction': { backgroundColor: 'var(--ink)', color: 'var(--paper)', borderRadius: '2px', padding: '1px 8px', marginLeft: '10px', font: '12px var(--mono)' },
  '.cm-diagnosticSource': { color: 'var(--muted)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--err)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
});

// ---- completion -------------------------------------------------------------------
// The logic is shared with the VS Code extension (core/assist.js).

function completeStencil(ctx) {
  const r = complete(ctx.state.doc.toString(), ctx.pos, ctx.explicit);
  if (!r) return null;
  const valueLike = r.items.some((i) => i.type === 'enum' || i.type === 'function');
  return { from: r.from, options: r.items, validFor: valueLike ? /^[\w.]*$/ : /^\w*$/ };
}

// ---- public API -------------------------------------------------------------------

let extensions = [];

// One editor view; each project file keeps its own state (text, undo history).
export function createEditor(parent, doc, { onChange, onCursor }) {
  extensions = [
    lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(),
    bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches(),
    new LanguageSupport(stencilLang, [stencilLang.data.of({ autocomplete: completeStencil })]),
    syntaxHighlighting(highlight), autocompletion({ activateOnTyping: true, icons: false }), lintGutter(),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    theme, EditorState.tabSize.of(2),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) onCursor(u.state.selection.main.head);
    }),
  ];
  return new EditorView({ parent, state: newState(doc) });
}

export function newState(doc) {
  return EditorState.create({ doc, extensions });
}

export function showDiagnostics(view, diags) {
  const len = view.state.doc.length;
  const cm = diags.map((d) => {
    const from = Math.min(d.from, len);
    const out = {
      from, to: Math.min(Math.max(d.to, d.from), len),
      severity: d.severity, source: d.code,
      message: d.hint ? `${d.message}, ${d.hint}` : d.message,
    };
    if (d.fix) {
      // Fix offsets are relative to the diagnostic, so they follow edits made since.
      const dFrom = d.fix.from - d.from, dTo = d.fix.to - d.from;
      out.actions = [{ name: d.fix.label, apply: (v, at) => applyFix(v, { from: at + dFrom, to: at + dTo, insert: d.fix.insert }) }];
    }
    return out;
  });
  view.dispatch(setDiagnostics(view.state, cm));
}

export function applyFix(view, fix) {
  view.dispatch({ changes: fix, userEvent: 'input.fix' });
  view.focus();
}

// Apply many fixes in one undoable step; overlapping ones are skipped.
export function applyFixes(view, fixes) {
  const sorted = [...fixes].sort((a, b) => a.from - b.from);
  const changes = [];
  let end = -1;
  for (const f of sorted) {
    if (f.from < end) continue;
    changes.push({ from: f.from, to: f.to, insert: f.insert });
    end = Math.max(end, f.to);
  }
  view.dispatch({ changes, userEvent: 'input.fix' });
  view.focus();
  return changes.length;
}

export function jumpTo(view, line, col = 1) {
  const doc = view.state.doc;
  const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
  const pos = Math.min(l.from + col - 1, l.to);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

export function setDoc(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
