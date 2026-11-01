// Error-recovering parser for the grammar in SPEC.md section 2.4.
//
// Every node carries { from, to } source offsets. On a syntax error the parser
// records a diagnostic and skips to the next statement boundary, so the rest
// of the file still parses (SPEC.md section 7.2).

import { lex, diag, KEYWORDS, LITERALS } from './lexer.js';

class SyntaxError_ extends Error {}

export function parse(src) {
  const { tokens, diags } = lex(src);
  const p = new Parser(tokens, diags);
  const ast = p.file();
  return { ast, diags };
}

const MAX_NEST = 256;
const MAX_TREE = 1024;

// depth of an expression tree, iteratively
function treeDepth(root) {
  let max = 0;
  const stack = [[root, 1]];
  while (stack.length) {
    const [n, d] = stack.pop();
    if (d > max) max = d;
    if (max > MAX_TREE) return max;
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && x.type) stack.push([x, d + 1]); }
      else if (v && typeof v === 'object' && v.type) stack.push([v, d + 1]);
    }
  }
  return max;
}

class Parser {
  constructor(tokens, diags) {
    this.toks = tokens;
    this.i = 0;
    this.diags = diags;
    this.bdepth = 0;       // nesting of blocks (bounded: MAX_NEST)
    this.edepth = 0;       // nesting of expressions (bounded: MAX_NEST)
  }

  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  next() { const t = this.peek(); if (t.t !== 'eof') this.i++; return t; }
  at(t, v) { const tok = this.peek(); return tok.t === t && (v === undefined || tok.v === v); }
  isSep() { return this.at('nl') || this.at(';'); }
  skipSeps() { while (this.isSep()) this.next(); }

  fail(tok, message, hint, fix) {
    this.diags.push(diag('C001', 'error', tok.from, Math.max(tok.to, tok.from + 1), message, hint, fix));
    throw new SyntaxError_(message);
  }
  expect(t, what) {
    const tok = this.peek();
    if (tok.t !== t) this.fail(tok, `expected ${what}, found ${describe(tok)}`);
    return this.next();
  }
  expectName(what) {
    const tok = this.expect('name', what);
    if (KEYWORDS.has(tok.v) || LITERALS.has(tok.v)) this.fail(tok, `'${tok.v}' is a reserved word`);
    return tok;
  }

  // Skip to the end of the current statement: a separator or a closing brace
  // at the current nesting depth (the brace itself is left for the caller).
  sync() {
    let depth = 0;
    for (;;) {
      const tok = this.peek();
      if (tok.t === 'eof') return;
      if (depth === 0 && (tok.t === 'nl' || tok.t === ';' || tok.t === '}')) return;
      if (tok.t === '{') depth++;
      if (tok.t === '}') depth--;
      this.next();
    }
  }

  file() {
    this.skipSeps();
    let version = null;
    const start = this.peek();
    if (this.at('name', 'stencil')) {
      this.next();
      const v = this.peek();
      if (v.t === 'num') { version = v.text; this.next(); } else {
        this.diags.push(diag('C002', 'error', v.from, v.to, 'expected a version after \'stencil\'', 'write: stencil 0.1'));
      }
    } else {
      this.diags.push(diag('C002', 'warning', start.from, start.to,
        'a Stencil file starts with a version header', 'add `stencil 0.1` as the first line',
        { from: 0, to: 0, insert: 'stencil 0.1\n', label: 'Add header' }));
    }
    const stmts = this.stmts(false);
    return { type: 'File', version, stmts, from: 0, to: this.peek().to };
  }

  stmts(inBody) {
    const out = [];
    for (;;) {
      this.skipSeps();
      const tok = this.peek();
      if (tok.t === 'eof') break;
      if (tok.t === '}') {
        if (inBody) break;
        this.diags.push(diag('C001', 'error', tok.from, tok.to, "unmatched '}'"));
        this.next();
        continue;
      }
      try {
        out.push(this.stmt(inBody));
        if (!this.isSep() && !this.at('}') && !this.at('eof')) {
          const t = this.peek();
          this.fail(t, `expected end of statement, found ${describe(t)}`,
            'put one statement per line, or separate them with ;');
        }
      } catch (e) {
        if (!(e instanceof SyntaxError_)) throw e;
        this.sync();
      }
    }
    return out;
  }

  stmt(inBody) {
    const tok = this.peek();
    if (tok.t === '&') {
      this.next();
      const ref = this.ref();
      const body = this.body();
      return { type: 'Patch', ref, body, from: tok.from, to: body.to };
    }
    if (tok.t !== 'name') this.fail(tok, `expected a statement, found ${describe(tok)}`);

    if (tok.v === 'import') {
      this.next();
      if (inBody) this.fail(tok, "'import' is only allowed at the top level of a file");
      const path = this.expect('str', 'a module path in quotes');
      const asTok = this.peek();
      if (!this.at('name', 'as')) this.fail(asTok, "expected 'as' after the import path");
      this.next();
      const alias = this.expectName('an alias name');
      const body = this.at('{') ? this.body() : null;
      return { type: 'Import', path: path.v, alias: alias.v, aliasNode: span(alias), body,
        from: tok.from, to: body ? body.to : alias.to };
    }
    if (tok.v === 'drop') {
      this.next();
      const ref = this.ref();
      return { type: 'Drop', ref, from: tok.from, to: ref.to };
    }
    if (KEYWORDS.has(tok.v) || LITERALS.has(tok.v)) this.fail(tok, `'${tok.v}' cannot start a statement here`);

    const t1 = this.peek(1);
    const t2 = this.peek(2);
    if (t1.t === '=') {
      this.next(); this.next();
      const value = this.expr();
      return { type: 'Assign', name: tok.v, nameNode: span(tok), value, from: tok.from, to: value.to };
    }
    if (t1.t === '{') {
      this.next();
      const body = this.body();
      return { type: 'Object', kind: tok.v, kindNode: span(tok), name: null, nameNode: null, body,
        from: tok.from, to: body.to };
    }
    if (t1.t === 'name' && t2.t === '{') {
      this.next();
      const name = this.expectName('an object name');
      const body = this.body();
      return { type: 'Object', kind: tok.v, kindNode: span(tok), name: name.v, nameNode: span(name), body,
        from: tok.from, to: body.to };
    }
    if (t1.t === '.') {
      this.fail(tok, `'${tok.v}....' cannot start a statement`, 'to change an existing object write &Name { ... }');
    }
    if (t1.t === 'name' || t1.t === 'num' || t1.t === 'len') {
      this.fail(t1, `expected '=' after '${tok.v}'`, `attributes are written ${tok.v} = ${t1.text}`,
        { from: t1.from, to: t1.from, insert: '= ', label: "Insert '='" });
    }
    this.fail(t1.t === 'nl' || t1.t === 'eof' ? tok : t1, `expected '=' or '{' after '${tok.v}'`);
  }

  body() {
    if (this.bdepth >= MAX_NEST) return this.tooDeep('{', '}');
    this.bdepth++;
    try { return this.body1(); } finally { this.bdepth--; }
  }

  // Past MAX_NEST levels: report once and skip to the matching close, so a
  // pathological input cannot exhaust the stack.
  tooDeep(open, close) {
    const start = this.peek();
    this.diags.push(diag('C001', 'error', start.from, Math.max(start.to, start.from + 1), `nested more than ${MAX_NEST} levels deep`, 'flatten the description'));
    let level = 0;
    for (;;) {
      const t = this.next();
      if (t.t === 'eof') return { stmts: [], from: start.from, to: t.to };
      if (t.t === open) level++;
      else if (t.t === close && --level <= 0) return { stmts: [], from: start.from, to: t.to, type: 'Lit', v: 'none' };
    }
  }

  body1() {
    const open = this.expect('{', "'{'");
    const stmts = this.stmts(true);
    const close = this.peek();
    if (close.t === '}') {
      this.next();
      return { stmts, from: open.from, to: close.to };
    }
    this.diags.push(diag('C001', 'error', open.from, open.to, "unclosed '{'", "add a matching '}'"));
    return { stmts, from: open.from, to: close.from };
  }

  ref() {
    const first = this.expectName('a name');
    const parts = [first.v];
    let to = first.to;
    while (this.at('.')) {
      this.next();
      const p = this.expect('name', 'a name after "."');
      parts.push(p.v);
      to = p.to;
    }
    return { type: 'Ref', parts, from: first.from, to };
  }

  // expr = range [ cmp range ]   (comparisons are not chained)
  expr() {
    if (this.edepth >= MAX_NEST) {
      const t = this.peek();
      const skipped = t.t === '(' || t.t === '[' ? this.tooDeep(t.t, t.t === '(' ? ')' : ']') : (this.diags.push(diag('C001', 'error', t.from, Math.max(t.to, t.from + 1), `nested more than ${MAX_NEST} levels deep`, 'flatten the expression')), this.next(), { from: t.from, to: t.to });
      return { type: 'Lit', v: 'none', from: skipped.from, to: skipped.to };
    }
    this.edepth++;
    let e;
    try { e = this.expr1(); } finally { this.edepth--; }
    // The limits on nesting and on operator runs compose; bound the depth of
    // the whole expression tree too (measured without recursion), since later
    // passes walk it recursively.
    if (this.edepth === 0 && treeDepth(e) > MAX_TREE) {
      this.diags.push(diag('C001', 'error', e.from, Math.max(e.to, e.from + 1), `expression nested more than ${MAX_TREE} levels deep`, 'split the expression into named values'));
      return { type: 'Lit', v: 'none', from: e.from, to: e.to };
    }
    return e;
  }

  expr1() {
    const l = this.range();
    const op = this.peek().t;
    if (op === '<' || op === '>' || op === '<=' || op === '>=' || op === '==' || op === '!=') {
      this.next();
      const r = this.range();
      return { type: 'Cmp', op, l, r, from: l.from, to: r.to };
    }
    return l;
  }

  // range = sum [ ".." sum ]
  range() {
    const lo = this.sum();
    if (this.at('..')) {
      this.next();
      const hi = this.sum();
      return { type: 'Range', lo, hi, from: lo.from, to: hi.to };
    }
    return lo;
  }

  // A chain of n operators is a tree n deep, which evaluation walks
  // recursively: chains, like nesting, are bounded by MAX_NEST (C001).
  chainTooLong(tok) {
    this.diags.push(diag('C001', 'error', tok.from, Math.max(tok.to, tok.from + 1), `more than ${MAX_NEST} operators in a row`, 'split the expression into named values'));
  }

  sum() {
    let l = this.prod();
    for (let n = 0; this.at('+') || this.at('-'); n++) {
      const optok = this.next();
      const r = this.prod();
      if (n === MAX_NEST) this.chainTooLong(optok);
      if (n >= MAX_NEST) continue;
      l = { type: 'Bin', op: optok.t, l, r, from: l.from, to: r.to };
    }
    return l;
  }

  prod() {
    let l = this.unary();
    for (let n = 0; this.at('*') || this.at('/'); n++) {
      const optok = this.next();
      const r = this.unary();
      if (n === MAX_NEST) this.chainTooLong(optok);
      if (n >= MAX_NEST) continue;
      l = { type: 'Bin', op: optok.t, l, r, from: l.from, to: r.to };
    }
    return l;
  }

  unary() {
    // a run of minus signs, read iteratively
    const signs = [];
    while (this.at('-')) signs.push(this.next());
    if (signs.length > MAX_NEST) this.chainTooLong(signs[MAX_NEST]);
    let e = this.atom();
    for (const m of signs.slice(0, MAX_NEST).reverse()) e = { type: 'Neg', e, from: m.from, to: e.to };
    return e;
  }

  atom() {
    const tok = this.peek();
    switch (tok.t) {
      case 'num': this.next(); return { type: 'Num', q: tok.v, from: tok.from, to: tok.to };
      case 'len': this.next(); return { type: 'Len', q: tok.v.q, unit: tok.v.unit, from: tok.from, to: tok.to };
      case 'str': this.next(); return { type: 'Str', v: tok.v, from: tok.from, to: tok.to };
      case '(': {
        this.next();
        const e = this.expr();
        const close = this.expect(')', "')'");
        return { ...e, from: tok.from, to: close.to };
      }
      case '[': {
        this.next();
        const items = [];
        while (!this.at(']')) {
          items.push(this.expr());
          if (!this.at(',')) break;
          this.next();
        }
        const close = this.expect(']', "',' or ']'");
        return { type: 'List', items, from: tok.from, to: close.to };
      }
      case 'name': {
        if (tok.v === 'required' && this.peek(1).t === '(') {
          // Typed parameter: required(layer), required(len), ...
          this.next(); this.next();
          const ty = this.expect('name', 'a type such as layer, len, number or area');
          const close = this.expect(')', "')'");
          return { type: 'Lit', v: 'required', ptype: ty.v, ptypeNode: span(ty), from: tok.from, to: close.to };
        }
        if (LITERALS.has(tok.v)) { this.next(); return { type: 'Lit', v: tok.v, from: tok.from, to: tok.to }; }
        if (KEYWORDS.has(tok.v)) this.fail(tok, `'${tok.v}' is a reserved word`);
        if (this.peek(1).t === '(') {
          this.next(); this.next();
          const args = [];
          while (!this.at(')')) {
            args.push(this.expr());
            if (!this.at(',')) break;
            this.next();
          }
          const close = this.expect(')', "',' or ')'");
          return { type: 'Call', fn: tok.v, fnNode: span(tok), args, from: tok.from, to: close.to };
        }
        return this.ref();
      }
      default:
        this.fail(tok, `expected a value, found ${describe(tok)}`);
    }
  }
}

function span(tok) { return { from: tok.from, to: tok.to }; }

function describe(tok) {
  if (tok.t === 'eof') return 'end of file';
  if (tok.t === 'nl') return 'end of line';
  if (tok.t === 'name') return `'${tok.v}'`;
  return `'${tok.text}'`;
}
