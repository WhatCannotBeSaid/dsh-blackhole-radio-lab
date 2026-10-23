/**
 * Deterministic pseudo-randomness for the mock catalogue.
 *
 * Everything the catalogue generates — ids, names, category assignment and
 * (through the distribution module) the 3-D position of every node — must be
 * reproducible from one integer seed. A browser `Math.random()` would break
 * that contract: reopening the panel would reshuffle the whole sky.
 *
 * Each station draws from its own stream, keyed by (seed, index), so a station's
 * identity and position do not depend on how many stations were generated
 * before it. Raising the count only appends new stations; the existing ones keep
 * their names and their places.
 */

/** FNV-1a over the string forms of the arguments, as an unsigned 32-bit int. */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x3c6ef372;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and stable across engines. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stream owned by one station, independent of every other station. */
export function streamFor(seed, index, salt = 0) {
  return mulberry32(hash32(seed, index, salt));
}

/** Uniform pick; returns undefined for an empty list. */
export function pick(rng, list) {
  if (!list || list.length === 0) return undefined;
  return list[Math.floor(rng() * list.length) % list.length];
}

/** Two picks that must differ when the list allows it. */
export function pickTwo(rng, list) {
  const first = pick(rng, list);
  if (!list || list.length < 2) return [first, first];
  let second = pick(rng, list);
  for (let guard = 0; guard < 6 && second === first; guard += 1) second = pick(rng, list);
  return [first, second];
}

/** Roughly gaussian in [-1, 1] (sum of uniform draws); cheap and bounded. */
export function centered(rng) {
  return (rng() + rng() + rng() - 1.5) / 1.5;
}

/** Integer in [min, max]. */
export function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
