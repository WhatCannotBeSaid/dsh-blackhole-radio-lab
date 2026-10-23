/**
 * Bundle entry for the data chunk (client.radio.js).
 *
 * This chunk is deliberately three-free and DOM-free: it is the whole data
 * boundary the panel and the renderer share. Phase 4 replaces the repository
 * implementation behind these names; the stage keeps receiving the same plain
 * station records, and the panel keeps calling the same search.
 */

export { createMockRadioRepository } from './repository.js';
export { CATEGORIES, categoryById, categoryCss, categoryLabel } from './taxonomy.js';
