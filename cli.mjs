#!/usr/bin/env node
// Stencil command-line front end.
//
//   node cli.mjs resolve main.stencil [--root DIR] [--out resolved.json] [--quiet] [--with-diagnostics]
//   node cli.mjs check   main.stencil [--root DIR] [--profile FILE:NAME]
//
// Imports resolve against --root (default: the main file's directory).
// Exit code: 0 = no errors, 1 = errors (the resolved form is then marked
// "complete": false and must not be used as generator input), 2 = usage,
// 3 = resolves cleanly but the --profile tool cannot take it.
// --with-diagnostics: write {"resolved": ..., "diagnostics": [...]} instead of the
// resolved form alone (what the Python and JavaScript query APIs read).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { resolveProject } from './core/resolve.js';
import { hashResolved } from './core/canon.js';
import { checkProfile } from './core/profile.js';

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: cli.mjs resolve|check <main.stencil> [--root DIR] [--out FILE] [--quiet] [--with-diagnostics] [--profile FILE:NAME]');
  process.exit(2);
}

const [cmd, mainArg, ...rest] = process.argv.slice(2);
if (!['resolve', 'check'].includes(cmd) || !mainArg) usage();
const opts = { root: null, out: null, quiet: false, profile: null, withDiags: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--root') opts.root = rest[++i];
  else if (rest[i] === '--out') opts.out = rest[++i];
  else if (rest[i] === '--quiet') opts.quiet = true;
  else if (rest[i] === '--profile') opts.profile = rest[++i];
  else if (rest[i] === '--with-diagnostics') opts.withDiags = true;
  else usage(`unknown option ${rest[i]}`);
}
const mainAbs = resolve(mainArg);
if (!existsSync(mainAbs)) usage(`no such file: ${mainArg}`);
const root = resolve(opts.root ?? dirname(mainAbs));
const main = relative(root, mainAbs).split('\\').join('/');
const load = (p) => {
  const f = join(root, p);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

const r = resolveProject({ main, load });
const counts = { error: 0, warning: 0, info: 0 };
for (const d of r.diags) {
  counts[d.severity]++;
  if (opts.quiet && d.severity === 'info') continue;
  const inst = d.instance ? ` [${d.instance}]` : '';
  console.error(`${d.file}:${d.line}:${d.col}: ${d.severity} ${d.code}${inst}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`);
}
// Tool profile: can this tool take the technology?
let profileFindings = 0;
if (opts.profile) {
  const [pfile, pname] = opts.profile.split(':');
  const pr = resolveProject({ main: pfile, load });
  const prof = pr.resolved.objects.find((o) => o.kind === 'profile' && o.name === pname);
  if (!prof) usage(`no profile '${pname}' in ${pfile}`);
  const findings = checkProfile(r.resolved, prof);
  profileFindings = findings.length;
  if (findings.scope) console.error(`profile ${pname}: routing scope from the cell template: ${findings.scope.join(', ')}`);
  for (const f of findings) console.error(`profile ${pname}: ${f.object}: ${f.message}`);
  console.error(findings.length ? `profile ${pname}: ${findings.length} problem${findings.length > 1 ? 's' : ''}; the tool cannot take this technology as is` : `profile ${pname}: OK`);
}
const hash = await hashResolved(r.resolved);
console.error(`${r.resolved.objects.length} objects, ${r.resolved.modules.length} imported modules, ${counts.error} errors, ${counts.warning} warnings, ${counts.info} notes, ${r.ms.toFixed(1)} ms, ${hash}`);
if (cmd === 'resolve') {
  const resolved = { ...r.resolved, hash };
  const diagnostics = r.diags.map(({ code, severity, message, hint, file, line, col, end_line, end_col, instance }) => ({ code, severity, message, hint, file, line, col, end_line, end_col, instance }));
  const json = JSON.stringify(opts.withDiags ? { resolved, diagnostics } : resolved, null, 2);
  if (opts.out) writeFileSync(opts.out, json + '\n');
  else console.log(json);
}
process.exitCode = counts.error ? 1 : profileFindings ? 3 : 0;   // not process.exit(): it would cut off large stdout writes
