// Exact rational numbers on BigInt (SPEC.md section 3.3: arithmetic is exact).

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Q {
  constructor(n, d = 1n) {
    if (d === 0n) throw new RangeError('division by zero');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n < 0n ? -n : n, d);
    this.n = n / g;
    this.d = d / g;
  }

  static int(i) { return new Q(BigInt(i)); }

  // Exact parse of a decimal literal such as "0.045".
  static decimal(text) {
    const [whole, frac = ''] = text.split('.');
    return new Q(BigInt(whole + frac), 10n ** BigInt(frac.length));
  }

  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) { return new Q(this.n * o.d, this.d * o.n); }
  neg() { return new Q(-this.n, this.d); }
  cmp(o) { const x = this.n * o.d - o.n * this.d; return x < 0n ? -1 : x > 0n ? 1 : 0; }
  eq(o) { return this.n === o.n && this.d === o.d; }
  isZero() { return this.n === 0n; }
  isInt() { return this.d === 1n; }

  floor() {
    const q = this.n / this.d;
    return new Q(this.n < 0n && q * this.d !== this.n ? q - 1n : q);
  }
  ceil() { return this.neg().floor().neg(); }
  // Round half away from zero.
  round() {
    const twice = new Q(this.n * 2n + (this.n < 0n ? -this.d : this.d), this.d * 2n);
    return this.n < 0n ? twice.ceil() : twice.floor();
  }

  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return this.isInt() ? `${this.n}` : `${this.n}/${this.d}`; }
}

export const ZERO = Q.int(0);
export const ONE = Q.int(1);
