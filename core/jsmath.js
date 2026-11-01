// Math.max / Math.min over a list of any length (no argument-count limit):
// every value is coerced first, and NaN wins, as in Math.max(...xs).
export function maxOf(xs, init = -Infinity) { const ns = xs.map((x) => +x); return ns.some(Number.isNaN) ? NaN : ns.reduce((a, b) => (b > a ? b : a), init); }
export function minOf(xs, init = Infinity) { const ns = xs.map((x) => +x); return ns.some(Number.isNaN) ? NaN : ns.reduce((a, b) => (b < a ? b : a), init); }
