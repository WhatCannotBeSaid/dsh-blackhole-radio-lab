/**
 * The 13 fixed genre buckets — a classification layer that sits *above* the
 * eight-bucket taxonomy, never instead of it.
 *
 * Two questions, two modules:
 *
 *   taxonomy.js       "what colour does this station's dot get on the disk?"
 *                     Eight authored buckets, tuned for the artwork, unchanged.
 *   genres.js (this)  "which nebula does this station belong to?"
 *                     Thirteen fixed genres, matched from the real tags the
 *                     Radio Browser API returns.
 *
 * The genre list is a constant. It never grows or shrinks because one API
 * sample happened to be thin: sample sizes change, the vocabulary does not.
 * Display grouping is a *separate* step (see {@link summarizeGenres}): a genre
 * with fewer than {@link MIN_GENRE_STATIONS} stations still exists in the data,
 * it just does not get a nebula of its own and is shown under Other. That way
 * the statistics and the picture always agree, and a station that was merged is
 * still reachable through Other.
 *
 * Classification rules, in order of authority:
 *
 *   1. Only `tags` (then the station name) are evidence. Nothing is invented.
 *      When a record carries neither (the deterministic mock catalogue, or a
 *      real station that arrived untagged), the eight-bucket taxonomy already
 *      on the record is consulted as weak evidence — never above a real tag.
 *   2. A tag matches exactly (+3) or as a whole phrase inside a compound tag
 *      (+1): "jazz" hits both "jazz" and "jazz funk", never "jazzercise" noise.
 *      Phrase matching pads both sides, so "rock" cannot hit "rockabilly".
 *   3. Content genres (news / talk / sports) carry a tier bonus, so a station
 *      tagged "news, music" is news. The bonus is small enough that two clear
 *      music tags still win.
 *   4. Score decides; the tier bonus breaks near-ties; the fixed genre order
 *      breaks the rest. One primary genre per station, always the same one for
 *      the same input, whatever order the tags or the API rows arrive in.
 *   5. No evidence at all → `other`, and the record says it was unmatched.
 *
 * Raw tags are never rewritten: `station.metadata.tags` keeps exactly what the
 * API sent, and the classifier works on a normalised copy.
 */

/** A genre needs at least this many stations in the current sample to earn a nebula. */
export const MIN_GENRE_STATIONS = 3;

/**
 * The fixed vocabulary, in the order the nebula space will lay it out.
 *
 * `tier` is the conflict bonus described above: content genres outrank music
 * when the evidence is comparable. `group` separates the two for the panel and
 * for any future layout that wants to keep content together.
 */
const RAW_GENRES = [
  { id: 'jazz', zh: '爵士', en: 'Jazz', color: 0x8fa2e8, group: 'music', tier: 8 },
  { id: 'rock', zh: '摇滚', en: 'Rock', color: 0xc9706a, group: 'music', tier: 8 },
  { id: 'pop', zh: '流行', en: 'Pop', color: 0xd79ac0, group: 'music', tier: 8 },
  { id: 'classical', zh: '古典', en: 'Classical', color: 0xe4d9b4, group: 'music', tier: 8 },
  { id: 'electronic', zh: '电子', en: 'Electronic', color: 0x74c8e0, group: 'music', tier: 8 },
  { id: 'hip-hop', zh: '嘻哈', en: 'Hip-Hop', color: 0xbe7ad4, group: 'music', tier: 8 },
  { id: 'ambient', zh: '氛围', en: 'Ambient', color: 0x5f7fc4, group: 'music', tier: 8 },
  { id: 'folk-world', zh: '民谣与世界', en: 'Folk & World', color: 0x8fcaa8, group: 'music', tier: 8 },
  { id: 'blues-soul', zh: '蓝调与灵魂', en: 'Blues & Soul', color: 0xd9b06a, group: 'music', tier: 8 },
  { id: 'news', zh: '新闻', en: 'News', color: 0xc8d6e8, group: 'content', tier: 20 },
  { id: 'talk', zh: '谈话', en: 'Talk', color: 0x9aa8c4, group: 'content', tier: 18 },
  { id: 'sports', zh: '体育', en: 'Sports', color: 0xe08a63, group: 'content', tier: 19 },
  { id: 'other', zh: '其他', en: 'Other', color: 0x9a9a9a, group: 'other', tier: 0 },
];

export const GENRES = Object.freeze(RAW_GENRES.map((genre) => Object.freeze(genre)));

export const GENRE_IDS = Object.freeze(GENRES.map((genre) => genre.id));

const BY_ID = new Map(GENRES.map((genre) => [genre.id, genre]));

/** Look up a genre definition; unknown ids resolve to undefined. */
export function genreById(id) {
  return BY_ID.get(String(id));
}

/** Localised label for a genre id, falling back to the id itself. */
export function genreLabel(id, lang) {
  const genre = BY_ID.get(String(id));
  if (!genre) return String(id);
  return lang === 'en' ? genre.en : genre.zh;
}

/** Colour as a 0–1 RGB triple, for buffer attributes. */
export function genreRgb(id) {
  const genre = BY_ID.get(String(id)) || BY_ID.get('other');
  const hex = genre.color;
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** CSS colour for a panel chip or a label. */
export function genreCss(id) {
  const genre = BY_ID.get(String(id)) || BY_ID.get('other');
  return `#${genre.color.toString(16).padStart(6, '0')}`;
}

/**
 * Authored tag vocabulary, per genre. Entries may be written the way a human
 * writes them ("R&B", "Hip-Hop"); they are normalised when the rules are built.
 *
 * These lists are deliberately inclusive of the plural/misspelled variants that
 * actually appear in Radio Browser tags. A tag that nobody uses costs nothing;
 * a missing common one costs a whole genre.
 */
const RULE_TAGS = {
  jazz: [
    'jazz', 'jazz music', 'smooth jazz', 'acid jazz', 'vocal jazz', 'latin jazz', 'jazz fusion',
    'bebop', 'bop', 'hard bop', 'big band', 'swing', 'dixieland', 'ragtime', 'cool jazz',
    'free jazz', 'modern jazz', 'nu jazz', 'gypsy jazz', 'jazz standards',
  ],
  rock: [
    'rock', 'rock music', 'classic rock', 'hard rock', 'soft rock', 'alternative rock',
    'alternative', 'indie', 'indie rock', 'punk', 'punk rock', 'post punk', 'metal',
    'heavy metal', 'death metal', 'black metal', 'nu metal', 'grunge', 'garage rock',
    'garage', 'rock and roll', 'rock n roll', 'rockabilly', 'progressive rock', 'prog rock',
    'psychedelic rock', 'psychedelic', 'post rock', 'emo', 'shoegaze', 'britpop', 'surf rock',
    'southern rock', 'stoner rock', 'skate punk', 'hardcore punk', 'new wave',
  ],
  pop: [
    'pop', 'pop music', 'top 40', 'top40', 'hits', 'hit radio', 'charts', 'chart',
    'mainstream', 'easy listening', 'adult contemporary', 'ac', 'oldies', '80s', '90s',
    '70s', '60s', '2000s', 'variety', 'variedades', 'variete', 'pop rock', 'dance pop',
    'synth pop', 'kpop', 'k pop', 'j pop', 'cantopop', 'mandopop', 'schlager',
    'contemporary hits', 'todays hits',
  ],
  classical: [
    'classical', 'classical music', 'klassik', 'klassische musik', 'classica', 'classique',
    'musica clasica', 'clasica', 'musique classique', 'musica classica',
    'opera', 'operetta', 'symphony', 'symphonic', 'baroque', 'chamber music', 'chamber',
    'orchestral', 'orchestra', 'choral', 'choir', 'organ', 'piano', 'concerto', 'sonata',
    'gregorian', 'medieval music', 'renaissance music', 'string quartet',
  ],
  electronic: [
    'electronic', 'electronic music', 'electronica', 'techno', 'house', 'deep house',
    'tech house', 'progressive house', 'trance', 'psytrance', 'edm', 'dance', 'club',
    'club music', 'drum and bass', 'dnb', 'drum n bass', 'dubstep', 'synth', 'synthwave',
    'electro', 'idm', 'breakbeat', 'big beat', 'hardstyle', 'hardcore', 'gabber',
    'minimal', 'future bass', 'chiptune', 'vaporwave', 'trip hop', 'uk garage',
    'ambient techno', 'industrial',
  ],
  'hip-hop': [
    'hip hop', 'hip-hop', 'hiphop', 'rap', 'rap music', 'trap', 'drill', 'grime',
    'gangsta rap', 'g funk', 'boom bap', 'urban', 'urban contemporary', 'crunk',
    'mumble rap', 'east coast rap', 'west coast rap', 'old school rap',
  ],
  ambient: [
    'ambient', 'ambient music', 'chillout', 'chill out', 'chill', 'lounge', 'downtempo',
    'new age', 'meditation', 'relaxation', 'relax', 'sleep', 'soundscape', 'drone',
    'space music', 'atmospheric', 'study music', 'lofi', 'lo fi', 'spa', 'nature sounds',
  ],
  'folk-world': [
    'folk', 'folk music', 'folk rock', 'acoustic', 'acoustic music', 'singer songwriter',
    'country', 'country music', 'bluegrass', 'americana', 'world', 'world music', 'reggae',
    'ska', 'latin', 'salsa', 'cumbia', 'bachata', 'merengue', 'tango', 'flamenco', 'fado',
    'celtic', 'irish', 'gaelic', 'klezmer', 'afrobeat', 'highlife', 'soukous', 'rai',
    'arabic', 'oriental', 'bollywood', 'hindi', 'bhangra', 'enka', 'kayokyoku', 'tropical',
    'sertanejo', 'forro', 'mpb', 'chanson', 'chanson francaise', 'volksmusik', 'ethnic',
    'traditional', 'indigenous', 'world fusion',
  ],
  'blues-soul': [
    'blues', 'blues music', 'delta blues', 'chicago blues', 'rhythm and blues', 'rhythm blues',
    'soul', 'soul music', 'neo soul', 'classic soul', 'northern soul', 'motown', 'funk',
    'rnb', 'r and b', 'gospel', 'doo wop', 'boogie', 'southern soul', 'jazz blues',
  ],
  news: [
    'news', 'news talk', 'newstalk', 'all news', 'radio news', 'news radio', 'noticias',
    'noticia', 'nachrichten', 'actualite', 'actualites', 'notizie', 'informativo',
    'informativos', 'information', 'info', 'infos', 'journalism', 'journal', 'bulletin',
    'press', 'radio info', 'france info', 'newsradio',
  ],
  talk: [
    'talk', 'talk radio', 'talk show', 'talkshow', 'speech', 'spoken word', 'podcast',
    'podcasting', 'podcasts', 'discussion', 'debate', 'interview', 'interviews', 'call in',
    'phone in', 'community', 'culture', 'education', 'politics', 'religion', 'christian',
    'catholic', 'sermon', 'comedy', 'storytelling', 'audiobook', 'lecture', 'opinion',
    'current affairs', 'public radio', 'commentary',
  ],
  sports: [
    'sports', 'sport', 'sports talk', 'sport talk', 'football', 'soccer', 'basketball',
    'baseball', 'nfl', 'nba', 'hockey', 'cricket', 'rugby', 'tennis', 'golf', 'motorsport',
    'formula 1', 'f1', 'boxing', 'mma', 'wrestling', 'olympics', 'esports', 'cycling',
  ],
  other: [],
};

/**
 * Name hints. A station whose tags say nothing may still announce itself as
 * "Jazz Radio" or "News 88". These are matched as whole phrases and score less
 * than a tag, so a single tag always beats a name.
 */
const RULE_NAMES = {
  jazz: ['jazz', 'swing', 'bebop'],
  rock: ['rock', 'metal', 'punk'],
  pop: ['hits', 'pop', 'top 40'],
  classical: ['classic', 'klassik', 'classique', 'opera', 'symphon', 'philharmon'],
  electronic: ['techno', 'trance', 'dance', 'electronic', 'edm', 'house'],
  'hip-hop': ['hip hop', 'hiphop', 'rap', 'rnb'],
  ambient: ['ambient', 'chill', 'lounge', 'relax', 'meditat', 'sleep'],
  'folk-world': ['folk', 'salsa', 'latin', 'reggae', 'celtic', 'country', 'chanson', 'world'],
  'blues-soul': ['blues', 'soul', 'funk', 'motown'],
  news: ['news', 'noticias', 'info', 'nachrichten', 'actualite'],
  talk: ['talk', 'podcast', 'radio show', 'radioshow'],
  sports: ['sport', 'sports', 'football', 'soccer'],
  other: [],
};

/**
 * Normalise one tag or name: lower case, strip accents, spell out `&`, split
 * punctuation into spaces. "Hip-Hop" → "hip hop", "R&B" → "rnb", "Música" →
 * "musica". Purely textual, so it is safe to call on anything.
 */
export function normalizeTag(value) {
  let text = String(value === undefined || value === null ? '' : value).toLowerCase();
  text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // "r&b" is a word, not a conjunction: spell it before the general rule.
  text = text.replace(/r\s*&\s*b/g, 'rnb');
  text = text.replace(/&/g, ' and ');
  text = text.replace(/[^a-z0-9]+/g, ' ');
  return text.trim().replace(/\s+/g, ' ');
}

function buildRules() {
  const rules = new Map();
  for (const genre of GENRES) {
    const tags = Array.from(new Set((RULE_TAGS[genre.id] || []).map(normalizeTag).filter(Boolean)));
    const names = Array.from(new Set((RULE_NAMES[genre.id] || []).map(normalizeTag).filter(Boolean)));
    rules.set(genre.id, {
      exact: new Set(tags),
      // Whole-phrase matching needs the phrase on both sides; a one-letter or
      // two-letter phrase would match everything, so require four characters.
      phrases: tags.filter((tag) => tag.length >= 4),
      names: names.filter((name) => name.length >= 3),
      tagCount: tags.length,
      nameCount: names.length,
    });
  }
  return rules;
}

const RULES = buildRules();

/** Rule sizes, for the validator and for the panel's diagnostics. */
export const GENRE_RULES = Object.freeze(
  Object.fromEntries(
    GENRES.map((genre) => [
      genre.id,
      Object.freeze({
        tags: (RULE_TAGS[genre.id] || []).length,
        names: (RULE_NAMES[genre.id] || []).length,
      }),
    ]),
  ),
);

function padded(text) {
  return ` ${text} `;
}

/** True when `phrase` appears as whole words inside the normalised `text`. */
function hasPhrase(phrase, text) {
  return padded(text).includes(` ${phrase} `);
}

function firstPhrase(phrases, text) {
  for (const phrase of phrases) if (hasPhrase(phrase, text)) return phrase;
  return null;
}

/**
 * Weak evidence of last resort: the eight-bucket taxonomy already on the
 * record. Only consulted when the tags and the name yielded nothing at all —
 * a record without tags (the deterministic mock catalogue, or a real station
 * that arrived untagged) still has this field.
 *
 * `music` and `other` are deliberately absent: they say nothing about which
 * genre the station belongs to, so a record that only says "music" honestly
 * lands in Other instead of being invented into a genre.
 */
const CATEGORY_GENRES = Object.freeze({
  jazz: 'jazz',
  news: 'news',
  talk: 'talk',
  classical: 'classical',
  electronic: 'electronic',
  world: 'folk-world',
  ambient: 'ambient',
});

const CATEGORY_WEIGHT = 2;

/**
 * The tags of a station, normalised, deduplicated and sorted.
 *
 * Sorting makes the score and the recorded evidence independent of the order
 * the API listed the tags in — the same row always classifies identically.
 */
export function tagsOf(station) {
  const source = station || {};
  let raw = source.tags;
  if (raw === undefined && source.metadata && Array.isArray(source.metadata.tags)) {
    raw = source.metadata.tags.join(',');
  }
  if (raw === undefined && source.metadata && typeof source.metadata.tags === 'string') {
    raw = source.metadata.tags;
  }
  const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(',');
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    for (const part of String(entry).split(/[,;|/]/)) {
      const tag = normalizeTag(part);
      if (tag.length < 2 || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  out.sort();
  return out;
}

/**
 * Classify one record.
 *
 * @returns {{id, score, matched, evidence}} `matched` is false only when the
 * record fell through to Other, which is the signal the panel shows.
 */
export function classifyGenre(station) {
  const tags = tagsOf(station);
  const name = normalizeTag(station && station.name);
  const paddedName = name.length > 0 ? padded(name) : '';

  let best = null;
  for (const genre of GENRES) {
    if (genre.id === 'other') continue;
    const rule = RULES.get(genre.id);
    let score = 0;
    let evidence = null;

    for (const tag of tags) {
      if (rule.exact.has(tag)) {
        score += 3;
        if (!evidence) evidence = `tag:${tag}`;
      } else {
        const phrase = firstPhrase(rule.phrases, tag);
        if (phrase) {
          score += 1;
          if (!evidence) evidence = `tag~${phrase}`;
        }
      }
    }

    if (paddedName && rule.names.length > 0) {
      const phrase = firstPhrase(rule.names, paddedName.trim());
      if (phrase) {
        score += 1;
        if (!evidence) evidence = `name~${phrase}`;
      }
    }

    if (score <= 0) continue;
    // Score first, tier second: content genres win near-ties, a clearly better
    // music match still wins outright. Ties beyond that keep the fixed order.
    const rank = score * 10 + genre.tier;
    if (best === null || rank > best.rank) {
      best = { id: genre.id, score, rank, evidence };
    }
  }

  if (best === null) {
    // Nothing in the tags or the name. Fall back to the taxonomy buckets the
    // record already carries, at a weight that cannot outrank a real tag.
    const categories = Array.isArray(station && station.categories) ? station.categories : [];
    for (const category of categories) {
      const genreId = CATEGORY_GENRES[String(category)];
      if (!genreId) continue;
      const genre = BY_ID.get(genreId);
      if (!genre) continue;
      const rank = CATEGORY_WEIGHT * 10 + genre.tier;
      if (best === null || rank > best.rank) {
        best = { id: genreId, score: CATEGORY_WEIGHT, rank, evidence: `category:${category}` };
      }
    }
  }

  if (best === null) {
    return { id: 'other', score: 0, matched: false, evidence: null };
  }
  return { id: best.id, score: best.score, matched: true, evidence: best.evidence };
}

/** The genre id for one record, `other` when nothing matched. */
export function genreFor(station) {
  return classifyGenre(station).id;
}

/** The genre id already attached to a record, or `other`. */
export function genreOf(station) {
  const id = station && station.genre;
  return typeof id === 'string' && BY_ID.has(id) ? id : 'other';
}

/**
 * Attach `genre` to a record once, idempotently.
 *
 * The result is written on the record (`genre`, `genres`) and mirrored under
 * `metadata` for the panel. Raw tags stay untouched.
 */
export function attachGenre(station) {
  if (!station || typeof station !== 'object') return 'other';
  if (typeof station.genre === 'string' && BY_ID.has(station.genre)) return station.genre;

  const result = classifyGenre(station);
  station.genre = result.id;
  // One primary genre in this version. The array exists so a later phase can
  // add secondary genres without changing the record shape.
  station.genres = [result.id];
  if (!station.metadata || typeof station.metadata !== 'object') station.metadata = {};
  station.metadata.genre = result.id;
  station.metadata.genreMatched = result.matched;
  station.metadata.genreScore = result.score;
  station.metadata.genreEvidence = result.evidence;
  return result.id;
}

/**
 * Resolve a raw genre id to the group it is *displayed* in.
 *
 * Small genres fold into Other; everything else stands for itself. This is a
 * display decision only: the record keeps its true genre.
 */
export function displayGenreId(rawId, merged) {
  const id = String(rawId || 'other');
  if (id === 'other') return 'other';
  return Array.isArray(merged) && merged.includes(id) ? 'other' : id;
}

/**
 * Count the current sample and decide what the nebula space may show.
 *
 * Everything here is derived from the stations actually loaded — it is a
 * statement about this sample, never about the Radio Browser database.
 *
 * @returns {{total, raw, visible, merged, hidden, other, displayTotal}}
 *   `raw`    — the 13 genres in fixed order, with this sample's count.
 *   `visible`— the display groups that will become nebulae, fixed order.
 *   `merged` — raw genres folded into Other for being too small to show.
 *   `hidden` — raw genres with no station at all in this sample.
 *   `other`  — the Other group's composition (raw count + merged count).
 */
export function summarizeGenres(stations) {
  const list = Array.isArray(stations) ? stations : [];
  const counts = new Map(GENRE_IDS.map((id) => [id, 0]));

  for (const station of list) {
    const id = genreOf(station);
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const raw = GENRES.map((genre) => ({
    id: genre.id,
    zh: genre.zh,
    en: genre.en,
    group: genre.group,
    color: genre.color,
    count: counts.get(genre.id) || 0,
  }));

  const merged = raw.filter((entry) => entry.id !== 'other' && entry.count > 0 && entry.count < MIN_GENRE_STATIONS).map((entry) => entry.id);
  const hidden = raw.filter((entry) => entry.id !== 'other' && entry.count === 0).map((entry) => entry.id);

  const groupCounts = new Map();
  for (const station of list) {
    const group = displayGenreId(genreOf(station), merged);
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
  }

  const visible = GENRES.filter((genre) => (groupCounts.get(genre.id) || 0) > 0).map((genre) => ({
    id: genre.id,
    zh: genre.zh,
    en: genre.en,
    group: genre.group,
    color: genre.color,
    count: groupCounts.get(genre.id) || 0,
    mergedIds: merged.filter((id) => displayGenreId(id, merged) === genre.id),
  }));

  const otherRaw = counts.get('other') || 0;
  const mergedTotal = merged.reduce((sum, id) => sum + (counts.get(id) || 0), 0);

  return {
    total: list.length,
    raw,
    visible,
    merged,
    hidden,
    other: { raw: otherRaw, merged: mergedTotal, total: otherRaw + mergedTotal },
    displayTotal: visible.reduce((sum, group) => sum + group.count, 0),
  };
}
