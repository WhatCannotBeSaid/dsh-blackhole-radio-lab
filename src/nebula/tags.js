/**
 * The tag shelves inside one category.
 *
 * A category is not a flat list: its stations are filed under real tags, and
 * those tags are the only honest second axis the data offers. So the nebula
 * page for a category is built from its own tags — the eight most common ones
 * that actually say something — and every station goes to exactly one of them.
 *
 * Two rules keep the shelves legible:
 *
 * 1. Noise tags are dropped first. `fm`, `radio`, `usa` and friends are on
 *    almost every row; grouping by them would produce one enormous shelf and
 *    seven slivers.
 * 2. A station is filed under the *least* common of its own tags. Filing by the
 *    most common one would pour the catalogue into the biggest shelf and leave
 *    the rest decorative; filing by the rarest is what makes a shelf mean
 *    something. A station with no shelf tag at all joins the smallest shelf so
 *    it is never dropped from its own category.
 *
 * Everything here is deterministic in (catalogue, category, seed).
 */

import { primaryCategoryOf, scatterStations } from '../cluster/layout.js';
import { tagsOf } from '../radio/genres.js';
import { buildNebulaLayout } from './layout.js';

/** Most common tag count on this page. */
export const MAX_TAG_SHELVES = 8;

/**
 * Tags that describe the medium or the country rather than the content. They
 * are extremely frequent and carry no information about what is playing.
 */
const NOISE_TAGS = new Set([
  'fm',
  'am',
  'radio',
  'music',
  'musik',
  'musique',
  'musica',
  'usa',
  'us',
  'uk',
  'germany',
  'deutschland',
  'france',
  'italy',
  'spain',
  'poland',
  'russia',
  'brasil',
  'brazil',
  'mexico',
  'canada',
  'australia',
  'netherlands',
  'belgium',
  'switzerland',
  'austria',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'greece',
  'turkey',
  'india',
  'china',
  'japan',
  'korea',
  'online',
  'internet',
  'web',
  'stream',
  'streaming',
  'live',
  'local',
  'regional',
  'national',
  'commercial',
  'non-commercial',
  'public',
  'community',
  'various',
  'other',
  'misc',
  'hits',
  'top',
  'top40',
  'charts',
  'talk',
  'news',
  'sport',
  'sports',
  'weather',
  'podcast',
  'podcasts',
  'mp3',
  'aac',
  'hq',
  'stereo',
  'digital',
  'analog',
  'analogue',
  '24/7',
  'current',
  'new',
  'oldies',
]);

/** The tight shelf band: one category's tags sit much closer than a genre sky. */
export const SHELF = {
  shellInner: 4.6,
  shellOuter: 6.6,
  radiusMin: 0.78,
  radiusMax: 1.72,
  minGap: 0.46,
  extentFloor: 5.6,
};

/**
 * Group a category's stations by tag and lay them out.
 *
 * @param stations - the whole catalogue (index order is the station index).
 * @param categoryId - the category whose nebula this is.
 * @param options - { seed?, maxTags? }
 * @returns {{
 *   categoryId: string, seed: number, tags: Array<{id,count,stations}>,
 *   layout: object, stations: { positions, members, weights, radius },
 *   groups: Array<object>,
 * }}
 */
export function buildTagNebula(stations, categoryId, options = {}) {
  const list = Array.isArray(stations) ? stations : [];
  const count = list.length;
  const id = String(categoryId || '');
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : 0;
  const maxTags = Math.max(2, Math.min(MAX_TAG_SHELVES, Math.round(Number(options.maxTags) || MAX_TAG_SHELVES)));

  // Members of the category, by the same primary-category rule the cluster
  // field uses. A station belongs to one place at every level.
  const memberIndices = [];
  for (let i = 0; i < count; i += 1) {
    if (primaryCategoryOf(list[i]) === id) memberIndices.push(i);
  }

  // Tag frequency over the members only.
  const frequency = new Map();
  const tagOfMember = new Map();
  for (const index of memberIndices) {
    const usable = [];
    for (const tag of tagsOf(list[index])) {
      if (!isShelfTag(tag)) continue;
      frequency.set(tag, (frequency.get(tag) || 0) + 1);
      usable.push(tag);
    }
    tagOfMember.set(index, usable);
  }

  const ranked = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxTags)
    .map(([tag, tagCount]) => ({ id: tag, count: tagCount, stations: [] }));

  if (!ranked.length) {
    // No usable tags at all: one shelf holding the whole category, so the page
    // still has a shape instead of an empty sky.
    ranked.push({ id: id || 'all', count: memberIndices.length, stations: [] });
  }

  const shelfById = new Map(ranked.map((shelf) => [shelf.id, shelf]));
  // Least common first: the ordering that turns "rarest of its own tags" into
  // a single lookup per station.
  const shelvesByFrequency = [...ranked].sort(
    (a, b) => a.count - b.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const smallest = shelvesByFrequency[0];

  const members = new Uint8Array(count);
  for (const index of memberIndices) {
    members[index] = 1;
    const usable = tagOfMember.get(index) || [];
    let target = smallest;
    for (const tag of usable) {
      const shelf = shelfById.get(tag);
      if (shelf && shelf.count < target.count) target = shelf;
    }
    if (!target) continue;
    target.stations.push(index);
  }

  // The volumes are the scenery; the shelves themselves are the truth.
  const layout = buildNebulaLayout(
    ranked.map((shelf) => ({ id: shelf.id, count: shelf.stations.length })),
    { seed, vocabulary: ranked.map((shelf) => shelf.id), ...SHELF },
  );

  const groups = [];
  for (const volume of layout.genres) {
    const shelf = shelfById.get(volume.id);
    if (!shelf) continue;
    groups.push({
      id: volume.id,
      count: shelf.stations.length,
      radius: volume.radius * 0.92,
      center: volume.center,
      stations: shelf.stations,
    });
  }

  const { positions, weights } = scatterStations(count, groups, seed);

  return {
    categoryId: id,
    seed,
    tags: ranked,
    layout,
    groups,
    stations: {
      positions,
      members,
      weights,
      radius: layout.extent,
    },
  };
}

/** Is this tag worth a shelf: long enough, not purely numeric, not noise. */
function isShelfTag(tag) {
  if (typeof tag !== 'string' || tag.length < 3) return false;
  if (/^[0-9]+$/.test(tag)) return false;
  if (NOISE_TAGS.has(tag)) return false;
  return true;
}
