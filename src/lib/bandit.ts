// Thompson sampling over message variants. Small samples shift traffic toward winners quickly
// without abandoning the others.

export type Arm = { id: string; wins: number; trials: number };

function gamma(k: number, rand: () => number): number {
  if (k < 1) return gamma(k + 1, rand) * Math.pow(rand(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      const u1 = rand(), u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

const beta = (a: number, b: number, rand: () => number) => {
  const x = gamma(a, rand);
  return x / (x + gamma(b, rand));
};

export function pickArm(arms: Arm[], rand: () => number = Math.random): string {
  let best = arms[0].id;
  let top = -1;
  for (const a of arms) {
    const s = beta(1 + a.wins, 1 + a.trials - a.wins, rand);
    if (s > top) {
      top = s;
      best = a.id;
    }
  }
  return best;
}

export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
