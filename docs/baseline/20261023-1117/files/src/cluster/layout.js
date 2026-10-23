/**
 * The star-cluster layout (phase 4).
 *
 * A category's stations are re-placed in true 3-D around the origin: dense,
 * slightly warm core, a few soft filaments, and a long sparse halo that thins
 * out into black space. Nothing here touches the accretion-disk layout: the
 * disk coordinates stay in `station.metadata.layout`, this function only
 * produces a second, alternate destination the station layer can morph to and
 * from without losing the original.
 *
 * Determinism matters more than beauty here. The same (catalogue, category,
 * seed) always produces the same positions, so a station keeps the same place
 * in its cluster across mounts, and the layout can be measured offline.
 *
 * Distribution, for member i:
 *   u = hash(seed, category, salt, i)              // uniform [0,1)
 *   r = R * u^RADIAL_POWER                         // centre-dense, no empty hole
 *   dir = unit vector (anisotropic: y * FLATTEN)   // a volume, not a plane
 *   with probability CLUMP_SHARE the direction is pulled toward one of three
 *   seeded filament axes, which breaks the perfect sphere without forming a
 *   visible shell or ring.
 *   radius-dependent point weight: bright, larger core; faint, small halo.
 *
 * RADIAL_POWER > 1 means the radial density falls with radius (a singular
 * centre in volume density), which is exactly the look of a real cluster:
 * bright, unresolved middle and a sparse halo.
 */

import { hash32 } from '../radio/random.js';

/** Radial power: >1 concentrates matter toward the centre. */
const RADIAL_POWER = 1.9;
/** Three seeded filaments keep the halo irregular. */
const FILAMENTS = 3;
/** Share of stations pulled toward a filament axis. */
const CLUMP_SHARE = 0.46;
/** Pull strength: 0 = pure isotropic, 1 = all matter on the axes. */
const CLUMP_PULL = 0.62;
/** Vertical squash: clusters are usually a little flattened. */
const FLATTEN = 0.82;
/** Soft floor: no station sits exactly on the singularity. */
const CORE_FLOOR = 0.055;

/**
 * Build the cluster destination for one category.
 *
 * @param stations - the whole catalogue (plain records, stable ids).
 * @param options - { seed, categoryId, language? }
 * @returns {{
 *   categoryId: string, seed: number, count: number, radius: number,
 *   positions: Float32Array, members: Uint8Array, weights: Float32Array,
 *   camera: { radius: number, phi: number, theta: number },
 *   minRadius: number, maxRadius: number,
 * }}
 */
export function buildClusterLayout(stations, options) {
  const opts = options || {};
  const seed = Number(opts.seed) || 0;
  const categoryId = String(opts.categoryId || '');
  const count = Array.isArray(stations) ? stations.length : 0;

  const members = new Uint8Array(count);
  const memberIndex = new Int32Array(count).fill(-1);
  const memberIds = [];
  for (let i = 0; i < count; i += 1) {
    const station = stations[i];
    const categories = (station && station.categories) || [];
    if (categoryId && categories.indexOf(categoryId) >= 0) {
      memberIndex[i] = memberIds.length;
      memberIds.push(i);
      members[i] = 1;
    }
  }

  const n = memberIds.length;
  const radius = clusterRadius(n);
  const positions = new Float32Array(count * 3);
  const weights = new Float32Array(count);

  // Seeded filament axes: unit vectors with a preferred, non-vertical pitch so
  // the cluster never reads as three spokes in the picture plane.
  const axes = [];
  for (let f = 0; f < FILAMENTS; f += 1) {
    const a = (f / FILAMENTS) * Math.PI * 2 + (hash32(seed, categoryId, 'axis', f) % 1000) / 1000 * 0.9;
    const y = -0.42 + (hash32(seed, categoryId, 'pitch', f) % 1000) / 1000 * 0.84;
    const s = Math.sqrt(Math.max(0.05, 1 - y * y));
    axes.push({ x: Math.cos(a) * s, y, z: Math.sin(a) * s });
  }

  for (let m = 0; m < n; m += 1) {
    const index = memberIds[m];
    const u = (hash32(seed, categoryId, 'r', index) % 1000000) / 1000000;
    // Two independent angles on the sphere, seeded per station.
    const v = (hash32(seed, categoryId, 'v', index) % 1000000) / 1000000;
    const w = (hash32(seed, categoryId, 'w', index) % 1000000) / 1000000;

    const r = radius * Math.pow(Math.max(u, 0.0001), RADIAL_POWER);
    const phi = Math.acos(2 * v - 1);
    const theta = w * Math.PI * 2;
    let dx = Math.sin(phi) * Math.cos(theta);
    let dy = Math.cos(phi);
    let dz = Math.sin(phi) * Math.sin(theta);

    // Filament pull: blend the direction toward one seeded axis. The axis blend
    // is applied to the direction only, so the radial profile (density) is
    // preserved and the cluster still thins out at the same rate.
    if (hash32(seed, categoryId, 'clump', index) % 1000 / 1000 < CLUMP_SHARE) {
      const axis = axes[hash32(seed, categoryId, 'which', index) % FILAMENTS];
      dx += axis.x * CLUMP_PULL;
      dy += axis.y * CLUMP_PULL;
      dz += axis.z * CLUMP_PULL;
      const len = Math.max(1e-4, Math.hypot(dx, dy, dz));
      dx /= len;
      dy /= len;
      dz /= len;
    }

    // Per-station jitter, kept below the cluster's own structure so it reads as
    // natural scatter rather than noise.
    const jitter = radius * 0.045;
    const jx = ((hash32(seed, categoryId, 'jx', index) % 2000) / 1000 - 1) * jitter;
    const jy = ((hash32(seed, categoryId, 'jy', index) % 2000) / 1000 - 1) * jitter;
    const jz = ((hash32(seed, categoryId, 'jz', index) % 2000) / 1000 - 1) * jitter;

    const rr = Math.max(CORE_FLOOR * radius, r);
    positions[index * 3] = dx * rr + jx;
    positions[index * 3 + 1] = dy * rr * FLATTEN + jy;
    positions[index * 3 + 2] = dz * rr + jz;
    // 1 at the core, ~0.4 at the rim: drives point size and brightness.
    weights[index] = 0.42 + 0.58 * Math.pow(1 - Math.min(1, rr / radius), 1.15);
  }

  return {
    categoryId,
    seed,
    count: n,
    radius,
    positions,
    members,
    weights,
    camera: clusterCamera(radius),
    minRadius: Math.max(1.6, radius * 1.55),
    maxRadius: Math.min(44, Math.max(18, radius * 9)),
  };
}

/**
 * World radius of the cluster for `n` members.
 *
 * A real category has somewhere between ~150 and ~1,500 stations. The size
 * grows sub-linearly so the projected size stays in the 45–70% band while the
 * density still scales with the count: more stations make the cluster denser,
 * not just bigger.
 */
export function clusterRadius(n) {
  const members = Math.max(1, Number(n) || 0);
  return clamp(2.32 * Math.pow(members / 520, 0.34), 1.5, 4.6);
}

/**
 * Default camera framing for a cluster: far enough that the whole volume sits
 * inside the frame, with the projected diameter near 55–60% of the viewport
 * height and a mild off-axis angle so the 3-D extent is readable.
 */
export function clusterCamera(radius) {
  const r = Math.max(1, Number(radius) || 1);
  return {
    radius: r * 4.35,
    phi: 1.17,
    theta: 0.62,
  };
}

/** Offline measurement helper: projected diameter in CSS pixels. */
export function projectedDiameter(radius, cameraRadius, fovDegrees, viewportHeight) {
  const fov = ((Number(fovDegrees) || 42) * Math.PI) / 180;
  const visibleHeight = 2 * cameraRadius * Math.tan(fov / 2);
  return (2 * radius) / visibleHeight * viewportHeight;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
