/**
 * A tiny seeded PRNG.
 *
 * §4 requires the pick for a date to come from a seed that is a hash of the
 * date string. Math.random cannot do that, and pulling in a dependency for
 * thirty lines of well-known bit twiddling would be silly.
 *
 * cyrb128 spreads a string into four 32-bit words; mulberry32 turns one of them
 * into a uniform stream. Both are public domain and widely used.
 */

export function cyrb128(input: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;

  for (let i = 0; i < input.length; i += 1) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }

  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);

  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The PRNG for a given date. Same date in, same stream out, forever. */
export function randomForSeed(seed: string): () => number {
  return mulberry32(cyrb128(seed)[0]);
}

/**
 * Picks one index with probability proportional to its weight.
 * Returns -1 if every weight is zero, which the caller should treat as a bug
 * rather than papering over.
 */
export function weightedPick(weights: number[], random: () => number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return -1;

  let threshold = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    threshold -= weights[i]!;
    if (threshold <= 0) return i;
  }
  return weights.length - 1;
}
