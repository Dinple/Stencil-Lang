// Stencil lexer (SPEC.md section 2.1).

import { Q } from './rational.js';

// Unit -> nanometres.
export const UNITS = { nm: Q.int(1), um: Q.int(1000) };

export const KEYWORDS = new Set(['stencil', 'import', 'as', 'drop']);
export const LITERALS = new Set(['true', 'false', 'none', 'required']);

const PUNCT = new Set(['{', '}', '[', ']', '(', ')', ',', ';', '=', '&', '+', '-', '*', '/', '<', '>']);
// Two-character operators (comparisons, Core 0.2).
const PUNCT2 = new Set(['==', '!=', '<=', '>=']);

// fix (optional): { from, to, insert, label }, a machine-applicable edit.
export function diag(code, severity, from, to, message, hint, fix) {
  return { code, severity, from, to, message, ...(hint ? { hint } : {}), ...(fix ? { fix } : {}) };
}

// Returns { tokens, diags }. Token: { t, v, text, from, to }.
// t is 'name' | 'num' | 'len' | 'str' | 'nl' | 'eof' | a punctuation string | '..' | '.' | a comparison.
// Newlines inside [ ] and ( ) are dropped; a brace resets that depth so an
// unclosed bracket cannot swallow the rest of the file.
export function lex(src) {
  const tokens = [];
  const diags = [];
  let i = 0;
  let depth = 0;
  const push = (t, from, to, v) => tokens.push({ t, v, text: src.slice(from, to), from, to });

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      if (depth === 0) push('nl', i, i + 1);
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++;
    } else if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '"') {
      const from = i++;
      let text = '';
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < src.length) { text += src[i + 1]; i += 2; } else text += src[i++];
      }
      if (src[i] === '"') i++;
      else diags.push(diag('C001', 'error', from, i, 'unterminated string'));
      push('str', from, i, text);
    } else if (/[0-9]/.test(c)) {
      const from = i;
      while (/[0-9]/.test(src[i] ?? '')) i++;
      // A '.' starts a fraction only if a digit follows, so `1..4` is a range.
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i++;
        while (/[0-9]/.test(src[i] ?? '')) i++;
      }
      const numText = src.slice(from, i);
      const q = Q.decimal(numText);
      if (/[A-Za-z_]/.test(src[i] ?? '')) {
        const uFrom = i;
        while (/[A-Za-z0-9_]/.test(src[i] ?? '')) i++;
        const unit = src.slice(uFrom, i);
        if (UNITS[unit]) {
          push('len', from, i, { q: q.mul(UNITS[unit]), unit });
        } else {
          const near = Object.keys(UNITS).find((u) => unit.startsWith(u) || u.startsWith(unit));
          diags.push(diag('C001', 'error', uFrom, i, `unknown unit '${unit}'`,
            `units are ${Object.keys(UNITS).join(', ')}`, near && { from: uFrom, to: i, insert: near, label: `Replace with '${near}'` }));
          push('num', from, i, q);
        }
      } else {
        push('num', from, i, q);
      }
    } else if (/[A-Za-z_]/.test(c)) {
      const from = i;
      while (/[A-Za-z0-9_]/.test(src[i] ?? '')) i++;
      push('name', from, i, src.slice(from, i));
    } else if (PUNCT2.has(src.slice(i, i + 2))) {
      push(src.slice(i, i + 2), i, i + 2);
      i += 2;
    } else if (c === '.') {
      if (src[i + 1] === '.') { push('..', i, i + 2); i += 2; } else { push('.', i, i + 1); i++; }
    } else if (PUNCT.has(c)) {
      if (c === '[' || c === '(') depth++;
      else if ((c === ']' || c === ')') && depth > 0) depth--;
      else if (c === '{' || c === '}') depth = 0;
      push(c, i, i + 1);
      i++;
    } else {
      diags.push(diag('C001', 'error', i, i + 1, `unexpected character '${c}'`));
      i++;
    }
  }
  push('eof', src.length, src.length);
  return { tokens, diags };
}
