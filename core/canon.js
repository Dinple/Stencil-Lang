// Canonical bytes and hash of a resolved description (SPEC.md section 5).
// The resolved form only holds integers, strings, booleans, null, arrays and
// objects, so JCS (RFC 8785) reduces to sorted keys + JSON.stringify scalars.
// Source locations and the invalid flag are not content and are left out.

const NOT_CONTENT = new Set(['src', 'attr_src', 'invalid', 'hash']);

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => !NOT_CONTENT.has(k) && v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export async function hashResolved(resolved) {
  const bytes = new TextEncoder().encode(canonical(resolved));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
