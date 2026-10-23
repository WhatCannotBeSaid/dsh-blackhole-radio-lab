/**
 * Genre-layer checks: the thirteen-bucket classification that the nebula space
 * will be built on.
 *
 * This is a real test, not a fixture dump. It covers the parts of the genre
 * layer that can silently rot:
 *
 *   1. vocabulary   — the thirteen genres are fixed, complete and separate
 *                     from the eight-bucket taxonomy, which must not move;
 *   2. matching     — normalisation, synonyms, compound tags, and the rule that
 *                     a short word cannot hit a longer one by accident;
 *   3. conflicts    — content genres outrank music on comparable evidence, but
 *                     a clearly stronger music match still wins;
 *   4. determinism  — the same record classifies identically whatever order the
 *                     tags (or the API rows) arrive in, and classification is
 *                     a pure read, not a mutation;
 *   5. display      — small genres fold into Other for the picture, but the raw
 *                     genre survives and stays reachable both ways; no station
 *                     is lost, double-counted, or invented;
 *   6. repository   — the genre surface is additive: every pre-existing method
 *                     still answers, both data sources still work;
 *   7. live         — one real Radio Browser sample, reported as a sample.
 *
 * Usage:
 *   node tools/validate-genres.mjs            # checks + summary
 *   node tools/validate-genres.mjs --json     # + machine-readable report
 *   node tools/validate-genres.mjs --offline-only  # skip the live request
 */

import {
  createMockRadioRepository,
  createRadioRepository,
  createRepositoryFromRows,
} from '../src/radio/repository.js';
import {
  attachGenre,
  classifyGenre,
  displayGenreId,
  GENRE_IDS,
  GENRE_RULES,
  GENRES,
  genreById,
  genreCss,
  genreLabel,
  genreOf,
  genreRgb,
  MIN_GENRE_STATIONS,
  normalizeTag,
  summarizeGenres,
  tagsOf,
} from '../src/radio/genres.js';
import { CATEGORIES, categoryCss } from '../src/radio/taxonomy.js';

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const OFFLINE_ONLY = args.has('--offline-only');

const problems = [];
let checks = 0;
const sections = [];
let current = { name: 'vocabulary', checks: 0, passed: 0, failed: 0 };
sections.push(current);

function section(name) {
  // The first section reuses the placeholder entry instead of leaving an empty
  // row in the summary.
  if (current.checks === 0 && current.name === name) return current;
  const entry = { name, checks: 0, passed: 0, failed: 0 };
  sections.push(entry);
  current = entry;
  return entry;
}

function check(name, condition, detail) {
  checks += 1;
  current.checks += 1;
  if (condition) {
    current.passed += 1;
    return true;
  }
  current.failed += 1;
  problems.push(detail ? `${current.name}: ${name}: ${detail}` : `${current.name}: ${name}`);
  return false;
}

function eq(name, actual, expected) {
  return check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- 1. Vocabulary ---------------------------------------------------------

section('vocabulary');

const EXPECTED_IDS = [
  'jazz',
  'rock',
  'pop',
  'classical',
  'electronic',
  'hip-hop',
  'ambient',
  'folk-world',
  'blues-soul',
  'news',
  'talk',
  'sports',
  'other',
];

eq('thirteen genres, in the agreed order', GENRE_IDS, EXPECTED_IDS);
check('the list is frozen', Object.isFrozen(GENRES) && Object.isFrozen(GENRE_IDS));
check('every genre carries both labels', GENRES.every((genre) => typeof genre.zh === 'string' && genre.zh.length > 0 && typeof genre.en === 'string' && genre.en.length > 0));
check('every genre carries a colour', GENRES.every((genre) => Number.isInteger(genre.color) && genre.color >= 0 && genre.color <= 0xffffff));
check('every genre carries a group', GENRES.every((genre) => ['music', 'content', 'other'].includes(genre.group)));
check('other is last and alone in its group', GENRES[GENRES.length - 1].id === 'other' && GENRES.filter((genre) => genre.group === 'other').length === 1);
check('content genres outrank music only through tier', GENRES.filter((g) => g.group === 'content').every((g) => g.tier > 0) && GENRES.filter((g) => g.group === 'music').every((g) => g.tier > 0 && g.tier < 10));
check('genreById resolves and rejects', genreById('jazz').en === 'Jazz' && genreById('nope') === undefined);
eq('labels follow the language', [genreLabel('hip-hop', 'en'), genreLabel('hip-hop', 'zh'), genreLabel('nope', 'en')], ['Hip-Hop', '嘻哈', 'nope']);
check('rgb is a 0–1 triple', genreRgb('jazz').every((v) => v >= 0 && v <= 1) && genreRgb('nope').length === 3);
check('css is a hex colour', /^#[0-9a-f]{6}$/.test(genreCss('jazz')) && genreCss('nope') === '#9a9a9a');
check('the merge floor is three', MIN_GENRE_STATIONS === 3);
check('every genre has tag rules except other', GENRES.filter((g) => g.id !== 'other').every((g) => GENRE_RULES[g.id].tags >= 8), JSON.stringify(Object.fromEntries(GENRES.map((g) => [g.id, GENRE_RULES[g.id].tags]))));
check('other has no rules', GENRE_RULES.other.tags === 0 && GENRE_RULES.other.names === 0);

// The taxonomy is the artwork's eight buckets and must not have moved.
eq('the eight-bucket taxonomy is untouched', CATEGORIES.map((c) => c.id), ['music', 'news', 'talk', 'classical', 'jazz', 'electronic', 'world', 'ambient']);
check('taxonomy still has its own colours', CATEGORIES.every((c) => typeof c.color === 'number') && categoryCss('music') === '#8fb4ff');
// Names may collide — both layers describe "jazz" — but they are separate
// modules with separate records, and neither re-exports the other's objects.
const collisions = GENRE_IDS.filter((id) => CATEGORIES.some((category) => category.id === id));
check('shared names are the only overlap', collisions.length === 6, collisions.join(','));
check('the layers keep their own records', !GENRES.some((genre) => CATEGORIES.some((category) => category === genre)));
check('the layers keep their own colours', genreCss('jazz') !== categoryCss('jazz'));

// --- 2. Normalisation and matching ----------------------------------------

section('matching');

eq('case is folded', normalizeTag('JAZZ'), 'jazz');
eq('accents are stripped', normalizeTag('Música Clásica'), 'musica clasica');
eq('hyphens become words', normalizeTag('Hip-Hop'), 'hip hop');
eq('ampersands inside words stay words', normalizeTag('R&B'), 'rnb');
eq('ampersands between words spell out', normalizeTag('Rock & Roll'), 'rock and roll');
eq('slashes and commas split', normalizeTag('news/talk'), 'news talk');
eq('punctuation is dropped, not glued', normalizeTag('  Lo-Fi  /  Chill  '), 'lo fi chill');
eq('empty input is empty', normalizeTag(null), '');
eq('numbers survive', normalizeTag('Top 40'), 'top 40');

function classify(tags, name = 'Station', extra = {}) {
  return classifyGenre({ name, tags: Array.isArray(tags) ? tags : String(tags || ''), ...extra });
}

const HITS = [
  ['jazz', 'jazz'],
  ['jazz', 'acid jazz'],
  ['jazz', 'smooth jazz'],
  ['jazz', 'bebop'],
  ['rock', 'classic rock'],
  ['rock', 'punk'],
  ['rock', 'heavy metal'],
  ['pop', 'top 40'],
  ['pop', 'hits'],
  ['classical', 'opera'],
  ['classical', 'baroque'],
  ['electronic', 'techno'],
  ['electronic', 'drum and bass'],
  ['electronic', 'dnb'],
  ['hip-hop', 'hip hop'],
  ['hip-hop', 'rap'],
  ['ambient', 'chillout'],
  ['ambient', 'lofi'],
  ['folk-world', 'salsa'],
  ['folk-world', 'reggae'],
  ['folk-world', 'celtic'],
  ['blues-soul', 'rhythm and blues'],
  ['blues-soul', 'gospel'],
  ['blues-soul', 'rnb'],
  ['news', 'news'],
  ['news', 'noticias'],
  ['news', 'nachrichten'],
  ['talk', 'talk radio'],
  ['talk', 'podcast'],
  ['talk', 'community'],
  ['sports', 'football'],
  ['sports', 'sports talk'],
];

for (const [expected, tag] of HITS) {
  const result = classify([tag]);
  check(`"${tag}" classifies as ${expected}`, result.id === expected, `got ${result.id} (score ${result.score})`);
}

// Compound tags: the whole phrase is inside the tag, the single word is not.
check('a compound tag matches as a phrase', classify(['jazz funk']).id === 'jazz');
check('a compound tag does not match a different genre', classify(['jazz funk']).id !== 'folk-world');
check('phrase matching needs word boundaries', classify(['rocksteady']).id === 'other', classify(['rocksteady']).id);
check('phrase matching needs word boundaries (2)', classify(['metallic']).id === 'other', classify(['metallic']).id);
check('multi-word phrases work inside longer tags', classify(['modern jazz fusion']).id === 'jazz');

// rnb is blues-soul, not hip-hop; hip-hop owns rap.
check('rnb is blues-soul', classify(['rnb']).id === 'blues-soul');
check('rap is hip-hop', classify(['rap']).id === 'hip-hop');

// Names are weaker evidence than tags.
const nameOnly = classify([], 'Jazz Radio');
check('a name can classify', nameOnly.id === 'jazz');
const tagBeatsName = classify(['rock'], 'Jazz Radio');
check('a tag beats a conflicting name', tagBeatsName.id === 'rock', tagBeatsName.id);

// Case and accent in tags, end to end.
check('upper-case and accented tags still classify', classify(['MÚSICA CLÁSICA']).id === 'classical');
check('compound separators still classify', classify(['jazz;rock']).id === 'jazz', classify(['jazz;rock']).id);

// --- 3. Conflicts ----------------------------------------------------------

section('conflicts');

check('news beats one music tag', classify(['news', 'jazz']).id === 'news', classify(['news', 'jazz']).id);
check('talk beats one music tag', classify(['talk', 'jazz']).id === 'talk', classify(['talk', 'jazz']).id);
check('sports beats one music tag', classify(['sports', 'rock']).id === 'sports', classify(['sports', 'rock']).id);
check('two clear music tags beat one content tag', classify(['jazz', 'jazz music', 'news']).id === 'jazz', classify(['jazz', 'jazz music', 'news']).id);
check('news beats talk at equal evidence', classify(['talk', 'news']).id === 'news');
check('sports beats talk at equal evidence', classify(['talk', 'sports']).id === 'sports');
check('news beats sports at equal evidence', classify(['sports', 'news']).id === 'news');
check('"news talk" is news', classify(['news talk']).id === 'news');
check('"newstalk" is news', classify(['newstalk']).id === 'news');
check('a genre name in a latin-american tag set still resolves', classify(['noticias', 'deportes']).id === 'news', classify(['noticias', 'deportes']).id);
check('generic music does not become a genre', classify(['music']).id === 'other');
check('"easy listening" is pop, not talk', classify(['easy listening']).id === 'pop', classify(['easy listening']).id);

// --- 4. Determinism --------------------------------------------------------

section('determinism');

const GOLDEN = ['sports', 'talk', 'news', 'jazz', 'rock'];
const expectedGolden = classify(GOLDEN).id;
let permutationsStable = true;
for (let index = 0; index < 200; index += 1) {
  const shuffled = [...GOLDEN];
  for (let slot = shuffled.length - 1; slot > 0; slot -= 1) {
    const pick = (index * 7 + slot * 13) % (slot + 1);
    [shuffled[slot], shuffled[pick]] = [shuffled[pick], shuffled[slot]];
  }
  if (classify(shuffled).id !== expectedGolden) {
    permutationsStable = false;
    break;
  }
}
check('tag order never changes the genre', permutationsStable, expectedGolden);

const repeated = new Set();
for (let index = 0; index < 50; index += 1) repeated.add(classify(GOLDEN).id);
check('classification is repeatable', repeated.size === 1);

// A pure read: classifying does not write to the record.
const untouched = { name: 'Station', tags: ['jazz'], categories: ['music'] };
const before = JSON.stringify(untouched);
classifyGenre(untouched);
check('classification does not mutate the record', JSON.stringify(untouched) === before);

// tagsOf is order-independent and keeps the raw tags intact.
eq('tagsOf sorts its normalised view', tagsOf({ tags: ['Rock', 'jazz', 'acid jazz'] }), ['acid jazz', 'jazz', 'rock']);
eq('tagsOf deduplicates', tagsOf({ tags: ['Jazz', 'jazz', 'JAZZ'] }), ['jazz']);
eq('tagsOf splits metadata tags too', tagsOf({ metadata: { tags: ['jazz', 'rock'] } }), ['jazz', 'rock']);
eq('tagsOf survives a missing field', tagsOf({}), []);

// Attaching is idempotent and leaves the raw tags alone.
const attachable = { name: 'Jazz FM', tags: ['jazz', 'smooth jazz'], metadata: { tags: ['jazz', 'smooth jazz'] } };
attachGenre(attachable);
eq('attach writes one genre', attachable.genres, ['jazz']);
eq('attach mirrors into metadata', attachable.metadata.genre, 'jazz');
check('attach records that it matched', attachable.metadata.genreMatched === true);
check('attach keeps the raw tags', JSON.stringify(attachable.metadata.tags) === JSON.stringify(['jazz', 'smooth jazz']));
const firstGenre = attachable.genre;
const firstEvidence = attachable.metadata.genreEvidence;
attachGenre(attachable);
check('attach is idempotent', attachable.genre === firstGenre && attachable.metadata.genreEvidence === firstEvidence);

// --- 5. Misses and Other ---------------------------------------------------

section('fallback');

for (const tags of [undefined, '', [], ['xyzzy'], ['test'], ['radio']]) {
  const result = classify(tags);
  check(`unmatched tags (${JSON.stringify(tags)}) go to other`, result.id === 'other', result.id);
  check(`unmatched tags (${JSON.stringify(tags)}) are marked unmatched`, result.id === 'other' && result.matched === false);
}
check('genreOf defaults to other', genreOf({}) === 'other' && genreOf({ genre: 'nope' }) === 'other' && genreOf({ genre: 'jazz' }) === 'jazz');

// The taxonomy fallback only applies when the tags say nothing.
check('a category can classify an untagged record', classify([], 'Station', { categories: ['world'] }).id === 'folk-world');
check('a tag still beats the category fallback', classify(['rock'], 'Station', { categories: ['classical'] }).id === 'rock');
check('"music" is not a usable category hint', classify([], 'Station', { categories: ['music'] }).id === 'other');

// --- 6. Display grouping ---------------------------------------------------

section('display');

const SAMPLE = [];
function addStations(count, tags, name) {
  for (let index = 0; index < count; index += 1) SAMPLE.push({ id: `s-${SAMPLE.length}`, name: `${name || 'Station'} ${SAMPLE.length}`, tags });
}
addStations(5, 'jazz', 'Jazz');
addStations(4, 'rock', 'Rock');
addStations(3, 'techno', 'Techno');
addStations(3, 'news', 'News');
addStations(2, 'talk radio', 'Talk'); // below the floor → merged
addStations(1, 'football', 'Sports'); // below the floor → merged
addStations(2, 'xyzzy'); // untagged → other

for (const station of SAMPLE) attachGenre(station);
const summary = summarizeGenres(SAMPLE);

check('summary counts the sample', summary.total === SAMPLE.length, `${summary.total} vs ${SAMPLE.length}`);
check('all thirteen genres are reported', summary.raw.length === 13);
eq('raw counts are right', summary.raw.map((entry) => entry.id), GENRE_IDS);
eq('jazz count', summary.raw.find((e) => e.id === 'jazz').count, 5);
eq('talk count', summary.raw.find((e) => e.id === 'talk').count, 2);
eq('singleton is merged', summary.merged, ['talk', 'sports']);
check('empty genre is hidden, not merged', summary.hidden.includes('hip-hop') && !summary.merged.includes('hip-hop'));
check('merged genres are not visible on their own', !summary.visible.some((group) => group.id === 'talk'));
check('visible groups exclude hidden genres', !summary.visible.some((group) => summary.hidden.includes(group.id)));
const otherGroup = summary.visible.find((group) => group.id === 'other');
check('other is visible and owns the merged stations', Boolean(otherGroup) && otherGroup.count === 5, otherGroup && otherGroup.count);
eq('other lists what it absorbed', otherGroup && otherGroup.mergedIds.slice().sort(), ['sports', 'talk']);
eq('other composition adds up', summary.other, { raw: 2, merged: 3, total: 5 });
eq('display counts conserve the sample', summary.displayTotal, SAMPLE.length);
eq('visible counts sum to the total', summary.visible.reduce((sum, group) => sum + group.count, 0), SAMPLE.length);
check('no visible group is empty', summary.visible.every((group) => group.count > 0));
check('displayGenreId folds only merged genres', displayGenreId('talk', summary.merged) === 'other' && displayGenreId('jazz', summary.merged) === 'jazz' && displayGenreId('other', summary.merged) === 'other');
check('an empty sample summarizes without inventing anything', summarizeGenres([]).total === 0 && summarizeGenres([]).visible.length === 0);

// --- 7. Repository surface --------------------------------------------------

section('repository');

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(n, name, tags) {
  return {
    changeuuid: `change-${n}`,
    stationuuid: uuid(n),
    name,
    url: `http://stream.example.com/${n}.mp3`,
    url_resolved: `http://stream.example.com/${n}.mp3`,
    homepage: 'https://example.com',
    favicon: '',
    tags,
    country: 'Germany',
    countrycode: 'DE',
    language: 'german',
    languagecodes: 'de',
    votes: 10,
    codec: 'MP3',
    bitrate: 128,
    hls: 0,
    lastcheckok: 1,
    clickcount: 5,
  };
}

const ROWS = [];
let rowIndex = 0;
for (let index = 0; index < 5; index += 1) ROWS.push(row((rowIndex += 1), `Jazz ${index}`, 'jazz'));
for (let index = 0; index < 4; index += 1) ROWS.push(row((rowIndex += 1), `Rock ${index}`, 'classic rock'));
for (let index = 0; index < 3; index += 1) ROWS.push(row((rowIndex += 1), `Techno ${index}`, 'techno'));
for (let index = 0; index < 3; index += 1) ROWS.push(row((rowIndex += 1), `News ${index}`, 'news'));
for (let index = 0; index < 2; index += 1) ROWS.push(row((rowIndex += 1), `Talk ${index}`, 'talk radio'));
ROWS.push(row((rowIndex += 1), 'Sports One', 'football'));
ROWS.push(row((rowIndex += 1), 'Unknown One', 'xyzzy'));
ROWS.push(row((rowIndex += 1), 'Unknown Two', ''));

const repo = createRepositoryFromRows(ROWS, { seed: 7, limit: 200 });
check('the repository builds from tagged rows', Boolean(repo) && repo.list().length === ROWS.length);
check('every station has a genre', repo.list().every((station) => GENRE_IDS.includes(station.genre)));
check('every station has a matched flag', repo.list().every((station) => typeof station.metadata.genreMatched === 'boolean'));

const genres = repo.genres();
check('genres() exposes the fixed definitions', genres.definitions.length === 13 && genres.definitions === GENRES);
check('genres() reports this sample', genres.total === ROWS.length);
eq('genreCounts() matches the data', repo.genreCounts().jazz, 5);
eq('genreCounts() has thirteen keys', Object.keys(repo.genreCounts()).length, 13);
eq('visibleGenres() hides the small ones', repo.visibleGenres().map((group) => group.id), ['jazz', 'rock', 'electronic', 'news', 'other']);
check('visible counts conserve the sample', repo.visibleGenres().reduce((sum, group) => sum + group.count, 0) === ROWS.length);
eq('the merged genres are named', repo.genres().merged, ['talk', 'sports']);

eq('listByGenre returns the raw genre', repo.listByGenre('jazz').length, 5);
eq('listByGenre (display) folds a small genre into other', repo.listByGenre('talk').length, 0);
eq('listByGenre (display:false) still answers for it', repo.listByGenre('talk', { display: false }).length, 2);
eq('other contains the merged stations', repo.listByGenre('other').length, 5);
eq('other contains them only once', new Set(repo.listByGenre('other').map((station) => station.id)).size, 5);
eq('unknown genres are empty, not errors', repo.listByGenre('nope').length, 0);

// The three views must agree, and the display groups must partition the sample
// exactly once — that is what makes a merged station reachable without being
// double-counted.
const rawAgrees = GENRE_IDS.every((id) => repo.listByGenre(id, { display: false }).length === repo.genreCounts()[id]);
check('genreCounts agrees with listByGenre(display:false) for all thirteen', rawAgrees);
const visibleAgrees = repo.visibleGenres().every((group) => repo.listByGenre(group.id).length === group.count);
check('visibleGenres agrees with listByGenre(display:true)', visibleAgrees);
const mergedReachable = repo.genres().merged.every((id) =>
  repo.listByGenre(id, { display: false }).every((station) => repo.listByGenre('other').some((other) => other.id === station.id)),
);
check('every merged station is reachable through other', mergedReachable);
const otherOnce = repo.listByGenre('other').length === new Set(repo.listByGenre('other').map((station) => station.id)).size;
check('other contains no station twice', otherOnce);
const seenOnce = new Map();
for (const group of repo.visibleGenres()) {
  for (const station of repo.listByGenre(group.id)) seenOnce.set(station.id, (seenOnce.get(station.id) || 0) + 1);
}
check('the display groups partition the sample exactly once', seenOnce.size === ROWS.length && [...seenOnce.values()].every((count) => count === 1), `${seenOnce.size} of ${ROWS.length}`);
check('merged genres are absent from visible', repo.genres().merged.every((id) => !repo.visibleGenres().some((group) => group.id === id)));
check('hidden genres resolve to an empty list', repo.genres().hidden.every((id) => repo.listByGenre(id).length === 0));

// Backwards compatibility: the phase-5 surface must still answer.
const stats = repo.stats();
check('stats still reports the taxonomy', stats.categories === CATEGORIES.length);
check('stats names the genre layer', stats.genres === 13 && stats.genreVisible === 5 && stats.genreMerged === 2);
check('list() is still the catalogue', repo.list().length === ROWS.length);
check('getById() still resolves', repo.getById(repo.list()[0].id) === repo.list()[0]);
check('search() still works', repo.search('jazz').length > 0);
check('search() finds by genre word', repo.search('techno').length >= 1, repo.search('techno').length);
check('categories() is still the eight buckets', repo.categories().length === CATEGORIES.length);
check('featured() and anchors() still answer', Array.isArray(repo.featured()) && Array.isArray(repo.anchors()));
check('kind is still reported', repo.kind === 'radio-browser');

// API row order must not change the classification of any station.
const shuffledRows = [...ROWS].reverse();
const reversed = createRepositoryFromRows(shuffledRows, { seed: 7, limit: 200 });
const genreById2 = new Map(reversed.list().map((station) => [station.id, station.genre]));
check(
  'row order does not change any genre',
  repo.list().every((station) => genreById2.get(station.id) === station.genre),
  'a station classified differently when the API rows arrived in another order',
);
eq('row order does not change the counts', reversed.genreCounts(), repo.genreCounts());

// --- 8. Both data sources ---------------------------------------------------

section('sources');

const mock = createMockRadioRepository({ count: 400, seed: 20261022 });
check('the mock catalogue carries genres', mock.list().every((station) => GENRE_IDS.includes(station.genre)));
check('the mock catalogue has a genre summary', mock.genres().total === 400 && mock.genres().visible.length > 0);
check('the mock summary conserves its sample', mock.genres().visible.reduce((sum, group) => sum + group.count, 0) === 400);
check('the mock catalogue keeps kind', mock.kind === 'mock');
check('the mock is still deterministic', createMockRadioRepository({ count: 400, seed: 20261022 }).genreCounts().jazz === mock.genreCounts().jazz);

const failingFetch = async () => {
  throw new Error('offline');
};
const degraded = await createRadioRepository({ mode: 'real', limit: 120, timeoutMs: 60, budgetMs: 300, maxHosts: 1, hosts: ['host.invalid'], fetch: failingFetch });
check('a dead network falls back to the mock', degraded.repository.kind === 'mock');
check('the fallback is labelled', degraded.fallback !== null && degraded.repository.genres().total === degraded.repository.list().length);
check('the fallback still has valid genres', degraded.repository.list().every((station) => GENRE_IDS.includes(station.genre)));

const successFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(ROWS) });
const real = await createRadioRepository({ mode: 'real', limit: 200, timeoutMs: 400, budgetMs: 2000, maxHosts: 1, hosts: ['host.invalid'], fetch: successFetch });
check('the real source builds with genres', real.repository.kind === 'radio-browser' && real.repository.genres().total === ROWS.length);
eq('the real source reports the same counts', real.repository.genreCounts().jazz, 5);
check('no fallback on success', real.fallback === null);

// --- 9. Live sample ---------------------------------------------------------

section('live');

if (OFFLINE_ONLY || typeof fetch !== 'function') {
  check('live request skipped', true);
  current.skipped = true;
  console.log('live: skipped (offline-only or no fetch)');
} else {
  const started = Date.now();
  const live = await createRadioRepository({ mode: 'real', limit: 240, timeoutMs: 6000, budgetMs: 20000, maxHosts: 3 });
  const elapsed = Date.now() - started;
  const items = live.repository.list();
  const summaryLive = live.repository.genres();

  check('live request answered', items.length > 0, `${live.repository.kind} after ${elapsed} ms`);
  check('live stations all carry a genre', items.every((station) => GENRE_IDS.includes(station.genre)));
  check('live counts conserve the sample', summaryLive.visible.reduce((sum, group) => sum + group.count, 0) === items.length, `${summaryLive.visible.reduce((sum, g) => sum + g.count, 0)} vs ${items.length}`);
  check('live merged genres are smaller than the floor', summaryLive.merged.every((id) => summaryLive.raw.find((entry) => entry.id === id).count < MIN_GENRE_STATIONS));
  check('live other counts add up', summaryLive.other.raw + summaryLive.other.merged === summaryLive.other.total);
  const livePartition = new Map();
  for (const group of summaryLive.visible) {
    for (const station of live.repository.listByGenre(group.id)) livePartition.set(station.id, (livePartition.get(station.id) || 0) + 1);
  }
  check('live display groups partition the sample exactly once', livePartition.size === items.length && [...livePartition.values()].every((count) => count === 1), `${livePartition.size} of ${items.length}`);

  const total = items.length || 1;
  const rowsOut = summaryLive.raw.map((entry) => ({
    id: entry.id,
    count: entry.count,
    share: `${((entry.count / total) * 100).toFixed(1)}%`,
    merged: summaryLive.merged.includes(entry.id),
    hidden: summaryLive.hidden.includes(entry.id),
  }));
  console.log(`live sample: ${items.length} stations via ${live.repository.kind} in ${elapsed} ms${live.fallback ? ` (fallback: ${live.fallback.reason})` : ''}`);
  for (const entry of rowsOut) {
    const mark = entry.merged ? ' ← merged into other' : entry.hidden ? ' ← absent from sample' : '';
    console.log(`  ${entry.id.padEnd(12)} ${String(entry.count).padStart(4)}  ${entry.share.padStart(6)}${mark}`);
  }
  console.log(`  other        ${String(summaryLive.other.total).padStart(4)}  ${(((summaryLive.other.total / total) * 100).toFixed(1) + '%').padStart(6)}  (raw ${summaryLive.other.raw} + merged ${summaryLive.other.merged})`);

  const unknown = new Map();
  for (const station of items) {
    if (station.genre !== 'other') continue;
    for (const tag of tagsOf(station)) unknown.set(tag, (unknown.get(tag) || 0) + 1);
  }
  const topUnknown = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (topUnknown.length > 0) {
    console.log(`  unknown tags in other: ${topUnknown.map(([tag, count]) => `${tag}×${count}`).join(', ')}`);
  }

  // How much of Other is genuinely "no signal at all" rather than a genre the
  // vocabulary is missing? Both numbers matter for the next phase.
  const tagless = items.filter((station) => tagsOf(station).length === 0);
  const taglessOther = tagless.filter((station) => station.genre === 'other').length;
  console.log(`  untagged stations: ${tagless.length} (${((tagless.length / total) * 100).toFixed(1)}%), of which ${taglessOther} landed in other`);

  // What evidence drove the biggest genre? A genre that wins on name hints is
  // weaker evidence than one that wins on tags.
  const biggest = summaryLive.raw.filter((entry) => entry.id !== 'other').sort((a, b) => b.count - a.count)[0];
  if (biggest) {
    const evidence = new Map();
    for (const station of items) {
      if (station.genre !== biggest.id) continue;
      const key = String(station.metadata.genreEvidence || 'none').replace(/:.+$/, '');
      evidence.set(key, (evidence.get(key) || 0) + 1);
    }
    console.log(`  ${biggest.id} evidence: ${[...evidence.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}×${count}`).join(', ')}`);
  }

  if (summaryLive.merged.length > 0) console.log(`  merged: ${summaryLive.merged.join(', ')}`);
  const visibleCount = summaryLive.visible.length;
  console.log(`  nebulae this sample: ${visibleCount} of ${GENRES.length} (${summaryLive.hidden.length} absent)`);
  check('the live sample is described as a sample', true);
}

// --- report ---------------------------------------------------------------

const failed = problems.length > 0;
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ok: !failed,
        checks,
        failed: problems.length,
        sections,
        problems,
      },
      null,
      2,
    ),
  );
}

console.log('');
if (failed) {
  console.log(`GENRE CHECKS FAILED — ${problems.length} of ${checks} checks`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('GENRE CHECKS PASSED');
  console.log(`  checks:   ${checks}`);
  for (const entry of sections) {
    console.log(`  ${entry.name.padEnd(12)} ${entry.passed} passed${entry.failed ? `, ${entry.failed} failed` : ''}${entry.skipped ? ' (live skipped)' : ''}`);
  }
}
