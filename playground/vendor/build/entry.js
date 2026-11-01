// Everything the playground imports from CodeMirror, bundled into one file so
// that the playground runs offline with no install step.
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, ViewPlugin } from '@codemirror/view';
export { EditorState, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
export { StreamLanguage, LanguageSupport, syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter } from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { setDiagnostics, lintGutter } from '@codemirror/lint';
export { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, startCompletion, currentCompletions } from '@codemirror/autocomplete';
export { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
export { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
