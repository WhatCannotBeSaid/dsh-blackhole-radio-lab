/**
 * The nebula space layout.
 *
 * This module is pure: no three.js, no DOM, no radio data. It turns the genre
 * list the repository already computed into a deterministic arrangement of
 * volumes in three-dimensional polar space. Everything the renderer and the
 * camera need — centre, radius, anisotropy, brightness, the camera frame — is
 * decided here so the same seed and the same genre ids always produce the same
 * sky, and so the renderer never has to re-derive classification.
 *
 * Two properties matter more than the exact numbers below:
 *
 * 1. Stability. Every direction comes from a fixed vocabulary slot, not from
 *    the order the API happened to return. A genre leaving the sample nudges
 *    its neighbours at most a little; it does not renumber the sky.
 * 2. Bounded size. Station counts span two orders of magnitude, so radius uses
 *    a log mapping with a floor. The smallest genre stays recognisable and the
 *    largest cannot swallow the space around it.
 */

import { hash32, mulberry32 } from '../radio/random.js';

/** Visual radius of the least populated visible genre, in world units. */
export const NEBULA_MIN_RADIUS = 3.1;
/** Visual radius of the most populated visible genre, in world units. */
export const NEBULA_MAX_RADIUS = 7.4;
/** Inner and outer radius of the sphere shell the genre centres sit in. */
export const NEBULA_SHELL_INNER = 19;
export const NEBULA_SHELL_OUTER = 31;
/** Soft clearance kept between two neighbouring volumes, in world units. */
export const NEBULA_MIN_GAP = 2.2;
/** Hard floor for camera framing, independent of how sparse the sky is. */
const MIN_EXTENT = 14;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const VOCABULARY_SIZE = 13;

/**
 * Directions for a fixed fifteen-slot vocabulary laid out on a Fibonacci
 * sphere and flattened along Y. Flattening keeps every volume inside a camera
 * that looks at the origin from a shallow elevation; a full sphere would put
 * two genres almost directly above and below the frame.
 */
const SLOTS = buildSlots();

function buildSlots() {
  const out = [];
  for (let i = 0; i < VOCABULARY_SIZE; i += 1) {
    const y = 1 - ((i + 0.5) * 2) / VOCABULARY_SIZE;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * GOLDEN_ANGLE;
    out.push({ x: Math.cos(phi) * ring, y: y * 0.62, z: Math.sin(phi) * ring });
  }
  return out;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value) {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Log-normalised population, 0 for an empty genre and 1 for the fullest.
 *
 * The denominator has a floor: when every visible genre carries the same small
 * count, "the fullest" is not a meaningful reference and would hand every
 * volume the maximum radius. The floor keeps a sparse sky sparse.
 */
const POPULATION_FLOOR = 24;

function populationScale(count, maxCount) {
  const top = Math.log1p(Math.max(POPULATION_FLOOR, maxCount));
  return top > 0 ? clamp01(Math.log1p(Math.max(0, count)) / top) : 0;
}

/**
 * Radius for a genre. The floor is 18% of the usable range so a genre with one
 * station is still a readable nebula, and the exponent compresses the middle of
 * the distribution instead of letting the top two genres dominate.
 */
export function nebulaRadiusForCount(count, maxCount) {
  const t = 0.18 + 0.82 * Math.pow(populationScale(count, maxCount), 1.25);
  return NEBULA_MIN_RADIUS + (NEBULA_MAX_RADIUS - NEBULA_MIN_RADIUS) * t;
}

/** Relative emission strength; part of the visual identity, still bounded. */
export function nebulaBrightnessForCount(count, maxCount) {
  return 0.62 + 0.38 * populationScale(count, maxCount);
}

function parseColor(value) {
  if (Array.isArray(value) && value.length >= 3) {
    return [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])];
  }
  const hex = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(hex)) return [0.62, 0.66, 0.72];
  return [
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  ];
}

function normalizeVocabulary(vocabulary) {
  const index = new Map();
  const out = [];
  for (const id of Array.isArray(vocabulary) ? vocabulary : []) {
    if (typeof id === 'string' && id && !index.has(id)) {
      index.set(id, out.length);
      out.push(id);
    }
  }
  // Any genre outside the declared vocabulary still gets a slot, derived from
  // its id rather than its position, so the ordering stays input-independent.
  return { ids: out, index };
}

/**
 * Merge duplicates defensively: the caller may hand over a list that was built
 * from two sources. Summation keeps a single volume per genre without guessing
 * which entry was authoritative.
 */
function normalizeEntries(genres) {
  const byId = new Map();
  const order = [];
  for (const entry of Array.isArray(genres) ? genres : []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    const count = Number(entry.count);
    const safe = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    const previous = byId.get(entry.id);
    if (previous) {
      previous.count += safe;
    } else {
      byId.set(entry.id, { ...entry, count: safe });
      order.push(entry.id);
    }
  }
  return { entries: byId, ids: order };
}

/** Stable rank: declared vocabulary first, then a hash-derived tail. */
function rankOf(id, vocabulary) {
  const slot = vocabulary.index.get(id);
  return slot === undefined ? 1000 + (hash32(id) % 1000) : slot;
}

function slotDirection(id, vocabulary, rng) {
  const slot = vocabulary.index.get(id);
  const base = slot === undefined
    ? SLOTS[hash32(id) % SLOTS.length]
    : SLOTS[slot % SLOTS.length];
  // A little deterministic drift so the pattern does not read as a lattice.
  const jitter = 0.2;
  const x = base.x + (rng() * 2 - 1) * jitter;
  const y = base.y + (rng() * 2 - 1) * jitter * 0.7;
  const z = base.z + (rng() * 2 - 1) * jitter;
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

function buildShape(id, seed) {
  const rng = mulberry32(hash32(seed, 'nebula-shape', id));
  const stretch = [0.74 + rng() * 0.62, 0.74 + rng() * 0.62, 0.74 + rng() * 0.62];
  const longest = Math.max(...stretch);
  return {
    // Anisotropy normalised to the longest axis: rotation only reshapes.
    stretch: stretch.map((value) => value / longest),
    lobes: 2 + Math.floor(rng() * 2),
    lobeSpread: 0.58 + rng() * 0.34,
    phase: rng() * Math.PI * 2,
    warp: 0.24 + rng() * 0.16,
    hollow: 0.34 + rng() * 0.3,
    spin: (rng() * 2 - 1) * 0.6,
    // Applied to the local offsets: without it every volume would stretch along
    // the same world axes and the sky would look combed.
    tilt: { x: rng() * Math.PI * 2, y: rng() * Math.PI * 2, z: rng() * Math.PI * 2 },
  };
}

/**
 * Plan the nebula sky.
 *
 * @param {Array<{id:string,count:number,color?:number|number[]}>} genres
 * @param {{seed?:number, vocabulary?:string[]}} [options]
 */
export function buildNebulaLayout(genres, options = {}) {
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : 0;
  const vocabulary = normalizeVocabulary(options.vocabulary, genres);
  const { entries, ids } = normalizeEntries(genres);

  // A genre with nothing in it earns no volume. The repository already filters
  // those, but the layout must not depend on its caller having done so: an
  // empty genre would otherwise render as a bare dust speck.
  const ordered = ids
    .filter((id) => entries.get(id).count > 0)
    .sort((a, b) => rankOf(a, vocabulary) - rankOf(b, vocabulary) || (a < b ? -1 : a > b ? 1 : 0));

  const maxCount = ordered.reduce(
    (top, id) => Math.max(top, entries.get(id).count),
    0,
  );

  const volumes = ordered.map((id) => {
    const entry = entries.get(id);
    const rng = mulberry32(hash32(seed, 'nebula-slot', id));
    const direction = slotDirection(id, vocabulary, rng);
    const shell = lerp(NEBULA_SHELL_INNER, NEBULA_SHELL_OUTER, rng());
    const radius = nebulaRadiusForCount(entry.count, Math.max(1, maxCount));
    return {
      id,
      index: 0,
      count: entry.count,
      color: parseColor(entry.color),
      radius,
      brightness: nebulaBrightnessForCount(entry.count, Math.max(1, maxCount)),
      center: {
        x: direction.x * shell,
        y: direction.y * shell,
        z: direction.z * shell,
      },
      shape: buildShape(id, seed),
    };
  });

  const maxShift = separateVolumes(volumes);

  volumes.forEach((volume, index) => {
    volume.index = index;
  });

  const extent = volumes.reduce(
    (top, volume) => Math.max(top, Math.hypot(volume.center.x, volume.center.y, volume.center.z) + volume.radius * 1.3),
    0,
  ) || MIN_EXTENT;

  // A shallow elevation with a small azimuth offset: the shell reads as a
  // volume, not as a card, and no slot sits exactly on the view axis.
  const camera = {
    radius: clamp(extent * 1.9, 62, 186),
    phi: 1.16,
    theta: 0.52,
    target: { x: 0, y: 0, z: 0 },
  };
  // The camera never enters the shell: the nearest allowed distance clears the
  // outermost volume with room to spare, which is what keeps the view from
  // ending up inside a dust cloud when the wheel is spun all the way in.
  const limits = {
    minRadius: Math.max(24, extent * 1.05),
    maxRadius: Math.min(300, extent * 3.0),
  };

  return {
    seed,
    count: volumes.length,
    genres: volumes,
    extent,
    camera: { ...camera, ...limits },
    maxShift,
    signature: signatureOf(seed, volumes),
  };
}

/**
 * Push overlapping volumes apart without changing their identity: the same
 * deltas are applied on both sides and the result is symmetric, so reversing
 * the input order cannot change the sky.
 */
function separateVolumes(volumes) {
  let maxShift = 0;
  if (volumes.length < 2) return maxShift;

  const startX = volumes.map((volume) => volume.center.x);
  const startY = volumes.map((volume) => volume.center.y);
  const startZ = volumes.map((volume) => volume.center.z);

  for (let pass = 0; pass < 16; pass += 1) {
    let moved = false;
    for (let i = 0; i < volumes.length; i += 1) {
      for (let j = i + 1; j < volumes.length; j += 1) {
        const a = volumes[i];
        const b = volumes[j];
        const want = (a.radius + b.radius) * 0.82 + NEBULA_MIN_GAP;
        let dx = b.center.x - a.center.x;
        let dy = b.center.y - a.center.y;
        let dz = b.center.z - a.center.z;
        let distance = Math.hypot(dx, dy, dz);
        if (distance >= want) continue;
        if (distance < 1e-6) {
          // Degenerate case: a deterministic axis keeps the push reproducible.
          dx = 1;
          dy = 0.31;
          dz = 0.17;
          distance = Math.hypot(dx, dy, dz);
        }
        const push = (want - distance) * 0.5;
        const ux = (dx / distance) * push;
        const uy = (dy / distance) * push;
        const uz = (dz / distance) * push;
        a.center.x -= ux;
        a.center.y -= uy;
        a.center.z -= uz;
        b.center.x += ux;
        b.center.y += uy;
        b.center.z += uz;
        moved = true;
      }
    }
    if (!moved) break;
  }

  volumes.forEach((volume, index) => {
    maxShift = Math.max(
      maxShift,
      Math.hypot(
        volume.center.x - startX[index],
        volume.center.y - startY[index],
        volume.center.z - startZ[index],
      ),
    );
  });
  return maxShift;
}

function signatureOf(seed, volumes) {
  const parts = volumes.map((volume) => [
    volume.id,
    volume.center.x.toFixed(3),
    volume.center.y.toFixed(3),
    volume.center.z.toFixed(3),
    volume.radius.toFixed(3),
  ].join(':'));
  return hash32(seed, 'nebula-layout', parts.join('|')).toString(16);
}

/**
 * The camera distance that fits the whole shell in this box.
 *
 * The layout authors a distance for a landscape frame. A narrow window (a docked
 * sidebar, a portrait canvas) needs more distance for the same content, so the
 * stage asks for this instead of scaling the layout's number by an aspect.
 */
export function nebulaFramingRadius(extent, width, height, fovDegrees) {
  const value = Math.max(1, Number(extent) || 1);
  const aspect = Math.max(0.5, (Number(width) || 1) / Math.max(1, Number(height) || 1));
  const half = ((Number(fovDegrees) || 42) * Math.PI) / 360;
  const tan = Math.max(0.05, Math.tan(half));
  const vertical = (value * 0.8) / tan;
  const horizontal = (value * 0.98) / (tan * aspect);
  // Never past the camera rig's ceiling: the whole point of the bound is that
  // the eye cannot be pushed so far out that the volumes turn to dust.
  return Math.min(300, Math.max(vertical, horizontal, value * 1.9));
}

/** World-space distance between two volumes' surfaces, negative when overlapping. */
export function surfaceGap(a, b) {
  const distance = Math.hypot(
    b.center.x - a.center.x,
    b.center.y - a.center.y,
    b.center.z - a.center.z,
  );
  return distance - (a.radius + b.radius);
}

export default buildNebulaLayout;
