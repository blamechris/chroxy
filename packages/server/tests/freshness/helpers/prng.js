/**
 * A small seeded PRNG (mulberry32) for generated-sequence tests. Same seed,
 * same sequence, on every machine.
 */

export function mulberry32(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int(lo, hi) {
      return lo + Math.floor(next() * (hi - lo + 1))
    },
    pick(list) {
      return list[Math.floor(next() * list.length)]
    },
    chance(p) {
      return next() < p
    },
    weighted(entries) {
      let total = 0
      for (const [, w] of entries) total += w
      let r = next() * total
      for (const [v, w] of entries) {
        r -= w
        if (r < 0) return v
      }
      return entries[entries.length - 1][0]
    },
  }
}
