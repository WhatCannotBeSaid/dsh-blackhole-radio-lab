/**
 * The star-cluster field (phase 4).
 *
 * The disk is a flat accretion plane of every station. One level in, the
 * catalogue breaks into its categories: a *field of clusters* hanging in a
 * shell of space, one knot per category, each knot the real point cloud of the
 * stations that belong to it.
 *
 * Two properties matter more than the exact numbers:
 *
 * 1. A category always sits in the same direction. Slots come from a fixed
 *    vocabulary index (the genre list order), never from how many stations the
 *    category happens to hold, so a sparse category does not get renumbered
 *    when its neighbours grow.
 * 2. A station belongs to exactly one knot. Multiple categories are common in
 *    the data; the field uses the station's primary category so the point cloud
 *    stays a partition rather than a set of duplicates.
 *
 * Determinism: the same (catalogue, seed) always produces the same field, which
 * lets the layout be measured offline and keeps a station in the same place
 * across mounts.
 */

import { hash32 } from '../radio/random.js';
import { formOf, sampleForm } from './forms.js';

/** Radial power: >1 concentrates matter toward a knot's centre. */
const RADIAL_POWER = 1.9;
/** Seeded filaments keep a knot irregular instead of a perfect ball. */
const FILAMENTS = 3;
/** Share of stations pulled toward a filament axis. */
const CLUMP_SHARE = 0.46;
/** Pull strength: 0 = pure isotropic, 1 = all matter on the axes. */
const CLUMP_PULL = 0.62;
/** Vertical squash of a knot: clusters are usually a little flattened. */
const FLATTEN = 0.82;
/** Shell vertical squash: keeps the shell from growing poles. */
const SHELL_FLATTEN = 0.86;
/** Soft floor: no station sits exactly on a knot's singularity. */
const CORE_FLOOR = 0.055;
/** Golden angle, for the Fibonacci shell. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Base shell radius in world units; grown only if a knot would not fit. */
const SHELL_BASE = 3.05;
/** Target fraction of a knot pair's radii that must sit between two knots. */
const SHELL_CLEARANCE = 0.82;
/** Extra elbow room between two neighbouring knots, in world units. */
const SHELL_GAP = 0.36;
/** Angular spacing of a Fibonacci shell of this many slots, in radians. */
const SHELL_SPACING = 0.94;

/**
 * The genre a station is filed under in the sky.
 *
 * This is the only rule the constellation page uses, and it reads the genre the
 * classification layer already stamped rather than re-deriving one: `genre`
 * first, then the `genres` list, then the legacy metadata fields. A record with
 * nothing at all belongs to Other, which is a real body in the sky and not a
 * dumping ground.
 */
export function primaryGenreOf(station) {
  if (!station) return 'other';
  if (typeof station.genre === 'string' && station.genre) return station.genre;
  const genres = station.genres;
  if (Array.isArray(genres) && genres.length) {
    if (typeof genres[0] === 'string') return genres[0];
    if (genres[0] && typeof genres[0].id === 'string') return genres[0].id;
  }
  const meta = station.metadata;
  if (meta) {
    if (typeof meta.genreId === 'string' && meta.genreId) return meta.genreId;
    if (typeof meta.genre === 'string' && meta.genre) return meta.genre;
  }
  return 'other';
}

/**
 * The category a station is filed under in the cluster field.
 *
 * The renderer and the stage both need this same answer, so it lives here
 * rather than being re-derived in three places.
 */
export function primaryCategoryOf(station) {
  if (!station) return '';
  const primary = station.metadata && station.metadata.primaryCategory;
  if (primary) return String(primary);
  const categories = station.categories;
  if (Array.isArray(categories) && categories.length) return String(categories[0]);
  return '';
}

/**
 * Build the cluster field for a whole catalogue.
 *
 * @param stations - the whole catalogue (plain records, stable ids).
 * @param options - { seed, vocabulary?: string[], language? }
 * @returns {{
 *   seed: number, count: number, radius: number,
 *   positions: Float32Array, members: Uint8Array, weights: Float32Array,
 *   groups: Array<{ id, index, count, radius, center, positions }>,
 *   camera: { radius, phi, theta }, minRadius: number, maxRadius: number,
 * }}
 */
export function buildClusterLayout(stations, options) {
  const opts = options || {};
  const seed = Number(opts.seed) || 0;
  const list = Array.isArray(stations) ? stations : [];
  const count = list.length;

  const vocabulary = normalizeVocabulary(opts.vocabulary, list);
  const slotOf = new Map();
  vocabulary.forEach((id, index) => slotOf.set(id, index));

  // Pass 1: partition the catalogue by its primary key. `byGenre` switches the
  // key from the legacy eight categories to the thirteen genres, which is what
  // the constellation page groups by.
  const ownerOf = opts.byGenre ? primaryGenreOf : primaryCategoryOf;
  const memberIndex = new Map();
  const buckets = vocabulary.map(() => []);
  const members = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const id = ownerOf(list[i]);
    const slot = slotOf.get(id);
    if (slot === undefined) continue;
    memberIndex.set(i, slot);
    buckets[slot].push(i);
    members[i] = 1;
  }

  // Pass 2: one knot per slot. Empty slots keep their direction but no matter.
  const groups = vocabulary.map((id, index) => {
    const membersOf = buckets[index];
    const radius = membersOf.length ? clusterRadius(membersOf.length) : 0;
    const direction = shellDirection(index, vocabulary.length);
    return {
      id,
      index,
      count: membersOf.length,
      radius,
      direction,
      center: { x: 0, y: 0, z: 0 },
      stations: membersOf,
      // A real object's shape for the constellation page; null keeps the old
      // generic knot for every other consumer of this layout.
      form: opts.forms ? formOf(id) : null,
    };
  });

  const maxRadius = groups.reduce((top, group) => Math.max(top, group.radius), 0);
  const shell = Math.max(
    SHELL_BASE,
    (maxRadius * 2 * SHELL_CLEARANCE + SHELL_GAP) / SHELL_SPACING,
  );
  for (const group of groups) {
    group.center = {
      x: group.direction.x * shell,
      y: group.direction.y * shell,
      z: group.direction.z * shell,
    };
  }

  // Pass 3: place each station inside its own knot.
  const { positions, weights } = scatterStations(count, groups, seed);

  const extent = shell + maxRadius;

  return {
    seed,
    count,
    radius: extent,
    positions,
    members,
    weights,
    groups,
    camera: clusterCamera(extent),
    minRadius: Math.max(1.6, extent * 1.12),
    maxRadius: Math.max(18, extent * 4.2),
  };
}

/**
 * Place each group's stations inside that group's own sphere.
 *
 * The shape is the old single-cluster look, unchanged: a dense core with three
 * seeded filaments and a sparse halo, so a knot reads as matter and not as a
 * ball of noise. Only the centre and the radius come from the caller, which is
 * what lets the same curve serve a category knot and a tag volume.
 *
 * @param count - total stations in the catalogue.
 * @param groups - [{ id, center: {x,y,z}, radius, stations: number[] }].
 * @param seed - catalogue seed.
 */
export function scatterStations(count, groups, seed) {
  const positions = new Float32Array(count * 3);
  const weights = new Float32Array(count);

  for (const group of Array.isArray(groups) ? groups : []) {
    const radius = Number(group && group.radius) || 0;
    const stationsOf = (group && group.stations) || [];
    if (!(radius > 0) || !stationsOf.length) continue;
    const centers = group.center || { x: 0, y: 0, z: 0 };

    // Seeded filament axes: unit vectors with a preferred, non-vertical pitch so
    // a knot never reads as three spokes in the picture plane.
    const axes = [];
    for (let f = 0; f < FILAMENTS; f += 1) {
      const a =
        (f / FILAMENTS) * Math.PI * 2 +
        (hash32(seed, group.id, 'axis', f) % 1000) / 1000 * 0.9;
      const y = -0.42 + (hash32(seed, group.id, 'pitch', f) % 1000) / 1000 * 0.84;
      const s = Math.sqrt(Math.max(0.05, 1 - y * y));
      axes.push({ x: Math.cos(a) * s, y, z: Math.sin(a) * s });
    }

    const form = group.form || null;
    for (const index of stationsOf) {
      let ox = 0;
      let oy = 0;
      let oz = 0;
      let weight = 0;

      if (form) {
        // A real object's own shape. The form already carries its own flattening
        // (a disk is thin, an elliptical is squashed) and its own brightness
        // ladder, so the generic knot's clamp below is not applied twice.
        const rand = (k) => (hash32(seed, group.id, 'form', index, k) % 1000000) / 1000000;
        const point = sampleForm(form, rand);
        ox = point.x * radius;
        oy = point.y * radius;
        oz = point.z * radius;
        weight = Math.max(0.3, Math.min(1.45, Number(point.w) || 0.7));
      } else {
        const u = (hash32(seed, group.id, 'r', index) % 1000000) / 1000000;
        const v = (hash32(seed, group.id, 'v', index) % 1000000) / 1000000;
        const w = (hash32(seed, group.id, 'w', index) % 1000000) / 1000000;

        const r = radius * Math.pow(Math.max(u, 0.0001), RADIAL_POWER);
        const phi = Math.acos(2 * v - 1);
        const theta = w * Math.PI * 2;
        let dx = Math.sin(phi) * Math.cos(theta);
        let dy = Math.cos(phi);
        let dz = Math.sin(phi) * Math.sin(theta);

        if ((hash32(seed, group.id, 'clump', index) % 1000) / 1000 < CLUMP_SHARE) {
          const axis = axes[hash32(seed, group.id, 'which', index) % FILAMENTS];
          dx += axis.x * CLUMP_PULL;
          dy += axis.y * CLUMP_PULL;
          dz += axis.z * CLUMP_PULL;
          const len = Math.max(1e-4, Math.hypot(dx, dy, dz));
          dx /= len;
          dy /= len;
          dz /= len;
        }

        const rr = Math.max(CORE_FLOOR * radius, r);
        ox = dx * rr;
        oy = dy * rr * FLATTEN;
        oz = dz * rr;
        // 1 at the core, ~0.4 at the rim: drives point size and brightness.
        weight = 0.42 + 0.58 * Math.pow(1 - Math.min(1, rr / radius), 1.15);
      }

      // Per-station jitter, kept below the object's own structure so it reads as
      // natural scatter rather than noise.
      const jitter = radius * 0.038;
      const jx = ((hash32(seed, group.id, 'jx', index) % 2000) / 1000 - 1) * jitter;
      const jy = ((hash32(seed, group.id, 'jy', index) % 2000) / 1000 - 1) * jitter;
      const jz = ((hash32(seed, group.id, 'jz', index) % 2000) / 1000 - 1) * jitter;

      positions[index * 3] = centers.x + ox + jx;
      positions[index * 3 + 1] = centers.y + oy + jy;
      positions[index * 3 + 2] = centers.z + oz + jz;
      weights[index] = weight;
    }
  }

  return { positions, weights };
}

/** Radius of one knot for `n` member stations. */
export function clusterRadius(n) {
  const members = Math.max(1, Number(n) || 0);
  // A knot has to read as a cloud of stations, not as a bright pixel: at 0.62
  // the whole field looked like dust on a lens, so the same curve runs at a
  // larger scale and the shell grows with it.
  return clamp(1.5 * Math.pow(members / 520, 0.34), 0.5, 2.2);
}

/**
 * Default camera framing for the field: outside the shell, 15 degrees above the
 * plane so the whole arrangement sits in frame with margin while the depth of
 * the knots still reads.
 *
 * 3.9x the extent puts the projected diameter near two thirds of the viewport
 * height at the stage's 42 degree field of view.
 */
export function clusterCamera(radius) {
  const r = Math.max(1, Number(radius) || 1);
  return {
    radius: r * 3.9,
    phi: 1.3090,
    theta: 0.52,
  };
}

/** Direction of vocabulary slot `index` on the Fibonacci shell. */
export function shellDirection(index, total) {
  const n = Math.max(1, Number(total) || 1);
  const i = Math.max(0, Math.min(n - 1, Math.round(Number(index) || 0)));
  const y = 1 - ((i + 0.5) * 2) / n;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN_ANGLE;
  return {
    x: Math.cos(phi) * ring,
    y: y * SHELL_FLATTEN,
    z: Math.sin(phi) * ring,
  };
}

/**
 * Nearest knot under a ray, for the stage's hover and click.
 *
 * The hit radius is the larger of the knot's visual radius and a floor that
 * keeps a sparse, distant knot clickable: a tiny knot four units out is one or
 * two pixels wide, which is not a target.
 *
 * @param layout - as returned by buildClusterLayout.
 * @param origin - { x, y, z } ray origin (the camera).
 * @param direction - { x, y, z } unit ray direction.
 * @param minScreenRadius - world radius equivalent of the hit floor.
 */
export function pickGroup(layout, origin, direction, minScreenRadius = 0) {
  const groups = (layout && layout.groups) || [];
  let best = null;
  let bestT = Infinity;
  for (const group of groups) {
    if (!group.count) continue;
    const hit = raySphere(origin, direction, group.center, Math.max(group.radius, minScreenRadius));
    if (hit === null || hit >= bestT) continue;
    bestT = hit;
    best = group;
  }
  return best;
}

/** Distance along the ray to the first surface hit, or null. */
function raySphere(origin, direction, center, radius) {
  if (!origin || !direction || !center || !(radius > 0)) return null;
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const near = -b - root;
  if (near >= 0) return near;
  const far = -b + root;
  return far >= 0 ? far : null;
}

/** Offline measurement helper: projected diameter in CSS pixels. */
export function projectedDiameter(radius, cameraRadius, fovDegrees, viewportHeight) {
  const fov = ((Number(fovDegrees) || 42) * Math.PI) / 180;
  const visibleHeight = 2 * cameraRadius * Math.tan(fov / 2);
  return (2 * radius) / visibleHeight * viewportHeight;
}

function normalizeVocabulary(vocabulary, stations) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(vocabulary) ? vocabulary : []) {
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  // No declared vocabulary: derive one from the catalogue so the field still
  // has stable slots for every category it finds.
  if (!out.length) {
    for (const station of stations) {
      const id = primaryCategoryOf(station);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    out.sort();
  }
  return out;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
