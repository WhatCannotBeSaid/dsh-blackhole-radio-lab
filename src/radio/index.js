/**
 * Bundle entry for the data chunk (client.radio.js).
 *
 * This chunk is deliberately three-free and DOM-free: it is the whole data
 * boundary the panel and the renderer share. The stage receives the same plain
 * station records whichever source produced them, and the panel keeps calling
 * the same `search`.
 *
 * Phase 5 adds the Radio Browser source beside the mock one:
 *
 *   createMockRadioRepository(options)   → synchronous, offline, deterministic
 *   createRadioRepository(options)       → async; real data, mock on failure
 *   createRepositoryFromRows(rows, opts) → pure mapping, for tests and caches
 * Phase 6 adds the genre layer beside the taxonomy: the eight buckets stay the
 * artwork's vocabulary, the thirteen genres are the nebula space's.
 *
 * Phase 7 adds shared state: one station index carrying identity and business
 * state (`createRadioStore`), and the single audio owner
 * (`createPlaybackCore`). Neither imports React, the DOM or three.js, so the
 * panel, the stage's overlays and the node-side tests all build the same thing.
 */

export {
  createMockRadioRepository,
  createRadioRepository,
  createRepositoryFromRows,
  fetchRadioBrowserCatalog,
  RADIO_BROWSER_HOSTS,
  RADIO_BROWSER_DEFAULTS,
} from './repository.js';
export { CATEGORIES, categoryById, categoryCss, categoryLabel } from './taxonomy.js';
export {
  GENRES,
  GENRE_IDS,
  GENRE_RULES,
  MIN_GENRE_STATIONS,
  attachGenre,
  classifyGenre,
  displayGenreId,
  genreById,
  genreCss,
  genreFor,
  genreLabel,
  genreOf,
  genreRgb,
  isMusicGenre,
  normalizeTag,
  summarizeGenres,
  tagsOf,
} from './genres.js';
export { mapStation, mapStations, categoriesFor, isStreamUrl, streamUrlFor, MAPPING } from './radio-browser.js';
export { createRadioStore, stationKey, songKeyOf, normalizeSongTitle, mockSignature, RECENT_LIMIT } from './store.js';
export { createPlaybackCore, SLOW_LOAD_MS } from './playback.js';
export { openRadioCache, CATALOG_TTL_MS, BLACKLIST_LIMIT } from './cache.js';
