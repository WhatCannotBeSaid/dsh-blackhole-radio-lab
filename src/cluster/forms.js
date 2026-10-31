/**
 * The thirteen real-astronomy forms (phase 6).
 *
 * Every genre is a whole object in the sky, not a generic knot: a spiral galaxy
 * has arms, an elliptical has none, a supernova remnant is a shell with ejecta
 * thrown out of it. The field samples these shapes for the points that belong
 * to each genre, so the constellation reads as a sky of different objects at a
 * glance instead of thirteen copies of one ball.
 *
 * Two rules keep the picture honest:
 *
 * 1. A form is a *distribution*, never a texture. `sampleForm` returns a point
 *    inside the unit ball plus a weight; the caller scales it by the genre's
 *    own radius and places it. No geometry, no noise field, no extra pass.
 * 2. Sampling is pure and deterministic given `rand`, so the same seed always
 *    produces the same sky and the layout can be measured offline.
 *
 * Colours are the fixed phase-6 table: thirteen hues on a ~27.7 degree ring,
 * pushed toward the real object's own palette (a supernova remnant is rust, a
 * reflection nebula is blue) while staying far enough apart that no two genres
 * read as the same colour.
 */

import { GENRE_IDS } from '../radio/genres.js';

/** Fixed genre -> form table. Unknown ids fall back to the irregular galaxy. */
export const GENRE_FORMS = Object.freeze({
  jazz: 'barred-spiral',
  rock: 'supernova-remnant',
  pop: 'spiral',
  classical: 'elliptical',
  electronic: 'planetary',
  'hip-hop': 'globular',
  ambient: 'emission',
  'folk-world': 'open-cluster',
  'blues-soul': 'reflection',
  news: 'galaxy-cluster',
  talk: 'bipolar-jet',
  sports: 'edge-on',
  other: 'irregular',
});

/** Fixed genre -> main colour table (phase 6, agreed and written down). */
export const GENRE_COLORS = Object.freeze({
  rock: 0xff6a45,
  'hip-hop': 0xffa03d,
  classical: 0xf5d75a,
  news: 0xb8e06a,
  'folk-world': 0x7fd97a,
  other: 0x6fd9b0,
  electronic: 0x4fe0c8,
  sports: 0x4fc4ff,
  'blues-soul': 0x5f8cff,
  jazz: 0x9a7bff,
  talk: 0xd47aff,
  ambient: 0xff7ad9,
  pop: 0xff6fa8,
});

/** Human-readable form names, for the labels and the offline report. */
export const FORM_LABELS = Object.freeze({
  'barred-spiral': 'Barred spiral',
  'supernova-remnant': 'Supernova remnant',
  spiral: 'Spiral galaxy',
  elliptical: 'Elliptical galaxy',
  planetary: 'Planetary nebula',
  globular: 'Globular cluster',
  emission: 'Emission nebula',
  'open-cluster': 'Open cluster',
  reflection: 'Reflection nebula',
  'galaxy-cluster': 'Galaxy cluster',
  'bipolar-jet': 'Bipolar jet',
  'edge-on': 'Edge-on spiral',
  irregular: 'Irregular galaxy',
});

const TAU = Math.PI * 2;

/** Five directions a galaxy cluster hangs its cores on. */
const CLUSTER_CORES = Object.freeze([
  [0.72, 0.30, 0.22],
  [-0.62, 0.44, 0.40],
  [0.10, -0.55, 0.66],
  [-0.30, -0.24, -0.72],
  [0.34, 0.72, -0.46],
]);

/** Four lobes the irregular galaxy is broken into. */
const IRREGULAR_LOBES = Object.freeze([
  [0.52, 0.34, 0.28],
  [-0.44, 0.40, -0.30],
  [0.10, -0.52, 0.56],
  [-0.34, -0.20, -0.46],
]);

export function formOf(genreId) {
  return GENRE_FORMS[String(genreId)] || GENRE_FORMS.other;
}

export function colorOf(genreId) {
  const hex = GENRE_COLORS[String(genreId)];
  return hex === undefined ? GENRE_COLORS.other : hex;
}

/** Genre ids in the fixed ring order (the colour table's own order). */
export const FORM_GENRE_ORDER = Object.freeze(GENRE_IDS.slice());

/**
 * One point of one form, inside the unit ball.
 *
 * `rand(k)` must be a deterministic [0,1) source keyed by `k`; the form decides
 * how many draws it needs and always uses the same keys for the same branch, so
 * a station keeps its point when the seed and the shape stay the same.
 *
 * @returns {{x: number, y: number, z: number, w: number}} w in ~[0.3, 1.45].
 */
export function sampleForm(form, rand) {
  switch (form) {
    case 'spiral':
      return sampleSpiral(rand, false);
    case 'barred-spiral':
      return sampleSpiral(rand, true);
    case 'elliptical':
      return sampleElliptical(rand);
    case 'supernova-remnant':
      return sampleRemnant(rand);
    case 'planetary':
      return samplePlanetary(rand);
    case 'globular':
      return sampleGlobular(rand);
    case 'emission':
      return sampleEmission(rand);
    case 'open-cluster':
      return sampleOpenCluster(rand);
    case 'reflection':
      return sampleReflection(rand);
    case 'galaxy-cluster':
      return sampleGalaxyCluster(rand);
    case 'bipolar-jet':
      return sampleJet(rand);
    case 'edge-on':
      return sampleEdgeOn(rand);
    case 'irregular':
    default:
      return sampleIrregular(rand);
  }
}

/** Thin disk with two arms, and a bar through the middle when `bar` is set. */
function sampleSpiral(rand, bar) {
  if (bar && rand(1) < 0.26) {
    // The bar: a straight, slightly thickened core along x.
    const s = (rand(2) - 0.5) * 0.86;
    const halo = 0.30 * (1 - Math.abs(s) / 0.43);
    return {
      x: s,
      y: (rand(3) - 0.5) * (0.05 + 0.08 * Math.max(0, halo)),
      z: (rand(4) - 0.5) * (0.05 + 0.08 * Math.max(0, halo)),
      w: 0.95,
    };
  }
  const inner = bar ? 0.24 : 0;
  const r = inner + Math.pow(rand(5), 0.55) * (0.94 - inner);
  const arm = rand(6) < 0.5 ? 0 : Math.PI;
  const theta = arm + (r - inner) * 5.6 + (rand(7) - 0.5) * 0.44;
  const thick = 0.045 + 0.095 * r * r;
  // The bulge is a small, bright, round centre the arms wind out of.
  const bulge = r < 0.16 ? 0.16 : 0;
  return {
    x: Math.cos(theta) * r,
    y: (rand(8) - 0.5) * (thick + bulge),
    z: Math.sin(theta) * r,
    w: 0.42 + 0.6 * Math.max(0, 1 - r * 0.62),
  };
}

/** Flattened ellipsoid, no arms, density falling from the centre. */
function sampleElliptical(rand) {
  const dir = sphere(rand(1), rand(2));
  const r = Math.pow(rand(3), 0.45);
  return { x: dir[0] * r, y: dir[1] * r * 0.62, z: dir[2] * r, w: 0.45 + 0.62 * (1 - r) };
}

/** A thin shell, plus a few knots of ejecta thrown out of it. */
function sampleRemnant(rand) {
  if (rand(1) < 0.14) {
    const dir = sphere(rand(2), rand(3));
    const r = 0.34 + 0.56 * rand(4);
    return { x: dir[0] * r, y: dir[1] * r, z: dir[2] * r, w: 1.18 };
  }
  const dir = sphere(rand(5), rand(6));
  const r = 0.85 + 0.13 * rand(7);
  return {
    x: dir[0] * r,
    y: dir[1] * r,
    z: dir[2] * r,
    w: 0.52 + 1.5 * Math.max(0, r - 0.85),
  };
}

/** A bright ring in the equatorial plane, plus two polar lobes. */
function samplePlanetary(rand) {
  if (rand(1) < 0.18) {
    const dir = rand(2) < 0.5 ? 1 : -1;
    const r = 0.30 + 0.66 * rand(3);
    const spread = 0.09 + 0.10 * rand(4);
    return {
      x: (rand(5) - 0.5) * spread * (0.4 + r),
      y: dir * r,
      z: (rand(6) - 0.5) * spread * (0.4 + r),
      w: 0.95,
    };
  }
  const dir = sphere(rand(7), rand(8));
  const r = 0.80 + 0.15 * rand(9);
  return { x: dir[0] * r, y: dir[1] * r * 0.28, z: dir[2] * r, w: 0.68 + 0.45 * rand(10) };
}

/** A hard, bright core with a round halo: nothing flattened. */
function sampleGlobular(rand) {
  const dir = sphere(rand(1), rand(2));
  const r = Math.pow(rand(3), 2.8);
  return { x: dir[0] * r, y: dir[1] * r * 0.92, z: dir[2] * r, w: 0.42 + 0.9 * (1 - r) };
}

/** Wide, faint gas threaded on three drifting filaments. */
function sampleEmission(rand) {
  const dir = sphere(rand(1), rand(2));
  const r = Math.pow(rand(3), 0.42);
  const filament = rand(4);
  const t = r * 6.4 + filament * 2.1;
  return {
    x: dir[0] * r + Math.cos(t) * 0.32 * r,
    y: dir[1] * r * 0.72 + (rand(5) - 0.5) * 0.16 * r,
    z: dir[2] * r + Math.sin(t) * 0.32 * r,
    w: 0.34 + 0.42 * r,
  };
}

/** Loose, wide scattering of a handful of bright members. */
function sampleOpenCluster(rand) {
  const dir = sphere(rand(1), rand(2));
  const r = 0.36 + 0.58 * Math.pow(rand(3), 0.7);
  return { x: dir[0] * r, y: dir[1] * r * 0.8, z: dir[2] * r, w: 1.22 };
}

/** A shell seen through dust: dim core, bright rim, flattened. */
function sampleReflection(rand) {
  const dir = sphere(rand(1), rand(2));
  const r = 0.44 + 0.52 * rand(3);
  return { x: dir[0] * r, y: dir[1] * r * 0.55, z: dir[2] * r, w: 0.40 + 0.95 * (r - 0.44) + 0.4 };
}

/** Several small cores hung on bridges. */
function sampleGalaxyCluster(rand) {
  const pick = Math.floor(rand(1) * CLUSTER_CORES.length) % CLUSTER_CORES.length;
  const core = CLUSTER_CORES[pick];
  if (rand(2) < 0.24) {
    const next = CLUSTER_CORES[(pick + 1) % CLUSTER_CORES.length];
    const t = rand(3);
    const sway = 0.06;
    return {
      x: (core[0] * (1 - t) + next[0] * t) * 0.72 + (rand(4) - 0.5) * sway,
      y: (core[1] * (1 - t) + next[1] * t) * 0.72 + (rand(5) - 0.5) * sway,
      z: (core[2] * (1 - t) + next[2] * t) * 0.72 + (rand(6) - 0.5) * sway,
      w: 0.62,
    };
  }
  const dir = sphere(rand(7), rand(8));
  const r = 0.09 + 0.20 * Math.pow(rand(9), 1.5);
  return {
    x: core[0] * 0.62 + dir[0] * r,
    y: core[1] * 0.62 + dir[1] * r,
    z: core[2] * 0.62 + dir[2] * r,
    w: 1.0,
  };
}

/** A compact nucleus with two narrow jets up and down. */
function sampleJet(rand) {
  if (rand(1) < 0.22) {
    const dir = sphere(rand(2), rand(3));
    const r = Math.pow(rand(4), 2.2) * 0.17;
    return { x: dir[0] * r, y: dir[1] * r, z: dir[2] * r, w: 1.0 };
  }
  const dir = rand(5) < 0.5 ? 1 : -1;
  const r = 0.18 + 0.80 * rand(6);
  const spread = 0.045 + 0.05 * r;
  return {
    x: (rand(7) - 0.5) * spread * 2,
    y: dir * r,
    z: (rand(8) - 0.5) * spread * 2,
    w: 0.5 + 0.55 * Math.max(0, 1 - r * 0.55),
  };
}

/** A thin disk seen edge-on: a long, narrow band with a hot centre. */
function sampleEdgeOn(rand) {
  const r = Math.pow(rand(1), 0.5);
  const t = rand(2) * TAU;
  return {
    x: Math.cos(t) * r * 1.32,
    y: (rand(3) - 0.5) * 0.038,
    z: Math.sin(t) * r * 0.86,
    w: 0.45 + 0.75 * Math.max(0, 1 - r),
  };
}

/** Four asymmetric lobes: no symmetry, no nucleus, no arms. */
function sampleIrregular(rand) {
  const pick = Math.floor(rand(1) * IRREGULAR_LOBES.length) % IRREGULAR_LOBES.length;
  const lobe = IRREGULAR_LOBES[pick];
  const dir = sphere(rand(2), rand(3));
  const r = 0.20 + 0.30 * Math.pow(rand(4), 0.8);
  return {
    x: lobe[0] * 0.56 + dir[0] * r,
    y: lobe[1] * 0.44 + dir[1] * r * 0.82,
    z: lobe[2] * 0.56 + dir[2] * r,
    w: 0.55 + 0.55 * rand(5),
  };
}

/** Cosine-weighted unit sphere point from two uniforms. */
function sphere(a, b) {
  const phi = Math.acos(2 * a - 1);
  const theta = b * TAU;
  const s = Math.sin(phi);
  return [s * Math.cos(theta), Math.cos(phi), s * Math.sin(theta)];
}

/** 0–1 RGB triple for a genre's main colour. */
export function colorRgbOf(genreId) {
  const hex = colorOf(genreId);
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** CSS colour for a genre's main colour. */
export function colorCssOf(genreId) {
  return `#${colorOf(genreId).toString(16).padStart(6, '0')}`;
}

/**
 * Country and language modulate a genre tint without moving its hue.
 *
 * The rule agreed for the cluster page: country sets how bright a member is and
 * language sets how warm or cool it is. Values stay inside +-18% luminance and
 * a 12% warm/cool push, which is enough to break a genre's even wash into
 * distinguishable members while every point still reads as the same genre.
 *
 * @param rgb - [r, g, b] in 0–1, the genre's main colour.
 * @param country - 0–1 deterministic per country.
 * @param language - 0–1 deterministic per language.
 */
export function modulateTint(rgb, country, language) {
  const brightness = 0.86 + 0.30 * clamp01(country);
  const warm = clamp01(language);
  // A warm push leans red, a cool push leans blue. Both keep the hue broadly in
  // place, which a hue rotation would not.
  const wr = 1 + 0.10 * (warm - 0.5) * 2;
  const wg = 1 + 0.02 * (warm - 0.5) * 2;
  const wb = 1 - 0.12 * (warm - 0.5) * 2;
  return [
    clamp01(rgb[0] * brightness * wr),
    clamp01(rgb[1] * brightness * wg),
    clamp01(rgb[2] * brightness * wb),
  ];
}

/**
 * Tag tint: a small hue rotation around the genre's own colour.
 *
 * The agreed layer is +-25 degrees, which keeps nine tag groups inside one
 * genre's colour family: they separate from each other, and none of them drifts
 * into a neighbouring genre's hue.
 */
export function tagTintRgb(rgb, amount) {
  const a = Math.max(-1, Math.min(1, Number(amount) || 0));
  const angle = (a * 25 * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Rotate around the grey axis (the luminance-preserving hue rotation).
  const r = rgb[0];
  const g = rgb[1];
  const b = rgb[2];
  return [
    clamp01(r * (0.213 + 0.787 * cos - 0.213 * sin) + g * (0.715 - 0.715 * cos - 0.715 * sin) + b * (0.072 - 0.072 * cos + 0.928 * sin)),
    clamp01(r * (0.213 - 0.213 * cos + 0.143 * sin) + g * (0.715 + 0.285 * cos + 0.140 * sin) + b * (0.072 - 0.072 * cos - 0.283 * sin)),
    clamp01(r * (0.213 - 0.213 * cos - 0.787 * sin) + g * (0.715 - 0.715 * cos + 0.715 * sin) + b * (0.072 + 0.928 * cos + 0.072 * sin)),
  ];
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}
