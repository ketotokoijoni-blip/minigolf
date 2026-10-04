// Seeded xorshift32 for tests and cosmetics (tile speckle) only. Never used by the sim: ESLint forbids importing
// this module from packages/shared/src/sim/** (DESIGN §9).

/** Returns a generator of doubles in [0, 1). Same seed -> same sequence; seed 0 is replaced by a fixed non-zero state. */
export function xorshift32(seed: number): () => number {
  let x = seed | 0;
  if (x === 0) x = 0x9e3779b9 | 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
