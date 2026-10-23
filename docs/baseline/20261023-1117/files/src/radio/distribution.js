/**
 * Stable 3-D placement for the catalogue, expressed in the accretion disk's own
 * cylindrical space.
 *
 * The layout has one job: the default field must read as a single continuous
 * disk of matter, not as eight category islands with a point per station. So
 * the sampling is category-agnostic — every station draws from the same field:
 *
 *   - a ring of seeded density knots, spread evenly around the ring (so the
 *     band never breaks) but uneven in radius and width, which gives the disk
 *     its natural bright/dim sectors;
 *   - a diffuse component filling the rest of the radius band with a mild
 *     inner concentration, plus a thickness that opens with radius.
 *
 * Category never enters that sampling. It only supplies the *second* target:
 * each station also gets a position inside one of its categories' cloud seeds,
 * which the renderer eases towards while a filter is active. Both targets live
 * in the same (radius, angle, height) space, so the transition is a morph
 * through the disk, never a teleport to an unrelated place.
 *
 * Positions are computed once, from per-station streams, and never rewritten:
 * filtering moves the presentation, the layout stays the source of truth.
 * Nothing here imports three.js.
 */

import { DISK_INNER, DISK_OUTER } from '../scene/dimensions.js';
import { centered, hash32, streamFor } from './random.js';
import { CATEGORIES } from './taxonomy.js';

export const REGION = Object.freeze({ DISK: 'disk', FEATURED: 'featured' });

const TAU = Math.PI * 2;
/** Radius band actually used; a hair inside the visible disk so nodes sit on it. */
const R_IN = DISK_INNER + 0.14;
/**
 * Outer edge of the station field. Deliberately inside the visible disk's outer
 * glow: the stations must sit ON the bright matter band, and the last stretch
 * of the disk should stay plain matter without station texture. A field that
 * reaches the outer rim reads as a separate ring of dots.
 */
const R_OUT = DISK_OUTER - 0.95;
/** Featured stations sit in the inner rim, just outside the photon ring. */
const FEATURED_INNER = DISK_INNER + 0.1;
const FEATURED_OUTER = DISK_INNER + 0.58;
const FEATURED_ARCS = 4;
const DISK_KNOTS = 11;
/** Share of stations drawn around a knot; the rest fill the diffuse disk. */
const KNOT_SHARE = 0.54;
const CLOUD_MIN_RADIUS = R_IN + 0.46;
const CLOUD_MAX_RADIUS = R_OUT - 0.35;

/** The radial band the field occupies; the renderer fades its edges with it. */
export const STATION_RADIUS = Object.freeze({ inner: R_IN, outer: R_OUT });

/**
 * Seeded density knots: the disk's own large-scale structure.
 *
 * Their angular centres are spread evenly around the ring with a jitter, so
 * there is no gap wide enough to read as a category boundary, while radius and
 * width stay irregular.
 */
function buildDiskKnots(seed) {
  const knots = [];
  for (let k = 0; k < DISK_KNOTS; k += 1) {
    const rng = streamFor(seed, k, 'disk-knot');
    knots.push({
      radius: R_IN + (R_OUT - R_IN) * (0.04 + 0.9 * Math.pow(rng(), 1.15)),
      angle: (k / DISK_KNOTS) * TAU + centered(rng) * 0.34,
      tangSigma: 0.16 + rng() * 0.3,
      radSigma: 0.07 + rng() * 0.13,
      weight: 0.6 + rng() * 0.8,
      cumulative: 0,
    });
  }
  let total = 0;
  for (const knot of knots) total += knot.weight;
  let running = 0;
  for (const knot of knots) {
    running += knot.weight / total;
    knot.cumulative = running;
  }
  return knots;
}

function sampleKnot(knots, u) {
  for (const knot of knots) {
    if (u <= knot.cumulative) return knot;
  }
  return knots[knots.length - 1];
}

/** Disk thickness: thin, and opening slightly with radius like a real disk. */
function thicknessAt(radius) {
  const t = clamp((radius - R_IN) / (R_OUT - R_IN), 0, 1);
  return 0.026 + 0.05 * t;
}

function sampleDisk(rng, knots) {
  if (rng() < KNOT_SHARE) {
    const knot = sampleKnot(knots, rng());
    const angle = knot.angle + centered(rng) * knot.tangSigma;
    const radius = clamp(knot.radius + centered(rng) * knot.radSigma, R_IN, R_OUT);
    return {
      radius,
      angle,
      height: centered(rng) * thicknessAt(radius) * 1.45,
    };
  }
  // Diffuse fill: a mild inner concentration, uniform angle, no category.
  const t = Math.pow(rng(), 1.35);
  const radius = R_IN + (R_OUT - R_IN) * t;
  return {
    radius,
    angle: rng() * TAU,
    height: centered(rng) * thicknessAt(radius),
  };
}

/** Four short bright arcs on the inner rim, where the featured stations live. */
function buildFeaturedArcs(seed) {
  const arcs = [];
  for (let a = 0; a < FEATURED_ARCS; a += 1) {
    const rng = streamFor(seed, a, 'featured-arc');
    arcs.push({
      angle: (a / FEATURED_ARCS) * TAU + 0.42 + centered(rng) * 0.24,
      radius: FEATURED_INNER + 0.04 + rng() * (FEATURED_OUTER - FEATURED_INNER - 0.04),
      tangSigma: 0.075 + rng() * 0.055,
      radSigma: 0.018 + rng() * 0.022,
    });
  }
  return arcs;
}

/**
 * Category cloud seeds: where a category reveals itself when it is filtered.
 *
 * Two or three clouds per category, placed on different sides of the ring at
 * different radii, so a single filter reads as several nebula patches inside
 * the disk rather than one blob. Radii stay inside the disk band: a cloud is a
 * denser region of the disk, never something floating outside it.
 */
export function buildCloudField(seed) {
  const field = new Map();
  CATEGORIES.forEach((category, index) => {
    const rng = streamFor(seed, index, 'cloud-field');
    const count = 2 + Math.floor(rng() * 2);
    const baseAngle = (index / CATEGORIES.length) * TAU + centered(rng) * 0.35;
    const baseRadius = CLOUD_MIN_RADIUS + rng() * (CLOUD_MAX_RADIUS - CLOUD_MIN_RADIUS) * 0.7;
    const clouds = [];
    for (let i = 0; i < count; i += 1) {
      const cloudRng = streamFor(seed, `${category.id}-${i}`, 'cloud');
      clouds.push({
        id: `${category.id}-${i}`,
        categoryId: category.id,
        angle: baseAngle + (i / count) * TAU + centered(cloudRng) * 0.3,
        radius: clamp(
          baseRadius + centered(cloudRng) * 0.55,
          CLOUD_MIN_RADIUS,
          CLOUD_MAX_RADIUS,
        ),
        tangSigma: 0.26 + cloudRng() * 0.26,
        radSigma: 0.12 + cloudRng() * 0.12,
        warpPhase: cloudRng() * TAU,
      });
    }
    field.set(category.id, clouds);
  });
  return field;
}

/** One station's place inside a cloud: irregular edge, soft radial falloff. */
function sampleCloud(cloud, rng) {
  // The cloud is deliberately wider than its seed: a filtered category has to
  // read as a soft nebula patch with a density gradient, not as a bright dot.
  const angle = cloud.angle + centered(rng) * cloud.tangSigma * 2.2;
  const d = angle - cloud.angle;
  // The boundary is not an ellipse: the radial extent breathes with angle.
  const edge = 1 + 0.42 * Math.sin(d * 5.2 + cloud.warpPhase) + 0.18 * Math.sin(d * 11.7 - cloud.warpPhase);
  const radius = clamp(
    cloud.radius + centered(rng) * cloud.radSigma * 1.7 * Math.max(0.45, edge),
    R_IN + 0.05,
    R_OUT - 0.05,
  );
  return { radius, angle, height: centered(rng) * (0.04 + 0.045 * thicknessAt(radius) * 20) };
}

/**
 * Assign every station its base position and its per-category cloud targets.
 *
 * @param stations - records from the catalogue generator.
 * @param seed - the same seed used for the catalogue.
 * @returns anchors (category centroids), the featured subset and the cloud field.
 */
export function assignPositions(stations, seed) {
  const knots = buildDiskKnots(seed);
  const arcs = buildFeaturedArcs(seed);
  const cloudField = buildCloudField(seed);

  const anchors = CATEGORIES.map((category) => ({
    id: category.id,
    count: 0,
    position: { x: 0, y: 0, z: 0 },
  }));
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const sums = new Map(anchors.map((anchor) => [anchor.id, { x: 0, y: 0, z: 0, n: 0 }]));
  const featured = [];

  for (const station of stations) {
    const index = station.metadata.index;
    const rng = streamFor(seed, index, 'layout');
    let layout;
    if (station.isFeatured) {
      const arc = arcs[hash32(seed, index, 'featured-arc') % arcs.length];
      const radius = clamp(arc.radius + centered(rng) * arc.radSigma, FEATURED_INNER, FEATURED_OUTER);
      layout = {
        radius,
        angle: arc.angle + centered(rng) * arc.tangSigma,
        height: centered(rng) * 0.026,
      };
      station.metadata.region = REGION.FEATURED;
      featured.push(station);
    } else {
      layout = sampleDisk(rng, knots);
      station.metadata.region = REGION.DISK;
    }

    station.position = {
      x: Math.cos(layout.angle) * layout.radius,
      y: layout.height,
      z: Math.sin(layout.angle) * layout.radius,
    };
    station.metadata.layout = layout;
    station.metadata.orbit = layout;

    // Cloud targets for every category this station carries, so a filter can
    // pull it without another random draw at interaction time.
    const clouds = [];
    for (const categoryId of station.categories || []) {
      const list = cloudField.get(categoryId);
      if (!list || list.length === 0) continue;
      const cloudRng = streamFor(seed, index, `cloud-${categoryId}`);
      const cloud = list[Math.floor(cloudRng() * list.length) % list.length];
      const point = sampleCloud(cloud, cloudRng);
      clouds.push({
        categoryId,
        cloudId: cloud.id,
        radius: point.radius,
        angle: point.angle,
        height: point.height,
      });
    }
    station.metadata.clouds = clouds;

    const feel = streamFor(seed, index, 'feel');
    station.metadata.filterDelay = feel() * 0.45;
    station.metadata.presence = 0.55 + feel() * 0.8;

    const anchor = anchorById.get(station.metadata.primaryCategory);
    if (anchor) {
      anchor.count += 1;
      const sum = sums.get(anchor.id);
      sum.x += station.position.x;
      sum.y += station.position.y;
      sum.z += station.position.z;
      sum.n += 1;
    }
  }

  for (const anchor of anchors) {
    const sum = sums.get(anchor.id);
    if (sum.n > 0) {
      anchor.position = { x: sum.x / sum.n, y: sum.y / sum.n, z: sum.z / sum.n };
    }
  }

  return { anchors, featured, clouds: cloudField };
}

/** Category centroids, kept for callers that only need the summary. */
export function buildAnchors(seed) {
  return CATEGORIES.map((category, index) => {
    const rng = streamFor(seed, index, 'anchor');
    const angle = (index / CATEGORIES.length) * TAU + centered(rng) * 0.2;
    const radius = CLOUD_MIN_RADIUS + rng() * (CLOUD_MAX_RADIUS - CLOUD_MIN_RADIUS);
    return {
      id: category.id,
      angle,
      radius,
      height: 0,
      position: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius },
    };
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
