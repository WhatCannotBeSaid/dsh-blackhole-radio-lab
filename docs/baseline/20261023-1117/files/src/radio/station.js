/**
 * The mock station catalogue — deterministic, and only ever mock.
 *
 * One record per station, generated from `(seed, index)`. The generator is
 * intentionally synchronous and dependency-free: it runs once when the stage
 * mounts, and nothing here knows about three.js, the DOM or the network. Swapping
 * this module for the phase-4 Radio Browser repository must not require touching
 * the scene.
 *
 * Every record carries `metadata.demo = true`, and the panel says so in words.
 * There are no listener counts, no "now playing", no stream URLs — nothing that
 * would imply a real broadcast is attached.
 */

import { categoryById, pickCategory, CATEGORIES } from './taxonomy.js';
import { streamFor, hash32, centered } from './random.js';
import { COUNTRIES, makeDescription, makeName } from './names.js';

export const DEFAULT_COUNT = 2000;
export const DEFAULT_SEED = 20261022;
export const DEFAULT_FEATURED = 18;
export const MIN_COUNT = 200;
export const MAX_COUNT = 20000;

/** Normalise the Host knobs into the shape the generator needs. */
export function normalizeCatalogOptions(options) {
  const source = options || {};
  const count = clampInt(source.count, DEFAULT_COUNT, MIN_COUNT, MAX_COUNT);
  const seed = toSeed(source.seed);
  const featuredCount = clampInt(source.featuredCount, DEFAULT_FEATURED, 4, Math.min(40, count));
  return { count, seed, featuredCount };
}

/** Pick the featured station indices: a fixed hash score, top N, no RNG order. */
function featuredIndices(count, seed, featuredCount) {
  const scored = new Array(count);
  for (let i = 0; i < count; i += 1) scored[i] = { index: i, score: hash32(seed, 'featured', i) };
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  const out = new Set();
  for (let i = 0; i < featuredCount && i < scored.length; i += 1) out.add(scored[i].index);
  return out;
}

/**
 * Build the catalogue.
 *
 * @param options.count - station count, 200–20,000.
 * @param options.seed - integer seed.
 * @param options.featuredCount - how many stations sit on the photon ring.
 * @returns {{stations: Array, categories: Array, seed: number, count: number}}
 */
export function generateCatalog(options) {
  const { count, seed, featuredCount } = normalizeCatalogOptions(options);
  const featured = featuredIndices(count, seed, featuredCount);
  const usedNames = new Set();
  const stations = new Array(count);
  const categoryCounts = new Map(CATEGORIES.map((category) => [category.id, 0]));

  for (let index = 0; index < count; index += 1) {
    const geoRng = streamFor(seed, index, 'geo');
    const categoryRng = streamFor(seed, index, 'categories');
    const nameRng = streamFor(seed, index, 'name');
    const copyRng = streamFor(seed, index, 'copy');

    const country = COUNTRIES[Math.floor(geoRng() * COUNTRIES.length) % COUNTRIES.length];
    const primary = pickCategory(categoryRng);
    const categories = [primary.id];

    // A second category broadens search and the detail panel without turning
    // every station into a "multi-format" station. The primary stays first.
    if (categoryRng() < 0.34) {
      let secondary = pickCategory(categoryRng);
      for (let guard = 0; guard < 4 && secondary.id === primary.id; guard += 1) {
        secondary = pickCategory(categoryRng);
      }
      if (secondary.id !== primary.id) categories.push(secondary.id);
    }

    const name = makeName(nameRng, usedNames, country, primary);
    const descriptionZh = makeDescription(copyRng, primary, 'zh');
    const descriptionEn = makeDescription(copyRng, primary, 'en');
    const isFeatured = featured.has(index);

    categoryCounts.set(primary.id, (categoryCounts.get(primary.id) || 0) + 1);

    stations[index] = {
      id: `mock-${String(index + 1).padStart(4, '0')}`,
      name,
      country: { zh: country.zh, en: country.en },
      language: { zh: country.languageZh, en: country.languageEn },
      categories,
      description: { zh: descriptionZh, en: descriptionEn },
      isFeatured,
      position: null,
      metadata: {
        demo: true,
        source: 'mock',
        seed,
        index,
        region: null,
        orbit: null,
        primaryCategory: primary.id,
      },
    };
  }

  return {
    stations,
    categories: CATEGORIES.map((category) => ({
      ...category,
      count: categoryCounts.get(category.id) || 0,
    })),
    seed,
    count,
    featuredCount: featured.size,
  };
}

/** Resolve a category id to its label, exported for the repository/search. */
export function categoryText(id, lang) {
  const category = categoryById(id);
  if (!category) return String(id);
  return lang === 'en' ? category.en : category.zh;
}

/** A tiny helper for labels that include a country in the active language. */
export function countryText(station, lang) {
  return lang === 'en' ? station.country.en : station.country.zh;
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function toSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(Math.round(value)) >>> 0;
  if (typeof value === 'string' && value.length > 0) return hash32('seed', value);
  return DEFAULT_SEED >>> 0;
}
