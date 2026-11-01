// Vocabulary std/0 as data (VOCABULARY.md section 2). The resolver, the validator and
// the editor's autocompletion all read this table; nothing else in the core
// knows what a "layer" is.

import { Q } from './rational.js';

// ---- type constructors -------------------------------------------------------
const len = { k: 'len' };
const int = { k: 'int' };
const num = { k: 'num' };
const str = { k: 'str' };
const bool = { k: 'bool' };
const geom = { k: 'geom' };
const any = { k: 'any' };
const en = (...vals) => ({ k: 'enum', vals });
const ref = (...kinds) => ({ k: 'ref', kinds });
const list = (of) => ({ k: 'list', of });
const pair = (of) => ({ k: 'pair', of });
const range = (of) => ({ k: 'range', of });
const choice = (of) => ({ k: 'choice', of });
const union = (...of) => ({ k: 'union', of });
const attrref = (...kinds) => ({ k: 'attrref', kinds });
const area = { k: 'area' };
const xword = { k: 'xword' };   // an extension name such as x_lab_corner

const sized = union(len, choice(len), range(len));

// VOCABULARY.md section 3: rule kinds and the conditions each one accepts.
export const RULE_KINDS = ['width', 'length', 'min_length', 'area', 'spacing', 'cut_spacing', 'corner_spacing', 'eol_spacing',
  'enclosure', 'extension', 'inside', 'interacting', 'not_interacting', 'not_overlapping'];
export const PAIR_RULES = new Set(['spacing', 'cut_spacing', 'corner_spacing', 'eol_spacing']);
export const CONTAINMENT_RULES = new Set(['inside', 'interacting', 'not_interacting', 'not_overlapping']);
export const RULE_CONDITIONS = {
  axis: ['width', 'length', 'min_length', 'spacing', 'cut_spacing', 'eol_spacing', 'enclosure', 'extension'],
  same_net: ['spacing', 'cut_spacing', 'corner_spacing', 'eol_spacing'],
  same_color: ['spacing', 'cut_spacing', 'corner_spacing', 'eol_spacing'],
  width_below: ['spacing', 'corner_spacing', 'eol_spacing', 'enclosure'],
  width_above: ['spacing', 'corner_spacing', 'eol_spacing', 'enclosure'],
  prl: ['spacing'],
  within: ['eol_spacing'],
  measure: ['cut_spacing'],
};

// Evaluated default values (same shape as resolver values).
const dLen = (n) => ({ t: 'num', q: Q.int(n), dim: 1 });
const dInt = (n) => ({ t: 'num', q: Q.int(n), dim: 0 });
const dWord = (v) => ({ t: 'word', v });
const dList = (...items) => ({ t: 'list', items });

const a = (type, doc, extra = {}) => ({ type, doc, ...extra });
const req = (type, doc) => a(type, doc, { required: true });

// ---- object kinds -------------------------------------------------------------
// children: { kind: { name: 'required' | 'none', nameDoc } }
export const KINDS = {
  module: {
    level: 3, top: true, named: false,
    doc: 'Module metadata: version, vocabulary, extensions.',
    attrs: {
      version: a(str, 'Semantic version of this module, e.g. "1.2.0".'),
      vocabulary: a(str, 'Vocabulary this module is written against, e.g. "std/0".'),
      extensions: a(list(any), 'Extension namespaces this module depends on.'),
    },
  },
  technology: {
    level: 0, top: true, named: false,
    doc: 'Technology-wide settings. Top-level module only.',
    attrs: {
      grid: req(len, 'Manufacturing grid. One database unit in the resolved form.'),
      stack: a(list(any), 'Vertical order of imported modules, bottom to top.'),
      pdk: a(str, 'Source PDK URL.'),
      revision: a(str, 'Source PDK revision.'),
    },
  },
  layer: {
    level: 0, top: true, named: true,
    doc: 'One process level. Layers are listed bottom to top.',
    attrs: {
      role: req(en('channel', 'conductor', 'cut', 'marker'), 'What the layer carries.'),
      masks: a(int, 'Colors under multi-patterning.', { default: dInt(1) }),
      direction: a(en('horizontal', 'vertical', 'none'), 'Preferred routing direction. none = both.'),
      width: a(sized, 'Legal wire width: fixed, one_of(...) or a range.'),
      pitch: a(len, 'Routing-track pitch (shorthand for a track array).'),
      offset: a(len, 'Offset of the first routing track.'),
      tracks: a(ref('array'), 'Explicit routing-track array. Replaces pitch/offset.'),
      shapes: a(en('rect', 'polygon'), 'Allowed figure shapes.', { default: dWord('rect') }),
      gds: a(pair(int), 'GDS [layer, datatype] for drawn shapes.'),
      gds_pin: a(pair(int), 'GDS [layer, datatype] for pin shapes.'),
      gds_label: a(pair(int), 'GDS [layer, datatype] for pin text.'),
      from: a(geom, 'Marker layers: computed from other layers on the finished layout.'),
      below: a(ref('layer'), 'Place this layer lower than another one; it is inserted right under it (default: file order).'),
      above: a(ref('layer'), 'Place this layer higher than another one; it is inserted right over it (default: file order).'),
      level_with: a(ref('layer'), 'Put this layer at the same level as another one (e.g. gate and source/drain contact).'),
      side: a(en('back', 'device', 'front'), 'Wafer side. Default: inferred from the strata.'),
      tracks_mode: a(en('required', 'access', 'none'), 'required: route on tracks; access: pins on tracks, wires free; none: route by shape.'),
    },
  },
  figure: {
    level: 1, top: true, named: true,
    doc: 'A shape template on one layer. Its width model is the sizing model.',
    attrs: {
      layer: req(ref('layer'), 'Layer the figure is drawn on.'),
      width: req(sized, 'Fixed, one_of(...) discrete, or a free range.'),
      length: a(sized, 'Extent along the long axis.'),
      thickness: a(len, 'Channel figures: cross-section height (for W_eff).'),
      extend: a(ref('layer'), 'Extend past figures on this layer ...'),
      extend_by: a(len, '... by this much (e.g. a gate end cap).'),
    },
  },
  array: {
    level: 1, top: true, named: true,
    doc: 'Repeats one figure along an axis.',
    attrs: {
      of: req(ref('figure'), 'Figure being repeated.'),
      axis: req(en('x', 'y', 'z'), 'Axis of repetition.'),
      pitch: a(len, 'Distance between repeats (may be unknown for a sheet stack).'),
      offset: a(len, 'Position of the first repeat.', { default: dLen(0) }),
      count: req(union(int, range(int), en('fill')), 'Number of repeats; a range makes it a sizing knob; fill = as many as fit.'),
    },
  },
  cross: {
    level: 1, top: true, named: true,
    doc: 'A transistor: forms where a gate figure overlaps a channel figure.',
    attrs: {
      gate: req(ref('layer'), 'Gate layer.'),
      channel: req(ref('figure', 'array'), 'Channel figure or array.'),
      faces: req(union(en('all'), list(en('top', 'bottom', 'left', 'right'))), 'Faces of the channel the gate covers.'),
      stratum: a(ref('stratum'), 'The device tier this transistor is built in; its models must have a polarity of that tier.'),
      recognize: a(geom, 'Geometric expression for the channel regions (default: intersect(gate, channel layer)).'),
    },
    children: {
      size: { name: 'required', nameDoc: 'netlist parameter (w, nfin, ...)' },
      model: { name: 'required', nameDoc: 'SPICE model name' },
    },
  },
  size: {
    level: 1, named: true,
    doc: 'Maps a netlist parameter onto a figure or array attribute.',
    attrs: { sets: req(attrref('figure', 'array'), 'Target attribute, e.g. SHEET.width or FINS.count.') },
  },
  model: {
    level: 1, named: true,
    doc: 'Binds a SPICE model name to a polarity and a marker condition.',
    attrs: {
      polarity: req(en('n', 'p'), 'Device polarity.'),
      marker: a(ref('layer'), 'Shorthand for markers = [marker].'),
      markers: a(list(ref('layer')), 'Marker layers that must all cover the device.'),
      exclude: a(list(ref('layer')), 'Marker layers that must not touch the device.'),
    },
  },
  stratum: {
    level: 1, top: true, named: true,
    doc: 'One tier of transistors.',
    attrs: {
      layers: req(list(ref('layer')), 'Channel and contact layers of this tier.'),
      polarity: a(list(en('n', 'p')), 'Polarities in this tier, side by side.', { default: dList(dWord('n'), dWord('p')) }),
    },
  },
  connector: {
    level: 0, top: true, named: true,
    doc: 'Joins conductors on two layers through a cut (a via or contact).',
    attrs: {
      lower: req(union(ref('layer'), list(ref('layer'))), 'Lower layer; a list means any of them.'),
      cut: req(union(ref('layer'), en('none')), 'Cut layer, or none for a direct overlap contact.'),
      upper: req(ref('layer'), 'Upper layer.'),
      size: a(union(len, pair(len)), 'Cut size; one value = square.'),
      enclose_lower: a(union(len, pair(len)), 'Enclosure by the lower layer; two values = x, y.', { default: dLen(0) }),
      enclose_upper: a(union(len, pair(len)), 'Enclosure by the upper layer; two values = x, y.', { default: dLen(0) }),
    },
  },
  site: {
    level: 0, top: true, named: true,
    doc: 'The cell template: placement unit, row height, rails, bands.',
    attrs: {
      width: req(len, 'Placement unit in x.'),
      height: req(len, 'Row height.'),
      pins: a(list(ref('layer')), 'Pin layers.'),
      boundary: a(ref('layer'), 'Cell-outline layer.'),
      symmetry: a(list(en('x', 'y', 'r90')), 'Allowed symmetries (LEF export).'),
      abut: a(en('share_rails', 'none'), 'Treatment of the cell boundary at abutment.', { default: dWord('share_rails') }),
    },
    children: {
      rail: { name: 'required', nameDoc: 'rail name (the net, unless net is set)' },
      band: { name: 'required', nameDoc: 'band name (n or p, or any name with a polarity)' },
      tracks: { name: 'required', nameDoc: 'grid name (the layer, unless layer is set)' },
      row: { name: 'required', nameDoc: 'row name' },
      edge_feature: { name: 'required', nameDoc: 'feature name' },
    },
  },
  rail: {
    level: 0, named: true,
    doc: 'A power rail across the site: centred on an edge, or at a height y.',
    attrs: {
      layer: req(ref('layer'), 'Rail layer.'),
      net: a(str, 'Net name (default: the rail name).'),
      edge: a(en('top', 'bottom'), 'Site edge the rail is centred on (give edge or y).'),
      y: a(len, 'Height of the rail centreline (give edge or y).'),
      width: a(sized, 'Rail width (default: the layer width); a choice or range counts as its largest value.'),
    },
  },
  band: {
    level: 1, named: true,
    doc: 'Where transistors of one polarity sit inside the row.',
    attrs: {
      polarity: a(en('n', 'p'), 'Polarity (default: the band name, if it is n or p).'),
      stratum: req(ref('stratum'), 'Device tier.'),
      y: req(range(len), 'Vertical extent within the row, e.g. 0nm .. H/2.'),
    },
  },
  tracks: {
    level: 1, named: true,
    doc: 'In-cell tracks on one layer: index k sits at offset + k * pitch, counted from the bottom (horizontal layers) or the left (vertical layers), or at the positions in `at`.',
    attrs: {
      layer: a(ref('layer'), 'Layer (default: the layer named like this block).'),
      use: a(union(range(int), list(int)), 'Indices usable for signals, from 0, e.g. 1..4 (default: all).'),
      at: a(list(len), 'Explicit track positions (instead of a lattice).'),
      pitch: a(len, 'Local pitch (default: the layer pitch).'),
      offset: a(len, "Position of track 0 (default: the layer's offset, or 0nm with a local pitch)."),
    },
  },
  row: {
    level: 1, named: true,
    doc: 'A row made of another site: its bands, rails, tracks and edge features, shifted up by y and mirrored about its own centreline when flip = true.',
    attrs: {
      site: req(ref('site'), 'The site this row is made of (it must not have rows itself).'),
      y: a(len, 'Bottom of the row inside this site.', { default: dLen(0) }),
      flip: a(bool, 'Mirror the row about its horizontal centreline.', { default: { t: 'bool', v: false } }),
    },
  },
  edge_feature: {
    level: 1, named: true,
    doc: 'Geometry along a cell edge, e.g. a diffusion break or dummy gate on the left/right edges, or a gate cut on the top/bottom edges. Left/right features sit at the cell boundary (x = 0 and the cell width), whatever the cell width.',
    attrs: {
      layer: req(ref('layer'), 'Layer of the feature.'),
      at: a(union(en('left', 'right', 'top', 'bottom', 'both'), list(en('left', 'right', 'top', 'bottom'))), 'Which edges (both = left and right).', { default: dWord('both') }),
      width: req(len, 'Thickness across the edge.'),
      extend: a(len, 'How far the feature runs past the cell along the edge, at each end.', { default: dLen(0) }),
      y: a(range(len), 'Left/right features: vertical extent (default: the whole row).'),
      shared: a(bool, 'Centred on the edge, half in each abutting cell (the neighbour must have the same feature); else wholly inside the cell.', { default: { t: 'bool', v: true } }),
    },
  },
  rule: {
    level: 2, top: true, named: true,
    doc: 'A design rule drawn from a fixed vocabulary of kinds.',
    attrs: {
      kind: req(union(en(...RULE_KINDS), xword), 'Rule kind (VOCABULARY.md section 3), or an x_ extension kind.'),
      on: req(union(ref('layer', 'connector', 'region'), pair(ref('layer', 'region'))), 'One layer or region, two of them [A, B], or a connector.'),
      value: a(union(len, area, num), 'Rule value.'),
      axis: a(en('x', 'y'), 'Condition: the rule applies along this axis only.'),
      limit: a(en('min', 'max', 'exact'), 'min (default): measured >= value; max: <=; exact: ='),
      measure: a(en('edge', 'center'), 'cut_spacing: measure between edges (default) or centres.'),
      scope: a(ref('layer', 'region'), 'Apply only to subject figures that touch this layer or region.'),
      intent: a(en('pdk', 'generator', 'checker_only'), 'pdk = sign-off rule a generator honours; generator = stricter generator policy; checker_only = kept for checkers, ignored by generators.', { default: dWord('pdk') }),
      same_color: a(bool, 'Condition: both shapes on the same mask color.'),
      width_below: a(len, 'Condition: wire narrower than this.'),
      width_above: a(len, 'Condition: wire wider than this.'),
      prl: a(len, 'Condition: parallel run length at least this.'),
      within: a(len, 'Condition: within this distance.'),
      same_net: a(bool, 'Condition: shapes on the same net.'),
    },
    children: {
      case: { name: 'required', nameDoc: 'context (via_end, open_end)' },
      table: { name: 'none' },
      alternative: { name: 'required', nameDoc: 'a name for this option' },
    },
  },
  case: {
    level: 2, named: true,
    doc: 'A context-dependent rule value.',
    attrs: { value: req(union(len, area, num), 'Value in this context.') },
  },
  alternative: {
    level: 2, named: true,
    doc: 'One acceptable set of enclosure margins; the rule passes when any alternative holds.',
    attrs: { margins: req(list(len), 'Margins [left, right, bottom, top].') },
  },
  table: {
    level: 2, named: false,
    doc: 'Indexed rule values (e.g. width x parallel run length).',
    attrs: {
      width: a(list(len), 'Width index.'),
      prl: a(list(len), 'Parallel-run-length index.'),
      values: req(list(any), 'Values, one row per first index.'),
    },
  },
  region: {
    level: 2, top: true, named: true,
    doc: 'A named area used by rules. Never emitted to GDS.',
    attrs: { from: req(geom, 'Geometric expression.') },
  },
  check: {
    level: 3, top: true, named: true,
    doc: 'An assertion that must hold after composition, e.g. that a bound pitch still fits the wire width and spacing.',
    attrs: {
      holds: req(bool, 'A comparison, or all(...) / any(...) / not(...) of comparisons.'),
      message: a(str, 'What it means when the check fails.'),
      severity: a(en('error', 'warning'), 'How a failure is reported.', { default: dWord('error') }),
    },
  },
  profile: {
    level: 4, top: true, named: true,
    doc: 'Capabilities published by a tool.',
    attrs: {
      directions: a(list(en('horizontal', 'vertical', 'none')), 'Routing directions supported.'),
      needs_tracks: a(bool, 'Tool needs a routing grid.'),
      masks: a(union(int, range(int)), 'Mask counts supported.'),
      strata: a(union(int, range(int)), 'Device tiers supported.'),
      rule_kinds: a(list(any), 'Rule kinds supported.'),
      rule_features: a(list(any), 'Rule conditions and forms supported (axis, prl, table, case, alternative, limit_max, limit_exact, measure_center, scope, ...). Unset: every feature.'),
      tracks_modes: a(list(en('required', 'access', 'none')), 'Layer tracks_mode values the tool can route.'),
      sides: a(list(en('back', 'device', 'front')), 'Wafer sides the tool routes on.'),
    },
  },
};

// Attributes every object accepts (SPEC.md section 2.5).
export const RESERVED_ATTRS = {
  base: a(any, 'Inherit attributes and children from another object of the same kind.'),
  note: a(str, 'Free text, kept in the resolved form.'),
};

// ---- functions ----------------------------------------------------------------
export const FUNCTIONS = {
  min: { kind: 'numeric', doc: 'Smallest of the arguments.' },
  max: { kind: 'numeric', doc: 'Largest of the arguments.' },
  floor: { kind: 'numeric', doc: 'Round a length down to the grid.' },
  mod: { kind: 'numeric', doc: 'Remainder: mod(144nm, 26nm) = 14nm. Useful in checks, e.g. a row height that must be a whole number of pitches.' },
  ceil: { kind: 'numeric', doc: 'Round a length up to the grid.' },
  snap: { kind: 'numeric', doc: 'Round a length to the nearest grid point.' },
  one_of: { kind: 'value', doc: 'A discrete choice of values.' },
  union: { kind: 'geom', args: [geom, geom], variadic: true, doc: 'Union of layers or regions.' },
  intersect: { kind: 'geom', args: [geom, geom], variadic: true, doc: 'Intersection of layers or regions.' },
  minus: { kind: 'geom', args: [geom, geom], variadic: true, doc: 'First argument minus the others.' },
  xor: { kind: 'geom', args: [geom, geom], doc: 'Symmetric difference.' },
  grow: { kind: 'geom', args: [geom, len], doc: 'Grow shapes by a distance: grow(x, d).' },
  shrink: { kind: 'geom', args: [geom, len], doc: 'Shrink shapes by a distance: shrink(x, d).' },
  gaps: { kind: 'geom', args: [geom, en('x', 'y')], doc: 'Spaces between shapes along an axis: gaps(x, axis).' },
  touching: { kind: 'geom', args: [geom, geom], doc: 'Shapes of a that touch b.' },
  avoiding: { kind: 'geom', args: [geom, geom], doc: 'Shapes of a that do not touch b.' },
  band: { kind: 'geom', args: [en('n', 'p')], doc: 'The band area of one polarity: band(p).' },
  all: { kind: 'logic', doc: 'True when every argument is true.' },
  any: { kind: 'logic', doc: 'True when at least one argument is true.' },
  not: { kind: 'logic', doc: 'Negation.' },
};

// ---- helpers ------------------------------------------------------------------
export function attrSpec(kind, name) {
  return KINDS[kind]?.attrs[name] ?? RESERVED_ATTRS[name];
}

export function describeType(t) {
  switch (t.k) {
    case 'len': return 'a length (e.g. 20nm)';
    case 'int': return 'an integer';
    case 'num': return 'a number';
    case 'str': return 'a string';
    case 'bool': return 'true or false';
    case 'geom': return 'a layer or geometric expression';
    case 'any': return 'any value';
    case 'enum': return t.vals.join(' | ');
    case 'ref': return `a ${t.kinds.join(' or ')} name`;
    case 'attrref': return `an attribute of a ${t.kinds.join(' or ')}, e.g. NAME.width`;
    case 'area': return 'an area (e.g. 288nm * 1nm)';
    case 'xword': return 'an x_ extension name';
    case 'list': return `a list of ${plural(describeType(t.of))}`;
    case 'pair': return `a pair [${describeType(t.of)}, ${describeType(t.of)}]`;
    case 'range': return `a range of ${plural(describeType(t.of))} (a..b)`;
    case 'choice': return `one_of(...) of ${plural(describeType(t.of))}`;
    case 'union': return t.of.map(describeType).join(', or ');
    default: return t.k;
  }
}

function plural(s) {
  return s.replace(/^an? /, '').replace(/^(length|integer|number|string|layer|figure|array|stratum)\b/, '$1s');
}

// Enum words valid for a type (for completion and did-you-mean).
export function enumWords(t) {
  if (t.k === 'enum') return t.vals;
  if (t.k === 'union') return t.of.flatMap(enumWords);
  if (t.k === 'list' || t.k === 'pair') return enumWords(t.of);
  return [];
}

// Object kinds a type may reference.
export function refKinds(t) {
  if (t.k === 'ref') return t.kinds;
  if (t.k === 'union') return t.of.flatMap(refKinds);
  if (t.k === 'list' || t.k === 'pair') return refKinds(t.of);
  if (t.k === 'geom') return ['layer', 'region'];
  return [];
}

// Damerau-free Levenshtein, for "did you mean".
export function closest(word, candidates, maxDist = 2) {
  let best = null;
  let bestD = maxDist + 1;
  for (const c of candidates) {
    const d = editDistance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function editDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
