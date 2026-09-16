// Math utilities for the Wayang Kulit puppet simulator.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// 2D affine matrix stored as [a, b, c, d, tx, ty]:
//   x' = a*x + c*y + tx
//   y' = b*x + d*y + ty
export const Affine = {
  identity: () => [1, 0, 0, 1, 0, 0],

  translate: (x, y) => [1, 0, 0, 1, x, y],

  rotate(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [c, s, -s, c, 0, 0];
  },

  scale: (sx, sy = sx) => [sx, 0, 0, sy, 0, 0],

  mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  },

  chain(...matrices) {
    return matrices.reduce((acc, m) => Affine.mul(acc, m));
  },

  apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  },

  invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    const invDet = 1 / det;
    return [
      m[3] * invDet, -m[1] * invDet,
      -m[2] * invDet, m[0] * invDet,
      (m[2] * m[5] - m[3] * m[4]) * invDet,
      (m[1] * m[4] - m[0] * m[5]) * invDet,
    ];
  },
};

// Damped spring (semi-implicit Euler). zeta < 1 is under-damped (bouncy), 1 is critical.
export class Spring {
  constructor(x = 0, k = 100, zeta = 1) {
    this.x = x;
    this.v = 0;
    this.k = k;
    this.zeta = zeta;
  }

  step(target, dt) {
    const damping = 2 * this.zeta * Math.sqrt(this.k);
    this.v += (this.k * (target - this.x) - damping * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }

  stepAngle(target, dt) {
    const damping = 2 * this.zeta * Math.sqrt(this.k);
    this.v += (this.k * wrapAngle(target - this.x) - damping * this.v) * dt;
    this.x += this.v * dt;
    return this.x;
  }

  snap(x) {
    this.x = x;
    this.v = 0;
  }
}

// Pair of springs for 2D position tracking.
export class Spring2 {
  constructor(x, y, k, zeta) {
    this.sx = new Spring(x, k, zeta);
    this.sy = new Spring(y, k, zeta);
  }
  get x() { return this.sx.x; }
  get y() { return this.sy.x; }
  get vx() { return this.sx.v; }
  get vy() { return this.sy.v; }
  step(tx, ty, dt) {
    this.sx.step(tx, dt);
    this.sy.step(ty, dt);
  }
  snap(x, y) {
    this.sx.snap(x);
    this.sy.snap(y);
  }
}

// One Euro filter (Casiez et al. 2012) — adaptive low-pass that kills jitter
// at rest but stays responsive during fast movements.
export class OneEuro {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, dt) {
    if (this.x === null) {
      this.x = value;
      return value;
    }
    const derivative = (value - this.x) / dt;
    this.dx = lerp(this.dx, derivative, OneEuro.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x = lerp(this.x, value, OneEuro.alpha(cutoff, dt));
    return this.x;
  }
}

// Simple 1D value noise for flame flicker effects.
export function noise1(t) {
  const i = Math.floor(t);
  const f = t - i;
  const hash = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
}
