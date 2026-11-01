// M3c: site v2 (rows, free band/rail names, local track grids, edge features)
// and device models. Expected coordinates are derived by hand (grid 1nm, so
// DBU = nm): a flipped row at y maps a local height v to y + h - v.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource } from '../core/resolve.js';
import { expandSite, selectModels } from '../core/template.js';

const BASE = `stencil 0.1
technology { grid = 1nm }
layer FIN_B { role = channel }
layer BPC { role = conductor; direction = vertical }
layer FIN_F { role = channel }
layer PC { role = conductor; direction = vertical; width = 16nm }
layer BM0 { role = conductor; direction = horizontal; pitch = 18nm; width = 8nm }
layer M0 { role = conductor; direction = horizontal; pitch = 24nm; width = 10nm }
layer LVT { role = marker }
layer HVT { role = marker }
stratum BACK  { layers = [FIN_B, BPC] }
stratum FRONT { layers = [FIN_F, PC] }
site B_ROW { width = 45nm; height = 72nm
  rail VDD { layer = BM0; edge = bottom }
  rail VSS { layer = BM0; edge = top }
  band p { stratum = BACK; y = 0nm .. 36nm }
  band n { stratum = BACK; y = 36nm .. 72nm }
  tracks BM0 { use = 1..3 }
}
`;
const HYBRID = `site HYBRID { width = 45nm; height = 144nm
  row R0 { site = B_ROW; y = 0nm }
  row R1 { site = B_ROW; y = 72nm; flip = true }
  band FP { polarity = p; stratum = FRONT; y = 0nm .. 72nm }
  band FN { polarity = n; stratum = FRONT; y = 72nm .. 144nm }
  rail FVDD { net = "VDD"; layer = M0; edge = bottom }
  rail FVSS { net = "VSS"; layer = M0; y = 144nm }
  tracks F { layer = M0; pitch = 24nm; offset = 12nm }
  edge_feature DG { layer = PC; width = 16nm }
}
`;
const resolve = (src) => resolveSource(BASE + src);
const errs = (r) => r.diags.filter((d) => d.severity === 'error');
const codes = (r) => errs(r).map((d) => d.code);

test('hybrid template: rows, flip, shared middle rail, cross-stratum bands', () => {
  const r = resolve(HYBRID);
  assert.deepEqual(errs(r), []);
  const t = expandSite(r.resolved, 'HYBRID');
  assert.deepEqual(t.problems, []);
  const bands = Object.fromEntries(t.bands.map((b) => [b.name, [b.polarity, b.stratum, b.y0, b.y1]]));
  assert.deepEqual(bands, {
    'R0.p': ['p', 'BACK', 0, 36], 'R0.n': ['n', 'BACK', 36, 72],
    'R1.p': ['p', 'BACK', 108, 144], 'R1.n': ['n', 'BACK', 72, 108],
    FP: ['p', 'FRONT', 0, 72], FN: ['n', 'FRONT', 72, 144],
  });
  const rails = t.rails.map((x) => [x.name, x.net, x.layer, x.y, x.width, x.shared ?? null]);
  assert.deepEqual(rails, [
    ['R0.VDD', 'VDD', 'BM0', 0, 8, null],
    ['R0.VSS', 'VSS', 'BM0', 72, 8, ['R0.VSS', 'R1.VSS']],          // the PNNP shared middle rail
    ['R1.VDD', 'VDD', 'BM0', 144, 8, null],
    ['FVDD', 'VDD', 'M0', 0, 10, null],
    ['FVSS', 'VSS', 'M0', 144, 10, null],
  ]);
  const tracks = Object.fromEntries(t.tracks.map((x) => [x.name, [x.layer, x.axis, x.positions, x.use]]));
  assert.deepEqual(tracks, {
    'R0.BM0': ['BM0', 'y', [0, 18, 36, 54, 72], [1, 2, 3]],
    'R1.BM0': ['BM0', 'y', [144, 126, 108, 90, 72], [1, 2, 3]],   // indices stay local to the row
    F: ['M0', 'y', [12, 36, 60, 84, 108, 132], [0, 1, 2, 3, 4, 5]],
  });
  assert.deepEqual(t.edges.map((e) => [e.side, e.x0, e.y0, e.x1, e.y1]), [['left', -8, 0, 8, 144], ['right', 37, 0, 53, 144]]);
});

test('edge features: unshared, one side, y range, odd shared width', () => {
  const t = (body) => { const r = resolve(`site S { width = 45nm; height = 72nm\n ${body} }`); return [codes(r), expandSite(r.resolved, 'S')]; };
  assert.deepEqual(t('edge_feature D { layer = PC; width = 16nm; shared = false }')[1].edges.map((e) => [e.x0, e.x1]), [[0, 16], [29, 45]]);
  assert.deepEqual(t('edge_feature D { layer = PC; width = 16nm; at = right; y = 10nm .. 20nm }')[1].edges.map((e) => [e.side, e.x0, e.y0, e.x1, e.y1]), [['right', 37, 10, 53, 20]]);
  assert.deepEqual(t('edge_feature D { layer = PC; width = 15nm }')[0], ['V040']);
});

test('explicit track positions and vertical tracks', () => {
  const r = resolve('site S { width = 90nm; height = 72nm\n tracks M0 { at = [6nm, 30nm, 66nm]; use = [0, 2] }\n tracks G { layer = BPC; pitch = 45nm } }');
  assert.deepEqual(errs(r), []);
  const t = expandSite(r.resolved, 'S');
  assert.deepEqual(t.tracks.map((x) => [x.name, x.axis, x.positions, x.use]), [['M0', 'y', [6, 30, 66], [0, 2]], ['G', 'x', [0, 45, 90], [0, 1, 2]]]);
});

test('site v2 validation', () => {
  const S = (body, w = 45, h = 144) => `site S { width = ${w}nm; height = ${h}nm\n ${body} }`;
  const cases = [
    [S('band X { stratum = BACK; y = 0nm .. 10nm }'), 'V004'],                             // no polarity
    [S('band p { stratum = BACK; y = 0nm .. 80nm }\n band q { polarity = n; stratum = BACK; y = 70nm .. 144nm }'), 'V013'],  // overlap in one stratum
    ['stratum ONE { layers = [FIN_B]; polarity = [n] }\n' + S('band p { stratum = ONE; y = 0nm .. 10nm }'), 'V013'],
    [S('band p { stratum = BACK; y = 0nm .. 200nm }'), 'V013'],
    [S('rail R { layer = M0 }'), 'V004'],
    [S('rail R { layer = M0; edge = top; y = 3nm }'), 'V040'],
    [S('rail A { layer = M0; y = 50nm }\n rail B { layer = M0; y = 55nm }'), 'V040'],      // two nets overlap
    [S('row R { site = B_ROW; y = 100nm }'), 'V040'],                                       // 100 + 72 > 144
    [S('row R { site = B_ROW }', 90), 'V040'],                                              // width mismatch
    [HYBRID + S('row R { site = HYBRID }'), 'V040'],                                         // rows nest one level
    [S('tracks Q { use = 1..2 }'), 'C021'],                                                 // Q is not a layer
    [S('tracks M0 { at = [1nm]; pitch = 4nm }'), 'V040'],
    [S('tracks M0 { use = 0..9 }'), 'V040'],                                                // index 9 does not exist
  ];
  for (const [src, code] of cases) assert.ok(codes(resolve(src)).includes(code), `${src}\nwant ${code}, got ${JSON.stringify(codes(resolve(src)))}`);
  // bands of different strata may overlap; rails of one net at one height merge
  assert.deepEqual(codes(resolve(S('band p { stratum = BACK; y = 0nm .. 80nm }\n band q { polarity = p; stratum = FRONT; y = 0nm .. 80nm }'))), []);
});

const CROSS = (models, extra = '') => `cross FET { gate = PC; channel = FINS; faces = [top]; ${extra}\n${models}\n}\nfigure FINS { layer = FIN_F; width = 5nm }\n`;
test('models: identical selections, marker and markers, stratum polarity', () => {
  assert.deepEqual(codes(resolve(CROSS('model a { polarity = n; markers = [LVT] }\n model b { polarity = n; markers = [LVT]; exclude = [HVT] }'))), []);
  assert.deepEqual(codes(resolve(CROSS('model a { polarity = n; marker = LVT }\n model b { polarity = n; markers = [LVT] }'))), ['V041']);
  assert.deepEqual(codes(resolve(CROSS('model a { polarity = n; marker = LVT; markers = [HVT] }'))), ['V041']);
  assert.deepEqual(codes(resolve('stratum ONE { layers = [FIN_F]; polarity = [n] }\n' + CROSS('model a { polarity = p }', 'stratum = ONE'))), ['V042']);
});

test('model selection: markers must cover, excluded markers must not touch', () => {
  const r = resolve(CROSS('model n_lvt { polarity = n; markers = [LVT] }\n model n_rvt { polarity = n; exclude = [LVT, HVT] }\n model n_hvt { polarity = n; markers = [HVT] }\n model p_rvt { polarity = p }'));
  assert.deepEqual(errs(r), []);
  const cross = r.resolved.objects.find((o) => o.name === 'FET');
  const sel = (cov, touch, pol) => selectModels(cross, new Set(cov), new Set(touch), pol).map((m) => m.name);
  assert.deepEqual(sel([], [], 'n'), ['n_rvt']);
  assert.deepEqual(sel(['LVT'], ['LVT'], 'n'), ['n_lvt']);
  assert.deepEqual(sel([], ['LVT'], 'n'), []);                          // partial LVT: no model (recognition error)
  assert.deepEqual(sel(['LVT', 'HVT'], ['LVT', 'HVT'], 'n'), ['n_lvt', 'n_hvt']);   // two matches: recognition error
  assert.deepEqual(sel([], [], 'p'), ['p_rvt']);
});

test('top/bottom edge features run along the edge and follow row flips', () => {
  const r = resolve('site S { width = 45nm; height = 72nm\n edge_feature C { layer = PC; at = [top, bottom]; width = 10nm; extend = 4nm } }\n'
    + 'site T { width = 45nm; height = 144nm\n row A { site = S }\n row B { site = S; y = 72nm; flip = true } }');
  assert.deepEqual(errs(r), []);
  assert.deepEqual(expandSite(r.resolved, 'S', { units: 2 }).edges.map((e) => [e.side, e.x0, e.y0, e.x1, e.y1]), [['top', -4, 67, 94, 77], ['bottom', -4, -5, 94, 5]]);
  assert.deepEqual(expandSite(r.resolved, 'T').edges.map((e) => [e.name, e.side, e.y0, e.y1]),
    [['A.C', 'top', 67, 77], ['A.C', 'bottom', -5, 5], ['B.C', 'bottom', 67, 77], ['B.C', 'top', 139, 149]]);
});


test('device recognition: default gate and channel, marker cover / touch, explicit recognize', async () => {
  const { recognizeDevices } = await import('../core/rulecheck.js');
  const src = `stencil 0.1
technology { grid = 1nm }
layer ACT { role = channel }
layer GATE { role = conductor; direction = vertical }
layer GCUT { role = marker }
layer LVT { role = marker }
figure SHEET { layer = ACT; width = 8nm }
cross GAA { gate = GATE; channel = SHEET; faces = all
  model n_lvt { polarity = n; markers = [LVT] }
  model n_rvt { polarity = n; exclude = [LVT] }
  model p_rvt { polarity = p }
}
cross CUTAWARE { gate = GATE; channel = SHEET; faces = all; recognize = minus(intersect(GATE, ACT), GCUT) }
`;
  const r = resolveSource(src);
  assert.deepEqual(errs(r), []);
  const S = (layer, x0, y0, x1, y1) => ({ layer, rect: [x0, y0, x1, y1] });
  const base = [S('GATE', 0, 0, 14, 100), S('GATE', 42, 0, 56, 100), S('ACT', -20, 40, 80, 48)];
  const dev = (shapes, cross = 'GAA') => recognizeDevices(r.resolved, { shapes }).filter((d) => d.cross === cross);
  const plain = dev(base);
  assert.deepEqual(plain.map((d) => [d.bbox.x0, d.bbox.y0, d.bbox.x1, d.bbox.y1, d.models.n, d.models.p]),
    [[0, 40, 14, 48, ['n_rvt'], ['p_rvt']], [42, 40, 56, 48, ['n_rvt'], ['p_rvt']]]);
  const lvt = dev([...base, S('LVT', -5, 30, 20, 60)]);
  assert.deepEqual(lvt.map((d) => d.models.n), [['n_lvt'], ['n_rvt']]);
  const part = dev([...base, S('LVT', 7, 30, 20, 60)]);                       // covers half of the first device
  assert.deepEqual(part[0].models.n, []);                                      // selection fails
  assert.deepEqual(part[0].partial, ['LVT']);
  assert.equal(dev([...base, S('GCUT', -5, 0, 20, 100)], 'CUTAWARE').length, 1);   // the cut gate is no device
});

// ---- -------------------------------------------
import { resolveProject } from '../core/resolve.js';
import { checkProfile } from '../core/profile.js';
import { buildModel, renderTop } from '../playground/render.js';
const G1 = 'stencil 0.1\ntechnology { grid = 1nm }\n';
const lineOf = (src, text) => src.slice(0, src.indexOf(text)).split('\n').length;

test('C1: computed markers select models like drawn ones', async () => {
  const { recognizeDevices } = await import('../core/rulecheck.js');
  const r = resolveSource(G1 + `layer ACT { role = channel }
layer GATE { role = conductor; direction = vertical }
layer RAW { role = marker }
layer LVT { role = marker; from = grow(RAW, 0nm) }
figure SHEET { layer = ACT; width = 8nm }
cross GAA { gate = GATE; channel = SHEET; faces = all
  model n_lvt { polarity = n; markers = [LVT] }
  model n_rvt { polarity = n; exclude = [LVT] } }`);
  assert.deepEqual(errs(r), []);
  const d = recognizeDevices(r.resolved, { shapes: [{ layer: 'GATE', rect: [0, 0, 14, 100] }, { layer: 'ACT', rect: [-20, 40, 40, 48] }, { layer: 'RAW', rect: [-5, 30, 20, 60] }] });
  assert.deepEqual(d.map((x) => [x.models.n, x.selection.n]), [[['n_lvt'], 'ok']]);
});

test('C2: shared rails take the widest width; collisions do not depend on order', () => {
  const rails = ['rail VDD { layer = M0; y = 50nm; width = 2nm }', 'rail VDD2 { net = "VDD"; layer = M0; y = 50nm; width = 20nm }'];
  for (const order of [rails, [...rails].reverse()]) {
    const r = resolveSource(BASE + `site S { width = 45nm; height = 100nm\n ${order.join('\n ')}\n rail VSS { layer = M0; y = 58nm; width = 2nm } }`);
    assert.ok(codes(r).includes('V040'), JSON.stringify(r.diags));
    const t = expandSite(r.resolved, 'S');
    assert.equal(t.rails.find((x) => x.net === 'VDD').width, 20);
  }
});

test('C3: tracks named by their layer survive a rename prefix', () => {
  const r = resolveProject({ main: 'main.stencil', load: (p) => ({
    'main.stencil': G1 + 'import "lib" as l { rename { prefix = "P_" } }',
    'lib.stencil': 'stencil 0.1\nlayer M { role = conductor; direction = horizontal; pitch = 10nm }\nsite S { width = 10nm; height = 40nm\n  tracks M { use = 1..3 } }',
  })[p] ?? null });
  assert.deepEqual(errs(r), []);
  const site = r.resolved.objects.find((o) => o.kind === 'site');
  const t = expandSite(r.resolved, site.name);
  assert.deepEqual(t.tracks.map((x) => [x.layer, x.positions, x.use]), [['P_M', [0, 10, 20, 30, 40], [1, 2, 3]]]);
});

test('C4: the renderer draws local grids without a global pitch, and row grids only across their row', () => {
  const src = G1 + `layer X { role = conductor; direction = horizontal }
layer V { role = conductor; direction = vertical; pitch = 10nm }
site R1 { width = 20nm; height = 100nm
  tracks G { layer = V; pitch = 10nm } }
site S { width = 20nm; height = 200nm
  tracks Q { layer = X; at = [20nm, 60nm] }
  row B { site = R1; y = 100nm } }`;
  const r = resolveSource(src);
  assert.deepEqual(errs(r), []);
  const svg = renderTop(buildModel(r.resolved)).svg;
  assert.equal((svg.match(/<title>Q track \d on X/g) ?? []).length, 2);
  const vt = [...svg.matchAll(/<rect([^>]*)><title>B\.G track 0 on V/g)].map((m) => m[1]);
  assert.ok(vt.length > 0);
  for (const a of vt) { assert.match(a, / y="-200"/); assert.match(a, / height="100"/); }
});

test('C5: profiles take track layers from the expanded template', () => {
  const r = resolveSource(G1 + `layer LOW { role = conductor; direction = horizontal; pitch = 10nm }
layer HIGH { role = conductor; direction = vertical; pitch = 10nm }
site S { width = 20nm; height = 40nm; pins = [LOW]
  tracks Q { layer = HIGH } }
profile P { directions = [horizontal] }`);
  assert.deepEqual(errs(r), []);
  const f = checkProfile(r.resolved, r.resolved.objects.find((o) => o.kind === 'profile'));
  assert.ok(f.some((x) => x.object === 'HIGH'), JSON.stringify(f));
});

test('C6: multi-unit expansion keeps valid rows valid', () => {
  const r = resolveSource(BASE + HYBRID);
  assert.deepEqual(expandSite(r.resolved, 'HYBRID', { units: 2 }).problems, []);
  assert.deepEqual(expandSite(r.resolved, 'HYBRID', { units: 2 }).edges.map((e) => [e.side, e.x0, e.x1]), [['left', -8, 8], ['right', 82, 98]]);
});

test('C7: edge feature dimensions are validated', () => {
  for (const body of ['edge_feature D { layer = PC; width = -2nm }', 'edge_feature D { layer = PC; width = 100nm; shared = false }', 'edge_feature D { layer = PC; width = 4nm; extend = -1nm }', 'edge_feature D { layer = PC; width = 4nm; y = 10nm .. 90nm }']) {
    assert.ok(codes(resolve(`site S { width = 45nm; height = 72nm\n ${body} }`)).includes('V040'), body);
  }
});

test('follow-ups: layer track arrays as defaults; row diagnostics point at the row\'s site', () => {
  const r = resolveSource(G1 + `layer M { role = conductor; direction = horizontal; tracks = TA }
figure W { layer = M; width = 2nm }
array TA { of = W; axis = y; pitch = 10nm; offset = 5nm; count = fill }
site S { width = 10nm; height = 40nm
  tracks M { use = 0..1 } }`);
  assert.deepEqual(errs(r), [], JSON.stringify(r.diags));
  assert.deepEqual(expandSite(r.resolved, 'S').tracks[0].positions, [5, 15, 25, 35]);
  const src = BASE + 'site K { width = 45nm; height = 72nm\n  rail VDDK { net = "VDD"; layer = M0; y = 30nm; width = 10nm }\n}\nsite T { width = 45nm; height = 72nm\n  rail VSS { layer = M0; y = 30nm; width = 10nm }\n  row A { site = K }\n}';
  const d = errs(resolveSource(src)).find((x) => x.code === 'V040');
  assert.equal(d.line, lineOf(src, 'rail VDDK'));
});

// ---- ---------------------------------------
test('C2-1: an inherited shorthand tracks block keeps the layer of the module that wrote it', () => {
  const lib = 'stencil 0.1\nlayer M { role = conductor; direction = horizontal; pitch = 10nm }\nsite S { width = 10nm; height = 40nm\n  tracks M { use = 1..3 } }';
  for (const local of ['layer M { role = conductor; direction = vertical; pitch = 4nm }\n', '']) {
    const r = resolveProject({ main: 'main.stencil', load: (p) => ({ 'main.stencil': G1 + 'import "lib" as l { rename { prefix = "P_" } }\n' + local + 'site T { base = l.S }', 'lib.stencil': lib })[p] ?? null });
    assert.deepEqual(errs(r), [], JSON.stringify(r.diags));
    assert.deepEqual(expandSite(r.resolved, 'T').tracks.map((x) => [x.layer, x.axis, x.positions]), [['P_M', 'y', [0, 10, 20, 30, 40]]]);
  }
});

test('C2-2: rail widths must be positive', () => {
  assert.ok(codes(resolveSource(BASE + 'site S { width = 45nm; height = 100nm\n rail A { layer = M0; y = 20nm; width = -20nm }\n rail B { layer = M0; y = 25nm; width = 20nm } }')).includes('V040'));
});

test('C2-3: local grids render at the declared width without a global pitch; empty grids are fine', () => {
  const svg = renderTop(buildModel(resolveSource(G1 + 'layer X { role = conductor; direction = horizontal; width = 2nm }\nlayer Y { role = conductor; direction = horizontal }\nsite S { width = 20nm; height = 100nm\n  tracks X { at = [20nm, 60nm] }\n  tracks Y { at = [] } }').resolved)).svg;
  const hs = [...svg.matchAll(/<rect([^>]*)><title>X track/g)].map((m) => / height="([\d.]+)"/.exec(m[1])[1]);
  assert.deepEqual(hs, ['2', '2']);
  assert.ok(!svg.includes('NaN'));
});

test('C2 follow-up: duplicate selectors are compared as sets (V041)', () => {
  assert.deepEqual(codes(resolve(CROSS('model a { polarity = n; markers = [LVT] }\n model b { polarity = n; markers = [LVT, LVT] }'))), ['V041']);
});

// ---- ---------------------------------------
test('C3-1: rail widths given as choices or ranges are checked, flipped rows too', () => {
  for (const w of ['one_of(20nm)', '20nm .. 20nm', 'one_of(-20nm)', '-20nm .. -10nm']) {
    const layer = `layer MW { role = conductor; direction = horizontal; width = ${w} }\n`;
    const direct = resolveSource(G1 + layer + 'site S { width = 20nm; height = 100nm\n  rail A { layer = MW; y = 20nm }\n  rail B { layer = MW; y = 25nm } }');
    assert.ok(codes(direct).includes('V040'), `${w}: ${JSON.stringify(direct.diags)}`);
    const rows = resolveSource(G1 + layer + 'site K { width = 20nm; height = 50nm\n  rail A { layer = MW; y = 20nm }\n  rail B { layer = MW; y = 25nm } }\nsite S { width = 20nm; height = 100nm\n  row R { site = K; y = 50nm; flip = true } }');
    assert.ok(codes(rows).includes('V040'), `${w} (rows): ${JSON.stringify(rows.diags)}`);
  }
});

// ---- ---------------------------------------
test('C4-1: explicit rail widths may be choices or ranges (largest value), directly and in flipped rows', () => {
  for (const [w, max] of [['one_of(2nm, 20nm)', 20], ['2nm .. 20nm', 20], ['one_of(8nm)', 8], ['8nm .. 8nm', 8]]) {
    const direct = resolveSource(G1 + `layer M { role = conductor; direction = horizontal }\nsite S { width = 20nm; height = 100nm\n  rail A { layer = M; y = 20nm; width = ${w} } }`);
    assert.deepEqual(errs(direct), [], `${w}: ${JSON.stringify(direct.diags)}`);
    assert.equal(expandSite(direct.resolved, 'S').rails[0].width, max);
    const rows = resolveSource(G1 + `layer M { role = conductor; direction = horizontal }\nsite K { width = 20nm; height = 50nm\n  rail A { layer = M; y = 20nm; width = ${w} } }\nsite S { width = 20nm; height = 100nm\n  row R { site = K; y = 50nm; flip = true } }`);
    assert.deepEqual(errs(rows), [], `${w} (rows): ${JSON.stringify(rows.diags)}`);
    assert.deepEqual(expandSite(rows.resolved, 'S').rails.map((x) => [x.y, x.width]), [[80, max]]);
    // and a neighbour within the largest width still collides
    const near = resolveSource(G1 + `layer M { role = conductor; direction = horizontal }\nsite S { width = 20nm; height = 100nm\n  rail A { layer = M; y = 20nm; width = ${w} }\n  rail B { layer = M; y = ${20 + max / 2}nm; width = 2nm } }`);
    assert.ok(codes(near).includes('V040'), `${w} (collision)`);
  }
});

// ---- ---------------------------------------
test('C5-1: rail collisions are exact up to the expansion bound; beyond it they are refused, not rounded', () => {
  const src = (h, y, w) => G1 + `layer M { role = conductor; direction = horizontal }\nsite S {\n  width = 20nm; height = ${h}nm\n  rail A { layer = M; y = 0nm; width = ${w} }\n  rail B { layer = M; y = ${y}nm; width = 2nm } }`;
  const B = 2 ** 50;                                                                   // 2d = 2^50
  assert.ok(codes(resolveSource(src(B, B / 2, `${B - 1}nm`))).includes('V040'));       // w1 + w2 = 2^50 + 1 > 2d
  assert.ok(codes(resolveSource(src(B, B / 2, `one_of(1nm, ${B - 1}nm)`))).includes('V040'));
  assert.ok(!codes(resolveSource(src(B, B / 2, `${B - 2}nm`))).includes('V040'));     // w1 + w2 = 2d: touching
  const far = resolveSource(src(5000000000000000, 4503599627370496, '9007199254740990nm'));
  assert.ok(far.diags.some((d) => d.code === 'V040' && /exact range/.test(d.message)), JSON.stringify(far.diags));
});

test('expanded coordinates beyond +/-2^52 are reported, not rounded', () => {
  const r = resolveSource(G1 + 'layer M { role = conductor; direction = horizontal }\nsite S { width = 20nm; height = 100nm\n  edge_feature E { layer = M; at = [top]; width = 2nm; extend = 4503599627370497nm } }');
  assert.ok(codes(r).includes('V040'), JSON.stringify(r.diags));
});

// ---- ---------------------------------------
test('C6-1: rows over invalid sites report diagnostics instead of throwing', () => {
  for (const k of ['site K { width = 20nm }', 'site K { width = 20nm; height = "x" }', 'site K { height = 50nm }']) {
    for (const row of ['row R { site = K }', 'row R { site = K; y = "a" }']) {
      const r = resolveSource(G1 + `${k}\nsite S { width = 20nm; height = 100nm\n  ${row} }`);
      assert.ok(errs(r).length > 0, `${k} / ${row}`);
    }
  }
});

test('C6 follow-up: track spans count for the coordinate limit', () => {
  const r = resolveSource(G1 + 'layer V { role = conductor; direction = vertical }\nsite S { width = 20nm; height = 4503599627370497nm\n  tracks G { layer = V; at = [0nm] } }');
  assert.ok(codes(r).includes('V040'), JSON.stringify(r.diags));
});

// Every value in a template body replaced by values of other types: resolution
// reports diagnostics and never throws (core/template.js runs on whatever resolved).
import { recognizeDevices as recognize } from '../core/rulecheck.js';
test('template expansion and recognition never throw on invalid values', () => {
  const src = G1 + `layer M { role = conductor; direction = horizontal; pitch = 10nm; width = 4nm }
layer V { role = conductor; direction = vertical; pitch = 10nm }
layer CH { role = channel }
layer MK { role = marker }
stratum ST { layers = [M]; polarity = [n, p] }
figure F { layer = CH; width = 2nm }
cross X { gate = V; channel = F; faces = [top]; stratum = ST
  model mn { polarity = n; markers = [MK]; exclude = [M] }
  model mp { polarity = p; marker = MK } }
site K { width = 20nm; height = 50nm
  rail A { layer = M; y = 20nm; width = 4nm }
  tracks T2 { layer = M; pitch = 10nm; offset = 5nm }
  band p { stratum = ST; y = 0nm .. 25nm }
  tracks M { use = 1..3 }
  edge_feature E { layer = V; width = 4nm; extend = 2nm; at = [left, top] } }
site S { width = 20nm; height = 100nm
  row R { site = K; y = 50nm; flip = true }
  tracks G { layer = V; at = [0nm, 10nm] } }
`;
  const subs = ['one_of(1nm)', '[]', '[1, "a"]', '"x"', '"-1"', '1', '-5nm', '0nm', '0.001nm', '1nm .. 0nm', '[1nm, 2nm]', 'none', 'one_of(1nm, -1nm)', 'true', 'M', '[M, 1]', 'n'];
  let n = 0;
  for (const m of src.matchAll(/(=\s*)([^;{}\n]+?)(\s*[;}\n])/g)) {
    if (m.index < src.indexOf('stratum ST')) continue;
    for (const sub of subs) {
      const v = src.slice(0, m.index) + m[1] + sub + m[3] + src.slice(m.index + m[0].length);
      assert.doesNotThrow(() => { const r = resolveSource(v); recognize(r.resolved, { shapes: [{ layer: 'V', rect: [0, 0, 2, 10] }, { layer: 'CH', rect: [-5, 2, 5, 4] }, { layer: 'MK', rect: [-9, -9, 9, 19] }] }); }, `${m[0]} -> ${sub}`);
      n++;
    }
  }
  assert.ok(n > 400, `${n}`);
});

// ---- ---------------------------------------
test('C8: at most 100000 tracks in one row, counting both ends', () => {
  const run = (h) => resolveSource(G1 + `layer M { role = conductor; direction = horizontal; pitch = 1nm }\nsite S { width = 20nm; height = ${h}nm\n  tracks M {} }`);
  const ok = run(99999);
  assert.deepEqual(errs(ok), []);
  assert.equal(expandSite(ok.resolved, 'S').tracks[0].positions.length, 100000);
  assert.ok(codes(run(100000)).includes('V040'));
});
