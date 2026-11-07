/**
 * Radio Browser record → station record.
 *
 * This module is the whole difference between the API and the catalogue the
 * scene already consumes. It is deliberately pure: no fetch, no clock, no
 * randomness. Given the same API page it returns the same records, so the
 * mapping can be tested offline against a captured response.
 *
 * What the scene needs, and what a Radio Browser row cannot always supply:
 *
 *   id            ← stationuuid, the API's own stable key (stable across
 *                   restarts and across users; `changeuuid` is not).
 *   streamUrl     ← url_resolved, falling back to url. This is the field the
 *                   playback phase will read; nothing here connects to it.
 *   categories    ← the eight authored buckets, inferred from `tags` and, when
 *                   the tags are silent, from the station name.
 *   name, country, language, description
 *
 * Rows that cannot produce a usable record are dropped, never repaired with
 * invented data: a real station with a fabricated stream URL would be worse
 * than a missing station.
 */

import { CATEGORIES } from './taxonomy.js';
import { countryName, languageName, regionForLanguage } from './countries.js';

/**
 * Tag/keyword rules: bucket id → patterns tried against the lower-cased tags
 * (matched as whole tags) and against the lower-cased station name (matched as
 * substrings). Order matters: the first bucket with a hit becomes the primary
 * category, and the station keeps up to two.
 *
 * Only `CATEGORIES` ids may appear here; the layout keys its clouds by them.
 */
const RULES = [
  {
    id: 'news',
    tags: ['news', 'talk radio', 'info', 'informação', 'nachrichten', 'actualité', 'noticias', 'nouvelles'],
    names: ['news', 'noticias', 'informativos', 'nachrichten', 'france info', 'radio info'],
  },
  {
    id: 'classical',
    tags: ['classical', 'klassik', 'klassische musik', 'classica', 'classique', 'opéra', 'opera', 'symphony', 'baroque'],
    names: ['classic', 'klassik', 'classique', 'opera', 'symphon'],
  },
  {
    id: 'jazz',
    tags: ['jazz', 'swing', 'bebop', 'bossa nova', 'blues', 'soul', 'funk'],
    names: ['jazz', 'swing', 'blues'],
  },
  {
    id: 'electronic',
    tags: ['electronic', 'techno', 'house', 'trance', 'edm', 'dance', 'drum and bass', 'dnb', 'dubstep', 'ambient techno', 'synth'],
    names: ['techno', 'trance', 'drum and bass', 'dance', 'electronic', 'edm'],
  },
  {
    id: 'ambient',
    tags: ['ambient', 'chillout', 'chill', 'lounge', 'meditation', 'sleep', 'new age', 'downtempo', 'soundscape', 'relax'],
    names: ['ambient', 'chill', 'lounge', 'relax', 'meditat', 'sleep'],
  },
  {
    id: 'world',
    tags: ['world', 'world music', 'folk', 'country', 'reggae', 'salsa', 'latin', 'cumbia', 'afrobeat', 'klezmer', 'flamenco', 'celtic', 'bollywood', 'enka', 'kayokyoku', 'tropical', 'sertanejo', 'mpb', 'chanson', 'schlager', 'volksmusik', 'música popular'],
    names: ['folk', 'salsa', 'latin', 'reggae', 'celtic', 'volksmusik', 'schlager', 'chanson'],
  },
  {
    id: 'talk',
    tags: ['talk', 'podcast', 'speech', 'comedy', 'community', 'culture', 'education', 'politics', 'interview', 'debate', 'religion', 'christian', 'catholic', 'gospel', 'sports', 'sport'],
    names: ['talk', 'podcast', 'radioshow', 'radio show'],
  },
  {
    id: 'music',
    tags: ['music', 'pop', 'rock', 'hits', 'top 40', 'oldies', '80s', '90s', '70s', '60s', 'indie', 'alternative', 'metal', 'hip hop', 'rap', 'r&b', 'country music', 'generalist', 'généraliste', 'general', 'variedades', 'variety', 'easy listening', 'adult contemporary', 'ac', 'schlager', 'volksmusik', 'música', 'musik', 'musique'],
    names: ['hits', 'radio', 'fm', 'music', 'pop', 'rock', 'mix'],
  },
];

const RULES_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));
/** Every bucket id, so a record can never carry an id the layout cannot place. */
const VALID_IDS = new Set(CATEGORIES.map((category) => category.id));

/** Codecs the browser can feed an <audio> element in the playback phase. */
const PLAYABLE_CODECS = new Set(['mp3', 'aac', 'aac+', 'aacp', 'he-aac', 'ogg', 'vorbis', 'opus', 'flac', 'wav', 'mpeg']);

/**
 * Categories for one record.
 *
 * Tags win. A record whose tags say nothing falls back to the name, then to
 * `music` when the record did not even claim that much — the station is real,
 * only its classification is a default, and nothing pretends otherwise.
 *
 * @returns {{categories: string[], matched: boolean}}
 */
export function categoriesFor(station) {
  const tags = String(station.tags || '')
    .toLowerCase()
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const name = String(station.name || '').toLowerCase();
  const hits = [];

  for (const [index, rule] of RULES.entries()) {
    let score = 0;
    for (const tag of tags) {
      if (rule.tags.includes(tag)) score += 2;
      else if (rule.tags.some((pattern) => pattern.length > 4 && tag.includes(pattern))) score += 1;
    }
    if (rule.names.some((pattern) => name.includes(pattern))) score += 1;
    if (score > 0) hits.push({ id: rule.id, score, index });
  }

  if (hits.length === 0) return { categories: ['music'], matched: false };

  // High score first; on a tie the earlier rule wins, so classification is
  // deterministic for a given row.
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  const categories = [];
  for (const hit of hits) {
    if (categories.length >= 2) break;
    if (!categories.includes(hit.id)) categories.push(hit.id);
  }
  return { categories, matched: true };
}

/** True when a string is an absolute http(s) stream URL. */
export function isStreamUrl(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 8 || text.length > 2048) return false;
  if (/\s/.test(text)) return false;
  const lower = text.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

/** Pick the playback address: resolved first, then the raw URL. */
export function streamUrlFor(station) {
  const resolved = resolveAddress(station);
  return resolved ? resolved.url : null;
}

/** The chosen address together with the field it came from. */
function resolveAddress(station) {
  if (isStreamUrl(station.url_resolved)) return { url: station.url_resolved.trim(), source: 'url_resolved' };
  if (isStreamUrl(station.url)) return { url: station.url.trim(), source: 'url' };
  return null;
}

/** A readable name, or null when the API row has none. */
function nameFor(station) {
  const raw = String(station.name || station.name_fallback || '')
    .replace(/\s+/g, ' ')
    .trim();
  return raw.length > 0 ? raw.slice(0, 120) : null;
}

function codeForLanguage(station) {
  const listed = String(station.languagecodes || '')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
  if (listed.length > 0) return listed[0];
  const named = String(station.language || '')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
  if (named.length > 0 && /^[a-z]{2,3}$/.test(named[0])) return named[0];
  return '';
}

function codeForCountry(station) {
  const code = String(station.countrycode || '')
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  return '';
}

/**
 * Describe a record the way the detail panel shows it.
 *
 * The description is built from the record's own fields — country, language,
 * codec and bitrate — never invented prose. An unknown bitrate is simply left
 * out rather than rendered as "0 kbps".
 */
function describe(station, country, language) {
  const parts = { zh: [], en: [] };
  if (country.en) {
    parts.zh.push(country.zh);
    parts.en.push(country.en);
  }
  if (language.en) {
    parts.zh.push(language.zh);
    parts.en.push(language.en);
  }
  const codec = String(station.codec || '').trim();
  const bitrate = Number(station.bitrate);
  if (codec) {
    const quality = Number.isFinite(bitrate) && bitrate > 0 ? `${codec} ${bitrate} kbps` : codec;
    parts.zh.push(quality);
    parts.en.push(quality);
  }
  const hls = Number(station.hls) === 1;
  if (hls) {
    parts.zh.push('HLS 流');
    parts.en.push('HLS stream');
  }
  const tags = String(station.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 4);
  if (tags.length > 0) {
    parts.zh.push(`标签：${tags.join(' / ')}`);
    parts.en.push(`Tags: ${tags.join(' / ')}`);
  }
  return {
    zh: parts.zh.join(' · ') || '真实电台',
    en: parts.en.join(' · ') || 'Live station',
  };
}

/**
 * Convert one API row into a station record.
 *
 * The returned record has the same shape the mock generator produces, plus
 * `streamUrl` and the raw API facts under `metadata.real`. `position`,
 * `metadata.layout` and `metadata.clouds` are left to `assignPositions`, exactly
 * as for mock records — the layout is owned by one module, not by the source.
 *
 * @param row - one Radio Browser station object.
 * @param getIndex - the stable index this record has in the merged catalogue.
 * @returns station record, or null when the row cannot be used.
 */
export function mapStation(row, getIndex) {
  if (!row || typeof row !== 'object') return null;

  const id = String(row.stationuuid || '').trim();
  if (id.length === 0) return null;

  const name = nameFor(row);
  if (!name) return null;

  const address = resolveAddress(row);
  if (!address) return null;
  const streamUrl = address.url;

  const languageCode = codeForLanguage(row);
  const countryCode = codeForCountry(row) || regionForLanguage(languageCode);
  const country = countryName(countryCode);
  const language = languageName(languageCode);
  const classification = categoriesFor(row);
  const index = typeof getIndex === 'function' ? getIndex(id) : 0;

  const codec = String(row.codec || '').trim().toLowerCase();
  const playable = codec.length === 0 || PLAYABLE_CODECS.has(codec);

  return {
    id,
    name,
    country,
    language,
    categories: classification.categories,
    description: describe(row, country, language),
    isFeatured: false,
    position: null,
    streamUrl,
    metadata: {
      demo: false,
      source: 'radio-browser',
      index,
      region: null,
      orbit: null,
      primaryCategory: classification.categories[0],
      countryCode: countryCode || null,
      languageCode: languageCode || null,
      tags: String(row.tags || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12),
      homepage: isStreamUrl(row.homepage) ? row.homepage.trim() : null,
      favicon: isStreamUrl(row.favicon) ? row.favicon.trim() : null,
      codec: codec.length > 0 ? codec : null,
      bitrate: Number.isFinite(Number(row.bitrate)) && Number(row.bitrate) > 0 ? Number(row.bitrate) : 0,
      hls: Number(row.hls) === 1,
      playable,
      // Which of the two addresses supplied `streamUrl`: `url_resolved`,
      // `url`, or `original-url` when the API row and the pre-mapped cache
      // disagree — the cache wins there, so the addresses stay aligned.
      streamSource: address.source,
      votes: Number(row.votes) || 0,
      clickcount: Number(row.clickcount) || 0,
      lastCheckOk: row.lastcheckok === undefined ? null : Number(row.lastcheckok) === 1,
      categoryMatched: classification.matched,
      changeuuid: String(row.changeuuid || '') || null,
    },
  };
}

/**
 * Map a whole API page, dropping unusable rows.
 *
 * @returns {{stations: Array, dropped: number, duplicateIds: number}}
 */
export function mapStations(rows) {
  const stations = [];
  const seen = new Set();
  let dropped = 0;
  let duplicateIds = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const station = mapStation(row, () => stations.length);
    if (!station) {
      dropped += 1;
      continue;
    }
    if (seen.has(station.id)) {
      duplicateIds += 1;
      continue;
    }
    seen.add(station.id);
    stations.push(station);
  }

  return { stations, dropped, duplicateIds };
}

/** Exported for tests and for the panel's diagnostics. */
export const MAPPING = Object.freeze({
  codecs: Array.from(PLAYABLE_CODECS),
  buckets: Array.from(VALID_IDS),
  rules: RULES.map((rule) => ({ id: rule.id, tags: rule.tags.length, names: rule.names.length })),
});
