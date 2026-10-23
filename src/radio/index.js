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
export { mapStation, mapStations, categoriesFor, isStreamUrl, streamUrlFor, MAPPING } from './radio-browser.js';
