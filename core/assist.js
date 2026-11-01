// Editor assistance shared by the playground and the VS Code extension:
// vocabulary-driven completion and hover text. Pure functions over the source
// text and a cursor offset; no editor library is involved.

import { KEYWORDS } from './lexer.js';
import { KINDS, FUNCTIONS, attrSpec, describeType, enumWords, refKinds } from './vocab.js';

const TOP_KINDS = Object.keys(KINDS).filter((k) => KINDS[k].top);

// Innermost enclosing object kinds at the end of `text`, plus declared names.
export function scan(text) {
  const declared = new Map();   // name -> kind
  const params = new Set();
  const stack = [];
  const re = /#[^\n]*|"(?:[^"\\\n]|\\.)*"?|&\s*([A-Za-z_][\w.]*)\s*\{|([A-Za-z_]\w*)(?:[ \t]+([A-Za-z_]\w*))?\s*\{|^[ \t]*([A-Za-z_]\w*)\s*=|\}/gm;
  let m;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (t[0] === '#' || t[0] === '"') continue;
    if (t === '}') { stack.pop(); continue; }
    if (m[1]) { stack.push(declared.get(m[1].split('.')[0]) ?? '?'); continue; }
    if (m[2]) {
      if (KEYWORDS.has(m[2])) continue;
      stack.push(m[2]);
      if (m[3] && stack.length === 1) declared.set(m[3], m[2]);
      continue;
    }
    if (m[4] && stack.length === 0) params.add(m[4]);
  }
  return { stack, declared, params };
}

// The identifier ending at `pos` (or null): { from, word }.
function wordBefore(text, pos) {
  const m = /[A-Za-z_]\w*$/.exec(text.slice(0, pos));
  return m ? { from: pos - m[0].length, word: m[0] } : null;
}

/**
 * Completion at `pos`. Returns { from, items } or null, where each item is
 * { label, type, detail?, info?, apply?, boost? } and `type` is one of
 * class (object kind), property (attribute), enum, variable (declared name),
 * constant (parameter), function, keyword. `apply` is the text to insert
 * (default: label). `explicit`: the user asked for completion (Ctrl-Space),
 * so offer it even before any letter is typed.
 */
export function complete(text, pos, explicit = false) {
  const word = wordBefore(text, pos);
  if (!word && !explicit) return null;
  const from = word ? word.from : pos;
  const before = text.slice(0, from);
  const { stack, declared: declaredBefore, params } = scan(before);
  const declared = scan(text).declared;
  for (const [k, v] of declaredBefore) declared.set(k, v);
  const kind = stack[stack.length - 1];
  const segStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf(';'), before.lastIndexOf('{')) + 1;
  const seg = before.slice(segStart);

  const valueMatch = seg.match(/([A-Za-z_]\w*)\s*=\s*(?:[^=]*[\s,(\[])?$/);
  if (valueMatch) {
    const spec = kind ? attrSpec(kind, valueMatch[1]) : null;
    const items = [];
    if (spec) {
      for (const v of enumWords(spec.type)) items.push({ label: v, type: 'enum', detail: 'value' });
      const kinds = refKinds(spec.type);
      for (const [name, k] of declared) if (kinds.includes(k)) items.push({ label: name, type: 'variable', detail: k });
      if (spec.type.k === 'attrref') {
        for (const [name, k] of declared) if (spec.type.kinds.includes(k)) {
          for (const a of Object.keys(KINDS[k].attrs)) items.push({ label: `${name}.${a}`, type: 'variable', detail: k });
        }
      }
    }
    for (const p of params) items.push({ label: p, type: 'constant', detail: 'parameter' });
    for (const [f, d] of Object.entries(FUNCTIONS)) items.push({ label: f, type: 'function', info: d.doc, apply: `${f}(` });
    return { from, items };
  }

  if (/\S/.test(seg)) return null;
  if (!kind) {
    const items = TOP_KINDS.map((k) => ({
      label: k, type: 'class', info: KINDS[k].doc, detail: `level ${KINDS[k].level}`,
      apply: KINDS[k].named ? `${k} ` : `${k} { `,
    }));
    for (const kw of ['import', 'drop']) items.push({ label: kw, type: 'keyword' });
    return { from, items };
  }
  const spec = KINDS[kind];
  if (!spec) return null;
  const items = Object.entries(spec.attrs).map(([name, a]) => ({
    label: name, type: 'property', detail: a.required ? 'required' : '', info: `${a.doc}\n\n${describeType(a.type)}`, apply: `${name} = `,
    boost: a.required ? 2 : 0,
  }));
  for (const [ck, c] of Object.entries(spec.children ?? {})) {
    items.push({ label: ck, type: 'class', detail: c.nameDoc ? `${ck} <${c.nameDoc}> { ... }` : `${ck} { ... }`, info: KINDS[ck]?.doc, apply: c.name === 'none' ? `${ck} { ` : `${ck} ` });
  }
  items.push({ label: 'base', type: 'property', info: 'Inherit from another object of the same kind.', apply: 'base = ' });
  items.push({ label: 'note', type: 'property', info: 'Free text kept in the resolved form.', apply: 'note = "' });
  return { from, items };
}

/**
 * Hover text for the word at `pos`: { from, to, title, doc } or null.
 * Object kinds, attributes (in the kind that encloses them) and functions.
 */
export function hover(text, pos) {
  const left = /[A-Za-z_]\w*$/.exec(text.slice(0, pos))?.[0] ?? '';
  const right = /^\w*/.exec(text.slice(pos))[0];
  const word = left + right;
  if (!word || !/^[A-Za-z_]/.test(word)) return null;
  const from = pos - left.length, to = pos + right.length;
  const after = text.slice(to);
  const { stack } = scan(text.slice(0, from));
  const kind = stack[stack.length - 1];
  if (/^\s*=/.test(after) && kind) {
    const a = attrSpec(kind, word);
    if (a) return { from, to, title: `${kind}.${word}${a.required ? ' (required)' : ''}`, doc: `${a.doc ?? ''}\n\nType: ${describeType(a.type)}` };
  }
  if (/^\s*\(/.test(after) && FUNCTIONS[word]) return { from, to, title: `${word}(...)`, doc: FUNCTIONS[word].doc ?? '' };
  if (KINDS[word] && /^\s*([A-Za-z_]\w*\s*)?\{/.test(after)) {
    const k = KINDS[word];
    const attrs = Object.entries(k.attrs).map(([n, a]) => `${n}${a.required ? '*' : ''}`).join(', ');
    return { from, to, title: `${word} (level ${k.level})`, doc: `${k.doc ?? ''}${attrs ? `\n\nAttributes: ${attrs}  (* required)` : ''}` };
  }
  return null;
}
