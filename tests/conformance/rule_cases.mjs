// The rule conformance cases (VOCABULARY.md section 3), shared by the JavaScript
// tests (rules.test.mjs) and the Python port's tests (export_cases.mjs writes
// them, resolved, with the reference results, for python/tests/).

export const TECH = `stencil 0.1
technology { grid = 1nm }
layer M1 { role = conductor; masks = 1 }
layer V1 { role = cut }
layer M2 { role = conductor }
layer MK { role = marker }
layer GM { role = marker; from = grow(M1, 2nm) }
connector C { lower = M1; cut = V1; upper = M2 }
layer A { role = conductor }
layer B { role = conductor }
layer M { role = marker }
`;
export const R = (layer, x0, y0, x1, y1, extra = {}) => ({ layer, rect: [x0, y0, x1, y1], ...extra });

// [name, rules, shapes, expected violations, expected unsupported (default 0), xySymmetric]
// xySymmetric: the case still holds with x and y exchanged (axis attributes and margins swapped too).
export const CASES = [
  // width / length / area
  ['width at threshold passes', 'rule W { kind = width; on = M1; value = 10nm }', [R('M1', 0, 0, 10, 100)], 0],
  ['width below threshold fails', 'rule W { kind = width; on = M1; value = 11nm }', [R('M1', 0, 0, 10, 100)], 1],
  ['width axis = y measures the vertical extent', 'rule W { kind = width; on = M1; axis = y; value = 100nm }', [R('M1', 0, 0, 10, 100)], 0],
  ['width limit = max at threshold passes', 'rule W { kind = width; on = M1; limit = max; value = 10nm }', [R('M1', 0, 0, 10, 100)], 0],
  ['width limit = max above fails', 'rule W { kind = width; on = M1; limit = max; value = 9nm }', [R('M1', 0, 0, 10, 100)], 1],
  ['width limit = exact', 'rule W { kind = width; on = M1; limit = exact; value = 10nm }', [R('M1', 0, 0, 10, 100), R('M1', 50, 0, 62, 100)], 1],
  ['off-grid width threshold is exact', 'rule W { kind = width; on = M1; value = 10.5nm }', [R('M1', 0, 0, 10, 100), R('M1', 50, 0, 61, 100)], 1],
  ['length is the longer extent', 'rule L { kind = length; on = M1; value = 100nm }', [R('M1', 0, 0, 10, 100), R('M1', 50, 0, 60, 99)], 1],
  ['min_length is length with limit = min', 'rule L { kind = min_length; on = M1; value = 100nm }', [R('M1', 0, 0, 10, 99)], 1],
  ['area at threshold passes', 'rule AR { kind = area; on = M1; value = 1000nm * 1nm }', [R('M1', 0, 0, 10, 100)], 0],
  ['area below threshold fails', 'rule AR { kind = area; on = M1; value = 1001nm * 1nm }', [R('M1', 0, 0, 10, 100)], 1],
  ['touching figures are one component', 'rule W { kind = width; on = M1; value = 20nm }', [R('M1', 0, 0, 10, 20), R('M1', 10, 0, 20, 20)], 0],
  ['a non-rectangular component is unsupported', 'rule W { kind = width; on = M1; value = 5nm }', [R('M1', 0, 0, 10, 100), R('M1', 0, 0, 100, 10)], 0, 1],

  // spacing: Euclidean 3-4-5, overlap, contact, axis, prl, tables, nets
  ['3-4-5 diagonal: 5nm passes', 'rule S { kind = spacing; on = M1; value = 5nm }', [R('M1', 0, 0, 10, 10), R('M1', 13, 14, 23, 24)], 0],
  ['3-4-5 diagonal: 5.1nm fails', 'rule S { kind = spacing; on = M1; value = 5.1nm }', [R('M1', 0, 0, 10, 10), R('M1', 13, 14, 23, 24)], 1],
  ['3-4-5 diagonal: 4.9nm passes', 'rule S { kind = spacing; on = M1; value = 4.9nm }', [R('M1', 0, 0, 10, 10), R('M1', 13, 14, 23, 24)], 0],
  ['spacing across layers: overlap fails even at 0', 'rule S { kind = spacing; on = [M1, M2]; value = 0nm }', [R('M1', 0, 0, 10, 10), R('M2', 5, 5, 15, 15)], 1],
  ['spacing across layers: contact measures 0', 'rule S { kind = spacing; on = [M1, M2]; value = 0nm }', [R('M1', 0, 0, 10, 10), R('M2', 10, 0, 20, 10)], 0],
  ['spacing across layers: contact fails a positive value', 'rule S { kind = spacing; on = [M1, M2]; value = 1nm }', [R('M1', 0, 0, 10, 10), R('M2', 10, 10, 20, 20)], 1],
  ['spacing [A, B] is symmetric', 'rule S { kind = spacing; on = [M2, M1]; value = 6nm }', [R('M1', 0, 0, 10, 10), R('M2', 15, 0, 25, 10)], 1],
  ['spacing axis = x ignores diagonal pairs', 'rule S { kind = spacing; on = M1; axis = x; value = 10nm }', [R('M1', 0, 0, 10, 10), R('M1', 13, 14, 23, 24)], 0, 0, true],
  ['spacing axis = x measures the x gap of facing pairs', 'rule S { kind = spacing; on = M1; axis = x; value = 10nm }', [R('M1', 0, 0, 10, 10), R('M1', 15, 10, 25, 20)], 1, 0, true],
  ['prl below the condition: not subject', 'rule S { kind = spacing; on = M1; prl = 30nm; value = 20nm }', [R('M1', 0, 0, 10, 100), R('M1', 15, 80, 25, 200)], 0],
  ['prl at the condition: subject', 'rule S { kind = spacing; on = M1; prl = 20nm; value = 20nm }', [R('M1', 0, 0, 10, 100), R('M1', 15, 80, 25, 200)], 1],
  ['table: narrow, short prl -> 10nm', 'rule S { kind = spacing; on = M1\n table { width = [0nm, 20nm]; prl = [0nm, 50nm]; values = [[10nm, 12nm], [14nm, 16nm]] } }', [R('M1', 0, 0, 10, 100), R('M1', 20, 60, 30, 200)], 0],
  ['table: narrow, prl = 50 enters column 2 -> 12nm', 'rule S { kind = spacing; on = M1\n table { width = [0nm, 20nm]; prl = [0nm, 50nm]; values = [[10nm, 12nm], [14nm, 16nm]] } }', [R('M1', 0, 0, 10, 100), R('M1', 21, 50, 31, 200)], 1],
  ['table: width = 20 enters row 2 -> 14nm', 'rule S { kind = spacing; on = M1\n table { width = [0nm, 20nm]; prl = [0nm, 50nm]; values = [[10nm, 12nm], [14nm, 16nm]] } }', [R('M1', 0, 0, 20, 100), R('M1', 33, 60, 43, 200)], 1],
  ['table: last bin is open', 'rule S { kind = spacing; on = M1\n table { width = [0nm, 20nm]; prl = [0nm, 50nm]; values = [[10nm, 12nm], [14nm, 16nm]] } }', [R('M1', 0, 0, 90, 900), R('M1', 106, 0, 196, 900)], 0],
  ['table: missing prl index is [0]', 'rule S { kind = spacing; on = M1\n table { width = [0nm, 20nm]; values = [[10nm], [14nm]] } }', [R('M1', 0, 0, 30, 100), R('M1', 43, 0, 73, 100)], 1],
  ['same_net = false skips same-net pairs', 'rule S { kind = spacing; on = M1; same_net = false; value = 10nm }', [R('M1', 0, 0, 10, 10, { net: 'a' }), R('M1', 15, 0, 25, 10, { net: 'a' })], 0],
  ['same_net = false checks different nets', 'rule S { kind = spacing; on = M1; same_net = false; value = 10nm }', [R('M1', 0, 0, 10, 10, { net: 'a' }), R('M1', 15, 0, 25, 10, { net: 'b' })], 1],
  ['same_net without net data is unsupported', 'rule S { kind = spacing; on = M1; same_net = true; value = 10nm }', [R('M1', 0, 0, 10, 10), R('M1', 15, 0, 25, 10)], 0, 1],
  ['same_color = true checks equal masks only', 'rule S { kind = spacing; on = M1; same_color = true; value = 10nm }', [R('M1', 0, 0, 10, 10, { color: 1 }), R('M1', 15, 0, 25, 10, { color: 2 }), R('M1', 30, 0, 40, 10, { color: 1 })], 0],
  ['width_below is strict', 'rule S { kind = spacing; on = M1; width_below = 10nm; value = 10nm }', [R('M1', 0, 0, 10, 100), R('M1', 15, 0, 25, 100)], 0],
  ['width_above is strict', 'rule S { kind = spacing; on = M1; width_above = 9nm; value = 10nm }', [R('M1', 0, 0, 10, 100), R('M1', 15, 0, 25, 100)], 1],
  ['empty subject set passes', 'rule S { kind = spacing; on = M2; value = 10nm }', [R('M1', 0, 0, 10, 10), R('M1', 12, 0, 22, 10)], 0],

  // cut spacing
  ['cut_spacing on a connector: edge distance', 'rule S { kind = cut_spacing; on = C; value = 10nm }', [R('V1', 0, 0, 10, 10, { connector: 'C' }), R('V1', 18, 0, 28, 10, { connector: 'C' })], 1],
  ['cut_spacing measure = center', 'rule S { kind = cut_spacing; on = C; measure = center; value = 18nm }', [R('V1', 0, 0, 10, 10, { connector: 'C' }), R('V1', 18, 0, 28, 10, { connector: 'C' })], 0],
  ['cut_spacing measure = center, 3-4-5 centres', 'rule S { kind = cut_spacing; on = C; measure = center; value = 25.5nm }', [R('V1', 0, 0, 10, 10, { connector: 'C' }), R('V1', 15, 20, 25, 30, { connector: 'C' })], 1],
  ['cuts without connector data are unsupported', 'rule S { kind = cut_spacing; on = C; value = 10nm }', [R('V1', 0, 0, 10, 10)], 0, 1],

  // corner spacing
  ['corner_spacing measures diagonal pairs', 'rule S { kind = corner_spacing; on = M1; value = 6nm }', [R('M1', 0, 0, 10, 10), R('M1', 13, 14, 23, 24)], 1],
  ['corner_spacing ignores side-by-side pairs', 'rule S { kind = corner_spacing; on = M1; value = 6nm }', [R('M1', 0, 0, 10, 10), R('M1', 13, 5, 23, 15)], 0],

  // end of line
  ['eol: gap beyond the end', 'rule S { kind = eol_spacing; on = M1; value = 8nm }', [R('M1', 0, 0, 100, 10), R('M1', 105, 0, 115, 40)], 1],
  ['eol: gap at threshold passes', 'rule S { kind = eol_spacing; on = M1; value = 5nm }', [R('M1', 0, 0, 100, 10), R('M1', 105, 0, 115, 40)], 0],
  ['eol: target outside the window is not subject', 'rule S { kind = eol_spacing; on = M1; value = 8nm }', [R('M1', 0, 0, 100, 10), R('M1', 105, 13, 115, 53)], 0],
  ['eol: within widens the window (inclusive)', 'rule S { kind = eol_spacing; on = M1; within = 3nm; value = 8nm }', [R('M1', 0, 0, 100, 10), R('M1', 105, 13, 115, 53)], 1],
  ['eol: a parallel neighbour ending flush is not beyond the end', 'rule S { kind = eol_spacing; on = M1; within = 20nm; value = 8nm }', [R('M1', 0, 0, 100, 10), R('M1', 0, 20, 100, 30)], 0],
  ['eol: a square subject needs an axis', 'rule S { kind = eol_spacing; on = M1; value = 8nm }', [R('M1', 0, 0, 10, 10)], 0, 1],

  // enclosure
  ['enclosure: 5nm margins pass 5nm', 'rule E { kind = enclosure; on = [V1, M1]; value = 5nm }', [R('V1', 10, 10, 20, 20), R('M1', 5, 5, 25, 25)], 0],
  ['enclosure: 5nm margins fail 6nm', 'rule E { kind = enclosure; on = [V1, M1]; value = 6nm }', [R('V1', 10, 10, 20, 20), R('M1', 5, 5, 25, 25)], 1],
  ['enclosure axis = x checks left and right only', 'rule E { kind = enclosure; on = [V1, M1]; axis = x; value = 5nm }', [R('V1', 10, 10, 20, 20), R('M1', 5, 10, 25, 20)], 0, 0, true],
  ['enclosure: not contained fails', 'rule E { kind = enclosure; on = [V1, M1]; axis = x; value = 0nm }', [R('V1', 10, 10, 20, 20), R('M1', 5, 12, 25, 20)], 1, 0, true],
  ['enclosure operand order matters', 'rule E { kind = enclosure; on = [M1, V1]; value = 0nm }', [R('V1', 10, 10, 20, 20), R('M1', 5, 5, 25, 25)], 1],
  ['enclosure: alternatives, first holds', 'rule E { kind = enclosure; on = [V1, M1]\n alternative a { margins = [0nm, 0nm, 5nm, 5nm] }\n alternative b { margins = [5nm, 5nm, 0nm, 0nm] } }', [R('V1', 10, 10, 20, 20), R('M1', 10, 5, 20, 25)], 0, 0, true],
  ['enclosure: alternatives, none holds', 'rule E { kind = enclosure; on = [V1, M1]\n alternative a { margins = [0nm, 0nm, 5nm, 5nm] }\n alternative b { margins = [5nm, 5nm, 0nm, 0nm] } }', [R('V1', 10, 10, 20, 20), R('M1', 8, 8, 22, 22)], 1, 0, true],
  ['edge alignment is exact zero enclosure', 'rule E { kind = enclosure; on = [V1, M1]; axis = x; limit = exact; value = 0nm }', [R('V1', 10, 10, 20, 20), R('M1', 10, 0, 20, 30), R('V1', 50, 10, 60, 20), R('M1', 49, 0, 60, 30)], 1, 0, true],
  ['enclosure by a connector: lower and upper', 'rule E { kind = enclosure; on = C; value = 5nm }', [R('V1', 10, 10, 20, 20, { connector: 'C' }), R('M1', 5, 5, 25, 25), R('M2', 6, 5, 25, 25)], 1],
  ['enclosure width_above selects wide outer shapes', 'rule E { kind = enclosure; on = [V1, M1]; width_above = 30nm; value = 10nm }', [R('V1', 10, 10, 20, 20), R('M1', 5, 5, 25, 25)], 0],

  // extension
  ['extension: both ends at threshold', 'rule X { kind = extension; on = [M1, M2]; axis = x; value = 10nm }', [R('M1', 0, 10, 30, 20), R('M2', 10, 0, 20, 30)], 0, 0, true],
  ['extension: one end short', 'rule X { kind = extension; on = [M1, M2]; axis = x; value = 10nm }', [R('M1', 0, 10, 29, 20), R('M2', 10, 0, 20, 30)], 1, 0, true],
  ['extension: no overlap, no obligation', 'rule X { kind = extension; on = [M1, M2]; axis = x; value = 10nm }', [R('M1', 0, 10, 5, 20), R('M2', 10, 0, 20, 30)], 0, 0, true],

  // containment family
  ['inside: covered by a union (shared boundary allowed)', 'rule I { kind = inside; on = [V1, M1] }', [R('V1', 5, 0, 15, 10), R('M1', 0, 0, 10, 10), R('M1', 10, 0, 20, 10)], 0],
  ['inside: partly outside fails', 'rule I { kind = inside; on = [V1, M1] }', [R('V1', 5, 0, 25, 10), R('M1', 0, 0, 10, 10), R('M1', 10, 0, 20, 10)], 1],
  ['interacting: point contact counts', 'rule I { kind = interacting; on = [V1, M1] }', [R('V1', 10, 10, 20, 20), R('M1', 0, 0, 10, 10)], 0],
  ['interacting: apart fails', 'rule I { kind = interacting; on = [V1, M1] }', [R('V1', 11, 10, 20, 20), R('M1', 0, 0, 10, 10)], 1],
  ['not_interacting: edge contact fails', 'rule I { kind = not_interacting; on = [V1, M1] }', [R('V1', 10, 0, 20, 10), R('M1', 0, 0, 10, 10)], 1],
  ['not_overlapping: edge contact passes', 'rule I { kind = not_overlapping; on = [V1, M1] }', [R('V1', 10, 0, 20, 10), R('M1', 0, 0, 10, 10)], 0],
  ['not_overlapping: overlap fails', 'rule I { kind = not_overlapping; on = [V1, M1] }', [R('V1', 9, 0, 20, 10), R('M1', 0, 0, 10, 10)], 1],

  // scope, regions, intent, cases
  ['scope selects whole subject components', 'rule W { kind = width; on = M1; scope = MK; value = 20nm }', [R('M1', 0, 0, 10, 100), R('M1', 50, 0, 60, 100), R('MK', 55, 90, 70, 120)], 1],
  ['a computed marker is evaluated: grow by 2nm', 'rule W { kind = width; on = GM; value = 14nm }', [R('M1', 0, 0, 10, 100)], 0],
  ['a computed marker is evaluated: grow by 2nm (fail)', 'rule W { kind = width; on = GM; value = 15nm }', [R('M1', 0, 0, 10, 100)], 1],
  ['checker_only rules are skipped in generator mode', 'rule W { kind = width; on = M1; value = 20nm; intent = checker_only }', [R('M1', 0, 0, 10, 100)], 0],
  ['length cases need connection data: unsupported', 'rule L { kind = length; on = M1\n case via_end { value = 20nm }\n case open_end { value = 30nm } }', [R('M1', 0, 0, 10, 100)], 0, 1],
];

// Regression cases, so that they
// also run through every invariance transformation below.
const N = (net) => ({ net });
CASES.push(
  ['R: scope, either member in scope', 'rule T { kind = spacing; on = A; scope = M; value = 2nm }', [R('A', 0, 0, 1, 1), R('A', 2, 0, 3, 1), R('M', 2, 0, 3, 1)], 1],
  ['R: enclosure by a merged container', 'rule T { kind = enclosure; on = [A, B]; value = 0nm }', [R('A', 1, 1, 3, 3), R('B', 0, 0, 2, 4), R('B', 2, 0, 4, 4)], 0],
  ['R: interacting, merged subject', 'rule T { kind = interacting; on = [A, B] }', [R('A', 0, 0, 2, 2), R('A', 2, 0, 4, 2), R('B', -1, 0, 0, 2)], 0],
  ['R: shrink of a merged component', 'region RR { from = shrink(A, 1nm) }\nrule T { kind = width; on = RR; value = 100nm }', [R('A', 0, 0, 2, 4), R('A', 2, 0, 4, 4)], 1],
  ['R: eol width condition with same_net', 'rule T { kind = eol_spacing; on = A; axis = x; width_below = 3nm; same_net = true; value = 2nm }', [R('A', 0, 0, 10, 2, N('n')), R('A', 11, 0, 21, 10, N('n'))], 1, 0, true],
  ['R: exact distance beyond 2^53', 'rule T { kind = spacing; on = [A, B]; value = 100000001nm }', [R('A', 0, 0, 1, 1), R('B', 100000002, 2, 100000003, 3)], 0],
  ['R: exact area beyond 2^53 (fail)', 'rule T { kind = area; on = A; value = 9007199515875290nm * 1nm }', [R('A', 0, 0, 94906267, 94906267)], 1],
  ['R: exact area beyond 2^53 (pass)', 'rule T { kind = area; on = A; value = 9007199515875289nm * 1nm }', [R('A', 0, 0, 94906267, 94906267)], 0],
  ['R: corner spacing ignores overlap', 'rule T { kind = corner_spacing; on = [A, B]; value = 1nm }', [R('A', 0, 0, 2, 2), R('B', 1, 1, 3, 3)], 0],
  ['R: regularized intersect', 'region RR { from = intersect(A, B) }\nrule T { kind = interacting; on = [A, RR] }', [R('A', 0, 0, 2, 2), R('B', 2, 0, 4, 2)], 1],
  ['R: minus into two rectangles', 'region RR { from = minus(A, B) }\nrule T { kind = width; on = RR; value = 3nm }', [R('A', 0, 0, 6, 2), R('B', 2, -1, 4, 3)], 2],
  ['R: grow keeps nets', 'region G { from = grow(A, 0nm) }\nrule T { kind = spacing; on = G; same_net = false; value = 5nm }', [R('A', 0, 0, 1, 1, N('a')), R('A', 3, 0, 4, 1, N('b'))], 1],
  ['R: [G, G] is G', 'region G { from = grow(A, 0nm) }\nrule T { kind = spacing; on = [G, G]; value = 1nm }', [R('A', 0, 0, 1, 1), R('A', 3, 0, 4, 1)], 0],
  ['R: shrink keeps mixed nets (unsupported)', 'region G { from = shrink(A, 1nm) }\nrule T { kind = spacing; on = G; same_net = true; value = 10nm }', [R('A', 0, 0, 4, 8, N('a')), R('A', 4, 0, 8, 8, N('b')), R('A', 10, 0, 18, 8, N('b'))], 0, 1],
  ['R: shrink keeps mixed colours (unsupported)', 'region G { from = shrink(A, 1nm) }\nrule T { kind = spacing; on = G; same_color = true; value = 10nm }', [R('A', 0, 0, 4, 8, { color: 1 }), R('A', 4, 0, 8, 8, { color: 2 }), R('A', 10, 0, 18, 8, { color: 2 })], 0, 1],
  ['R: cuts of mixed connectors (unsupported)', 'rule T { kind = cut_spacing; on = C; value = 10nm }', [R('V1', 0, 0, 4, 4, { connector: 'C' }), R('V1', 4, 0, 8, 4, { connector: 'D' })], 0, 1],
  ['R: full-range spacing, exact', 'rule T { kind = spacing; on = [A, B]; value = 4503599627370494nm }', [R('A', -2251799813685248, 0, -2251799813685247, 1), R('B', 2251799813685247, 0, 2251799813685248, 1)], 0, 0, true],
  ['R: full-range spacing, one more fails', 'rule T { kind = spacing; on = [A, B]; value = 4503599627370495nm }', [R('A', -2251799813685248, 0, -2251799813685247, 1), R('B', 2251799813685247, 0, 2251799813685248, 1)], 1, 0, true],
  ['R: full-range area, exact (9 x 2^51)', 'rule T { kind = area; on = A; value = 20266198323167232nm * 1nm }', [R('A', 0, 0, 2251799813685248, 9)], 0],
  ['R: full-range area, one more fails', 'rule T { kind = area; on = A; value = 20266198323167233nm * 1nm }', [R('A', 0, 0, 2251799813685248, 9)], 1],
  ['R: full-range centre distance, exact', 'rule T { kind = cut_spacing; on = C; measure = center; value = 4503599627370494nm }', [R('V1', -2251799813685248, 0, -2251799813685246, 2, { connector: 'C' }), R('V1', 2251799813685246, 0, 2251799813685248, 2, { connector: 'C' })], 0, 0, true],
  ['R: full-range centre distance, one more fails', 'rule T { kind = cut_spacing; on = C; measure = center; value = 4503599627370495nm }', [R('V1', -2251799813685248, 0, -2251799813685246, 2, { connector: 'C' }), R('V1', 2251799813685246, 0, 2251799813685248, 2, { connector: 'C' })], 1, 0, true],
  ['R: derived geometry out of range (unsupported)', 'region G { from = grow(grow(A, 1125899906842624nm), 1125899906842624nm) }\nrule T { kind = width; on = G; limit = max; value = 9007199254740992.5nm }', [R('A', 0, 0, 1, 1)], 0, 1],
);

// Invariance: the verdicts must not depend on position, orientation or order.
export const xform = {
  translate: (s) => ({ ...s, rect: [s.rect[0] + 1000, s.rect[1] - 777, s.rect[2] + 1000, s.rect[3] - 777] }),
  mirror: (s) => ({ ...s, rect: [-s.rect[2], s.rect[1], -s.rect[0], s.rect[3]] }),
  rotate180: (s) => ({ ...s, rect: [-s.rect[2], -s.rect[3], -s.rect[0], -s.rect[1]] }),
};
export const swapRules = (rules) => rules
  .replace(/axis = ([xy])/g, (_, a) => `axis = ${a === 'x' ? 'Y' : 'X'}`).replace(/axis = ([XY])/g, (_, a) => `axis = ${a.toLowerCase()}`)
  .replace(/margins = \[([^,]+), ([^,]+), ([^,]+), ([^\]]+)\]/g, 'margins = [$3, $4, $1, $2]');

// Every variant of a case that must give the same verdict: [label, rules, shapes].
export function variantsOf([, rules, shapes, , , xy = false]) {
  const variants = Object.entries(xform).map(([k, f]) => [k, rules, shapes.map(f)]);
  variants.push(['reverse order', rules, [...shapes].reverse()]);
  // the same geometry drawn as more figures: split every figure in two abutting halves
  variants.push(['split figures', rules, shapes.flatMap((sh) => {
    const [x0, y0, x1, y1] = sh.rect;
    if (x1 - x0 < 2) return [sh];
    const xm = Math.floor((x0 + x1) / 2);
    return [{ ...sh, rect: [x0, y0, xm, y1] }, { ...sh, rect: [xm, y0, x1, y1] }];
  })]);
  const hasAxis = /axis =|margins/.test(rules);
  if (!hasAxis || xy) variants.push(['x/y exchange', swapRules(rules), shapes.map((s) => ({ ...s, rect: [s.rect[1], s.rect[0], s.rect[3], s.rect[2]] }))]);
  // the transform may leave the input range
  return variants.filter(([, , sh]) => !sh.some((x) => x.rect.some((v) => Math.abs(v) > 2 ** 51)));
}
