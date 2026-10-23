/**
 * The mock category taxonomy.
 *
 * Eight buckets, deliberately broader than "music": a station map where every
 * node is a music station has nothing to cluster. A station may carry more than
 * one category; the first one is its primary and decides the cluster it lives
 * in, the rest are shown in the detail panel and are searchable.
 *
 * Colours are per category, but muted on purpose: the scene is a black-hole
 * artwork first and a chart second. They are reused as instance colours, so
 * these are the only category colours in the whole pipeline.
 */

export const CATEGORIES = Object.freeze([
  { id: 'music', zh: '音乐综合', en: 'Music', color: 0x8fb4ff, weight: 0.24 },
  { id: 'news', zh: '新闻资讯', en: 'News', color: 0xffb27a, weight: 0.16 },
  { id: 'talk', zh: '谈话与播客', en: 'Talk & Podcast', color: 0xb69cff, weight: 0.14 },
  { id: 'classical', zh: '古典音乐', en: 'Classical', color: 0xd9c8a4, weight: 0.1 },
  { id: 'jazz', zh: '爵士乐', en: 'Jazz', color: 0x8fd0c0, weight: 0.1 },
  { id: 'electronic', zh: '电子音乐', en: 'Electronic', color: 0x74d0ff, weight: 0.1 },
  { id: 'world', zh: '世界音乐', en: 'World', color: 0xa6d98c, weight: 0.09 },
  { id: 'ambient', zh: '环境音乐', en: 'Ambient', color: 0x9fb0cc, weight: 0.07 },
]);

const BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));

/** Look up a category record; unknown ids resolve to undefined. */
export function categoryById(id) {
  return BY_ID.get(String(id));
}

/** Localised label for a category id, falling back to the id itself. */
export function categoryLabel(id, lang) {
  const category = BY_ID.get(String(id));
  if (!category) return String(id);
  return lang === 'en' ? category.en : category.zh;
}

/** Colour as a 0–1 RGB triple, for buffer attributes and CSS. */
export function categoryRgb(id) {
  const category = BY_ID.get(String(id)) || CATEGORIES[0];
  const hex = category.color;
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** CSS colour for the detail panel / filter chips. */
export function categoryCss(id) {
  const category = BY_ID.get(String(id)) || CATEGORIES[0];
  return `#${category.color.toString(16).padStart(6, '0')}`;
}

/**
 * Draw a primary category from the authored weights.
 * @param rng - a deterministic random source.
 */
export function pickCategory(rng) {
  let roll = rng();
  for (const category of CATEGORIES) {
    roll -= category.weight;
    if (roll <= 0) return category;
  }
  return CATEGORIES[0];
}
