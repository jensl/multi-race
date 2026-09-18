/**
 * A seeded PRNG, so a game's problems are reproducible from a single number.
 *
 * `Math.random` would make the round loop untestable: a test could assert that
 * *a* problem was posed, but never that the same problem was posed to every
 * player, or that a given seed yields a given game. That determinism is the
 * whole reason this module exists.
 */
export type Rng = () => number

/**
 * mulberry32. Small, fast, and good enough for arithmetic practice -- this is
 * not cryptography, and the seed is not a secret.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An integer in [min, max], inclusive at both ends. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** A production seed. Only ever used when a game is not being driven by a test. */
export function randomSeed(): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] ?? 1
}
