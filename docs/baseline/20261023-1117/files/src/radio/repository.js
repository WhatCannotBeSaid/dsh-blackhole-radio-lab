/**
 * The data-access boundary for the station map.
 *
 * Everything above this line (scene, picking, labels, panel) talks to the same
 * small interface:
 *
 *   list()                    → all stations, stable order
 *   getById(id)               → one station or null
 *   search(query, limit)      → ranked matches, local only
 *   categories()              → taxonomy with per-category counts
 *   featured()                → the photon-ring subset
 *   anchors()                 → spatial cluster centres, for labels
 *   stats()                   → counts the rail reports
 *   kind                      → 'mock' in this phase
 *
 * Phase 4 swaps `createMockRadioRepository` for a Radio Browser-backed
 * implementation of the same shape. Ids stay the stable key; three.js instance
 * indices live in the renderer, never here.
 *
 * Search runs entirely against the generated catalogue: no fetch, no index
 * library, no dependency. The haystack is precomputed once per station.
 */

import { generateCatalog, normalizeCatalogOptions, categoryText } from './station.js';
import { assignPositions } from './distribution.js';

export function createMockRadioRepository(options) {
  const opts = normalizeCatalogOptions(options);
  const catalog = generateCatalog(opts);
  const layout = assignPositions(catalog.stations, opts.seed);
  const stations = catalog.stations;
  const byId = new Map();
  const haystacks = new Array(stations.length);

  let countryCount = 0;
  let languageCount = 0;
  const countries = new Set();
  const languages = new Set();

  for (let index = 0; index < stations.length; index += 1) {
    const station = stations[index];
    byId.set(station.id, station);
    const categoryWords = station.categories.map((id) => `${categoryText(id, 'zh')} ${categoryText(id, 'en')}`).join(' ');
    haystacks[index] = [
      station.name,
      station.country.zh,
      station.country.en,
      station.language.zh,
      station.language.en,
      categoryWords,
    ]
      .join(' ')
      .toLowerCase();
    countries.add(station.country.en);
    languages.add(station.language.en);
  }
  countryCount = countries.size;
  languageCount = languages.size;

  /**
   * Ranked local search. Substring matching, all query tokens must hit; name
   * hits rank above metadata hits. No network, no fuzzy-index dependency.
   */
  function search(query, limit = 24) {
    const text = String(query || '').trim().toLowerCase();
    if (text.length === 0) return [];
    const tokens = text.split(/\s+/).filter(Boolean).slice(0, 6);
    const max = Math.max(1, Math.min(60, limit));
    const hits = [];

    for (let index = 0; index < stations.length; index += 1) {
      const haystack = haystacks[index];
      let matched = true;
      for (const token of tokens) {
        if (!haystack.includes(token)) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const station = stations[index];
      const name = station.name.toLowerCase();
      let score = 0;
      if (name.startsWith(text)) score = 3;
      else if (name.includes(text)) score = 2;
      if (station.isFeatured) score += 0.25;
      hits.push({ station, score });
    }

    hits.sort((a, b) => b.score - a.score || a.station.name.localeCompare(b.station.name));
    return hits.slice(0, max).map((hit) => hit.station);
  }

  return {
    kind: 'mock',
    seed: opts.seed,
    list() {
      return stations;
    },
    getById(id) {
      return byId.get(String(id)) || null;
    },
    search,
    categories() {
      return catalog.categories;
    },
    featured() {
      return layout.featured;
    },
    anchors() {
      return layout.anchors;
    },
    stats() {
      return {
        total: stations.length,
        featured: layout.featured.length,
        countries: countryCount,
        languages: languageCount,
        categories: catalog.categories.length,
        seed: opts.seed,
        source: 'mock',
        demo: true,
      };
    },
  };
}
