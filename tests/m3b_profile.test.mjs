// M3b: profiles check rule features, also without rule_kinds, and follow computed markers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource } from '../core/resolve.js';
import { checkProfile } from '../core/profile.js';

const SRC = `stencil 0.1
technology { grid = 1nm }
layer A { role = conductor; direction = horizontal; pitch = 10nm }
layer M { role = marker; from = grow(A, 1nm) }
site S { width = 10nm; height = 50nm; pins = [A] }
`;
const prof = (body) => resolveSource(SRC + `profile P { ${body} }`).resolved.objects.find((o) => o.kind === 'profile');
const findings = (rules, body) => { const r = resolveSource(SRC + rules + `\nprofile P { ${body} }`); return checkProfile(r.resolved, prof(body)).map((f) => f.message ?? JSON.stringify(f)).join('\n'); };

test('rule_features without rule_kinds', () => {
  assert.match(findings('rule W { kind = width; on = A; limit = exact; value = 5nm }', 'rule_features = []'), /limit_exact/);
});
test('rules on computed markers of routed layers are in scope', () => {
  assert.match(findings('rule W { kind = width; on = M; limit = exact; value = 5nm }', 'rule_kinds = [width]; rule_features = []'), /limit_exact/);
});
