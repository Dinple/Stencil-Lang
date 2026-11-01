// Tool profiles (SPEC.md section 6.3, VOCABULARY.md section 2.12): does a resolved
// technology use anything a tool cannot handle? Run before any job starts, so
// a missing capability shows up as a message, not as an unexplained failure.
import { expandSite } from './template.js';
import { maxOf, minOf } from './jsmath.js';

// Effective routing mode of a conductor layer.
export function tracksMode(l) {
  if (l.attrs.tracks_mode) return l.attrs.tracks_mode;
  return l.attrs.pitch !== undefined || l.attrs.tracks ? 'required' : 'none';
}

function inRange(v, r) {
  if (typeof r === 'number') return v === r;
  if (r && typeof r === 'object' && 'min' in r) return v >= r.min && v <= r.max;
  return true;
}

// resolved: a resolved technology; profile: a resolved `profile` object.
// Returns findings { object, message } (empty = the tool can take it).
// The conditions and forms a rule uses (VOCABULARY.md section 3.5-3.6), as profile feature words.
const CONDITIONS = ['axis', 'same_net', 'same_color', 'width_below', 'width_above', 'prl', 'within', 'scope'];
export function ruleFeatures(r) {
  const out = CONDITIONS.filter((c) => r.attrs[c] !== undefined);
  if (r.attrs.limit && r.attrs.limit !== 'min') out.push(`limit_${r.attrs.limit}`);
  if (r.attrs.measure === 'center') out.push('measure_center');
  for (const c of r.children ?? []) if (['table', 'case', 'alternative'].includes(c.kind) && !out.includes(c.kind)) out.push(c.kind);
  return out;
}

// A cell generator routes only inside the cell: from the device tier up to
// the highest layer the site uses for pins or in-cell tracks. `sites`: the
// names of the sites to consider (default: every site).
function scopeOf(resolved, siteNames) {
  const layers = resolved.objects.filter((o) => o.kind === 'layer');
  const byName = new Map(layers.map((l) => [l.name, l]));
  const sites = resolved.objects.filter((o) => o.kind === 'site' && (!siteNames || siteNames.includes(o.name)));
  const top = maxOf(sites.flatMap((site) => [
    ...(site.attrs.pins ?? []).map((x) => byName.get(x.ref)?.attrs.order ?? -Infinity),
    ...expandSite(resolved, site.name).tracks.map((t) => byName.get(t.layer)?.attrs.order ?? -Infinity),
  ]), -Infinity);
  const devOrders = resolved.objects.filter((o) => o.kind === 'stratum').flatMap((st) => (st.attrs.layers ?? []).map((x) => byName.get(x.ref)?.attrs.order)).filter((x) => x !== undefined);
  const bottom = devOrders.length ? minOf(devOrders) : -Infinity;
  // Device-tier layers (strata and transistor gates) are placed, not routed.
  const placedOnly = new Set([
    ...resolved.objects.filter((o) => o.kind === 'stratum').flatMap((st) => (st.attrs.layers ?? []).map((x) => x.ref)),
    ...resolved.objects.filter((o) => o.kind === 'cross').map((x) => x.attrs.gate?.ref),
  ]);
  // Without a site to bound it, every layer is in scope except the placed-only ones.
  const inScope = (l) => !placedOnly.has(l.name) && (top === -Infinity || (l.attrs.order >= bottom && l.attrs.order <= top));
  return { layers, inScope, top };
}

// The conductor layers a cell generator routes on, in resolved-form order.
export function routingScope(resolved, sites) {
  const { layers, inScope } = scopeOf(resolved, sites);
  return layers.filter((o) => o.attrs.role === 'conductor' && inScope(o));
}

export function checkProfile(resolved, profile) {
  const p = profile.attrs;
  const out = [];
  const add = (object, message) => out.push({ object, message });
  const { layers, inScope, top } = scopeOf(resolved);
  const conductors = layers.filter((o) => o.attrs.role === 'conductor' && inScope(o));
  const scopeNames = new Set(layers.filter(inScope).map((l) => l.name));
  if (top !== -Infinity) out.scope = conductors.map((l) => l.name);
  for (const l of conductors) {
    const dir = l.attrs.direction ?? 'none';
    const mode = tracksMode(l);
    if (p.sides && l.attrs.side && !p.sides.includes(l.attrs.side)) { add(l.name, `${l.attrs.side}-side layer; the tool routes only ${p.sides.join(', ')}`); continue; }
    if (p.directions && !p.directions.includes(dir)) add(l.name, `direction ${dir} is not supported (supports ${p.directions.join(', ')})`);
    if (p.tracks_modes && !p.tracks_modes.includes(mode)) add(l.name, `tracks_mode ${mode} is not supported (supports ${p.tracks_modes.join(', ')})`);
    if (p.needs_tracks && mode === 'none') add(l.name, 'the tool needs a routing grid, but this layer is routed by shape');
    if (p.masks !== undefined && !inRange(l.attrs.masks ?? 1, p.masks)) add(l.name, `${l.attrs.masks} masks is outside the supported ${typeof p.masks === 'number' ? p.masks : `${p.masks.min}..${p.masks.max}`}`);
  }
  const strata = resolved.objects.filter((o) => o.kind === 'stratum').length;
  if (p.strata !== undefined && strata && !inRange(strata, p.strata)) add('stratum', `${strata} strata; the tool supports ${typeof p.strata === 'number' ? p.strata : `${p.strata.min}..${p.strata.max}`}`);
  if (p.rule_kinds || p.rule_features) {
    const missing = new Map(), missingF = new Map();
    const refs = (v) => (Array.isArray(v) ? v : [v]).map((x) => x?.ref).filter(Boolean);
    const conn = new Map(resolved.objects.filter((o) => o.kind === 'connector').map((c) => [c.name, c]));
    // regions and computed (from = ...) layers both depend on the layers they are computed from
    const regions = new Map(resolved.objects.filter((o) => o.kind === 'region' || (o.kind === 'layer' && o.attrs.from)).map((x) => [x.name, x]));
    const layersOf = (expr, seen = new Set()) => {
      if (!expr || typeof expr !== 'object') return [];
      if (Array.isArray(expr)) return expr.flatMap((x) => layersOf(x, seen));
      if ('ref' in expr) {
        // keep the computed name itself as well as what it is computed from (it may be routed)
        if (regions.has(expr.ref) && !seen.has(expr.ref)) { seen.add(expr.ref); return [expr.ref, ...layersOf(regions.get(expr.ref).attrs.from, seen)]; }
        return [expr.ref];
      }
      // arguments: a list, or an object indexed by "0", "1", ... (as the checker reads them)
      const args = expr.args ?? [];
      return layersOf(args && typeof args === 'object' && !Array.isArray(args) ? Object.values(args) : args, seen);
    };
    // a name touches the scope when it, or a layer it is computed from, is in scope
    const inScopeVia = (x) => scopeNames.has(x) || (regions.has(x) && layersOf({ ref: x }).some((y) => scopeNames.has(y)));
    const touches = (r) => refs(r.attrs.on).some((n) => inScopeVia(n)
      || (conn.has(n) && [...refs(conn.get(n).attrs.lower), ...refs(conn.get(n).attrs.cut), ...refs(conn.get(n).attrs.upper)].some(inScopeVia)));
    for (const r of resolved.objects.filter((o) => o.kind === 'rule' && o.attrs.intent !== 'checker_only' && (top === -Infinity || touches(o)))) {
      if (p.rule_kinds && !p.rule_kinds.includes(r.attrs.kind)) missing.set(r.attrs.kind, [...(missing.get(r.attrs.kind) ?? []), r.name]);
      else if (p.rule_features) {
        for (const f of ruleFeatures(r)) if (!p.rule_features.includes(f)) missingF.set(f, [...(missingF.get(f) ?? []), r.name]);
      }
    }
    for (const [f, names] of missingF) add(names[0], `rule feature ${f} is not supported (${names.length} rule${names.length > 1 ? 's' : ''}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', ...' : ''})`);
    for (const [kind, names] of missing) add(names[0], `rule kind ${kind} is not supported (${names.length} rule${names.length > 1 ? 's' : ''}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', ...' : ''})`);
  }
  return out;
}
