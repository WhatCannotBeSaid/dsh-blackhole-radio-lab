/**
 * Station density field.
 *
 * The black hole panel does not draw stations as sprites. It bakes every
 * station into one polar raster that covers the disc annulus, and the disc's
 * own shader samples that raster at the point where each pixel's ray crosses
 * the disc plane. The stations therefore ARE the disc: their density raises
 * the emission, their spread gives it its turbulence, and they are carried
 * around by the same Keplerian shear that carries the procedural detail.
 *
 * Coordinates. The raster's x axis is the azimuth (0..2pi, wrapping) and its
 * y axis is the radius (DISC_INNER..DISC_OUTER). A station lands at the same
 * place the sprite layer used to put it: the cylindrical anchor of its
 * layout. The shader undoes the disc's own rotation before sampling, so a
 * station stays with its parcel of gas as the disc turns.
 *
 * Channels.
 *   R  density, local station mass per texel
 *   G  concentration, how much one station dominates that texel (0 = a
 *      crowded knot, 1 = a lone station), used to keep sparse stations from
 *      looking identical to dense bands
 *   B  state bits: 1 favourite, 2 playing
 *   A  coverage
 * and a parallel R32F raster carries the station index that owns each texel,
 * which is what a click reads back.
 */

import { DISK_INNER, DISK_OUTER } from './dimensions.js';

const TAU = Math.PI * 2;

/** Azimuth resolution. The disc is ~2.4x wider than it is deep, so match that. */
export const FIELD_WIDTH = 2048;

/** Radial resolution. 512 rows across 9 Rs is ~0.018 Rs per texel. */
export const FIELD_HEIGHT = 512;

/** Gaussian sigma of one station's footprint, in texels. */
const CORE_SIGMA = 1.15;

/** How far the footprint reaches, in texels. Three sigma covers 99.7%. */
const CORE_REACH = 3;

/** Density at which a texel is considered full (the curve saturates there). */
const SATURATION = 2.4;

/** Half-width of the saturating curve, so density maps to 0..1 smoothly. */
const DENSITY_KNEE = 0.55;

/** Whether one station should read as a favourite right now. */
function isMarkedFavourite(station, isFavourite, favouriteSet) {
  if (!station) return false;
  if (isFavourite) {
    try {
      return Boolean(isFavourite(station));
    } catch {
      return false;
    }
  }
  return favouriteSet.has(String(station.id));
}

/**
 * Per-station favourite / playing state, resolved once so the finalise loop can
 * work with flat arrays instead of calling back into the store per texel.
 */
function resolveState(list, options) {
  const favouriteSet = options.favourites instanceof Set
    ? options.favourites
    : new Set(Array.isArray(options.favourites) ? options.favourites : []);
  const isFavourite = typeof options.isFavourite === 'function' ? options.isFavourite : null;
  const playing = options.playing == null ? null : String(options.playing);

  const favouriteFlags = new Uint8Array(list.length);
  for (let index = 0; index < list.length; index += 1) {
    favouriteFlags[index] = isMarkedFavourite(list[index], isFavourite, favouriteSet) ? 1 : 0;
  }

  let playingIndex = -1;
  if (playing !== null) {
    for (let index = 0; index < list.length; index += 1) {
      if (list[index] && String(list[index].id) === playing) {
        playingIndex = index;
        break;
      }
    }
  }

  return { favouriteFlags, playingIndex };
}

/**
 * Build the raster for a station list.
 *
 * @param {Array} stations  catalogue entries with `metadata.layout`
 * @param {object} [options]
 * @param {Set<string>|Array<string>} [options.favourites]  favourite ids
 * @param {string|null} [options.playing]  id of the station that is playing
 * @returns {{width: number, height: number, pixels: Uint8Array, ids: Float32Array}}
 */
export function buildStationField(stations, options = {}) {
  const width = FIELD_WIDTH;
  const height = FIELD_HEIGHT;

  const texels = width * height;
  const pixels = new Uint8Array(texels * 4);
  const ids = new Float32Array(texels);
  ids.fill(-1);

  // Two accumulators: total weight, and the best single contributor's weight.
  // The second is what assigns a texel to one station for picking.
  const total = new Float32Array(texels);
  const best = new Float32Array(texels);

  const list = Array.isArray(stations) ? stations : [];

  // First pass: where does the catalogue actually sit? Mapping the raster's
  // radial axis onto the full annulus would waste most of it whenever the
  // stations occupy a narrower band, and a station whose radius fell outside an
  // assumed range would light no pixel at all.
  const entries = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let index = 0; index < list.length; index += 1) {
    const orbit = orbitOf(list[index]);
    if (!orbit) continue;
    if (orbit.radius < DISK_INNER * 0.98 || orbit.radius > DISK_OUTER * 1.02) continue;
    if (orbit.radius < lo) lo = orbit.radius;
    if (orbit.radius > hi) hi = orbit.radius;
    entries.push({ index, radius: orbit.radius, angle: orbit.angle });
  }

  if (entries.length === 0) {
    return { width, height, pixels, ids, inner: DISK_INNER, outer: DISK_OUTER, count: 0 };
  }

  // Pad a hair so a station sitting exactly on the edge is not clipped in half,
  // but never past the annulus the shader shades.
  const inner = Math.max(DISK_INNER, lo - 0.05);
  const outer = Math.min(DISK_OUTER, hi + 0.05);
  const span = Math.max(1e-6, outer - inner);

  for (let e = 0; e < entries.length; e += 1) {
    const entry = entries[e];
    const index = entry.index;
    const radius = entry.radius;
    const angle = entry.angle;
    const station = list[index];

    // One emanation per station, but a featured station is a brighter knot.
    const weight = station.isFeatured ? 1.5 : 1.0;

    const cy = ((radius - inner) / span) * (height - 1);
    const cx = ((((angle % TAU) + TAU) % TAU) / TAU) * width;

    const y0 = Math.max(0, Math.floor(cy) - CORE_REACH);
    const y1 = Math.min(height - 1, Math.ceil(cy) + CORE_REACH);
    const reach = CORE_REACH + 1;
    const x0 = Math.floor(cx) - CORE_REACH - 1;
    const x1 = Math.ceil(cx) + CORE_REACH + 1;

    // A texel's footprint is a Gaussian in flat texel space, which is the
    // right shape for a dense band: neighbouring stations overlap into a
    // ridge instead of a row of beads.
    for (let y = y0; y <= y1; y += 1) {
      const dy = y - cy;
      const dy2 = dy * dy;
      if (dy2 > reach * reach) continue;
      const row = y * width;
      for (let x = x0; x <= x1; x += 1) {
        const dx = x - cx;
        // Wrap the azimuth: x = -1 is the same texel as x = width - 1.
        const wrapped = dx - Math.round(dx / width) * width;
        const d2 = wrapped * wrapped + dy2;
        if (d2 > reach * reach) continue;
        const w = weight * Math.exp(-d2 / (2 * CORE_SIGMA * CORE_SIGMA));
        if (w < 0.004) continue;
        const tx = ((x % width) + width) % width;
        const cell = row + tx;
        total[cell] += w;
        if (w > best[cell]) {
          best[cell] = w;
          ids[cell] = index;
        }
      }
    }
  }

  // Resolve the per-station state once. The finalise loop touches a million
  // texels, and asking the store a million times would dominate the build.
  const { favouriteFlags, playingIndex } = resolveState(list, options);

  for (let cell = 0; cell < texels; cell += 1) {
    const mass = total[cell];
    const out = cell * 4;
    if (mass <= 0.004) {
      pixels[out] = 0;
      pixels[out + 1] = 0;
      pixels[out + 2] = 0;
      pixels[out + 3] = 0;
      ids[cell] = -1;
      continue;
    }

    // Saturating curve: sparse stations stay distinct, crowded regions flatten
    // out instead of clipping to a plateau.
    const saturated = mass / (SATURATION * (1 + mass / (DENSITY_KNEE * SATURATION)));
    const density = Math.min(1, saturated);

    // Concentration: one station carrying the texel means the peak and the
    // total are close. A crowd makes the total much larger than the peak.
    const concentration = Math.min(1, best[cell] / Math.max(1e-6, mass));

    const stationIndex = ids[cell];
    let bits = 0;
    if (stationIndex >= 0 && favouriteFlags[stationIndex]) bits |= 1;
    if (stationIndex >= 0 && stationIndex === playingIndex) bits |= 2;

    pixels[out] = Math.round(density * 255);
    pixels[out + 1] = Math.round(concentration * 255);
    pixels[out + 2] = bits;
    pixels[out + 3] = 255;
  }

  return { width, height, pixels, ids, inner, outer, count: entries.length };
}

/**
 * Disc coordinates of one station.
 *
 * The sprite layer falls back to the station's own `position` when the
 * catalogue carries no layout, and this must agree with it exactly: the raster
 * is where those sprites would have been, so a station whose position is
 * derived differently would light a pixel it does not own.
 */
function orbitOf(station) {
  if (!station) return null;
  const layout = station.metadata ? station.metadata.layout : null;
  if (layout) {
    const radius = Number(layout.radius);
    const angle = Number(layout.angle);
    if (Number.isFinite(radius) && Number.isFinite(angle)) return { radius, angle };
  }
  const position = station.position;
  if (!position) return null;
  const radius = Math.hypot(Number(position.x) || 0, Number(position.z) || 0);
  const angle = Math.atan2(Number(position.z) || 0, Number(position.x) || 0);
  if (!Number.isFinite(radius) || !Number.isFinite(angle)) return null;
  return { radius, angle };
}

/** Azimuth of a point on the disc plane, matching the raster's x axis. */
export function fieldAzimuthUv(angle) {
  return (((angle % TAU) + TAU) % TAU) / TAU;
}

/** Radius of a point on the disc plane, as the raster's y coordinate. */
export function fieldRadiusUv(radius) {
  return (radius - DISK_INNER) / Math.max(1e-6, DISK_OUTER - DISK_INNER);
}

/**
 * Rewrite only the state bits of an existing raster.
 *
 * Favouriting a station changes two bits of one channel; re-running the whole
 * build for that would cost about a hundred milliseconds of dropped frames.
 * This touches nothing but the B channel, so the density and the ownership map
 * stay exactly as they were.
 */
export function rewriteStationBits(field, stations, options = {}) {
  if (!field || !field.pixels || !field.ids) return field;
  const list = Array.isArray(stations) ? stations : [];
  const { favouriteFlags, playingIndex } = resolveState(list, options);
  const { pixels, ids } = field;
  const texels = Math.min(ids.length, Math.floor(pixels.length / 4));
  for (let cell = 0; cell < texels; cell += 1) {
    const stationIndex = ids[cell];
    let bits = 0;
    if (stationIndex >= 0) {
      if (favouriteFlags[stationIndex]) bits |= 1;
      if (stationIndex === playingIndex) bits |= 2;
    }
    pixels[cell * 4 + 2] = bits;
  }
  return field;
}
