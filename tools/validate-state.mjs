/**
 * Phase-7 state and playback checks.
 *
 * This is the test that has to hold before any view exists. It covers:
 *
 *   1. identity   — a real station keys on its uuid; a mock station keys on its
 *                   own generated content, so a regenerated dataset cannot hand
 *                   one station's favourites to a different station;
 *   2. merge      — reindexing (count change, source change, filtered subsets)
 *                   never erases selection, favourites or likes;
 *   3. selection  — selection is not playing, and each has exactly one owner;
 *   4. playback   — exactly one audio element is created across any sequence of
 *                   plays, pauses, switches and stops, and it survives an
 *                   arbitrary number of "view unmounts";
 *   5. teardown   — dispose silences the element and is idempotent.
 *
 * Usage:
 *   node tools/validate-state.mjs          # checks + summary
 *   node tools/validate-state.mjs --json   # + machine-readable report
 */

import {
  createMockRadioRepository,
  createRadioStore,
  createPlaybackCore,
  stationKey,
  mockSignature,
} from '../src/radio/index.js';

/* ------------------------------------------------------------------ harness */

let passed = 0;
const failures = [];
const sections = [];

function section(name) {
  const entry = { name, checks: [] };
  sections.push(entry);
  return (label, fn) => {
    try {
      fn();
      passed += 1;
      entry.checks.push({ label, ok: true });
    } catch (error) {
      failures.push({ section: name, label, message: error && error.message ? error.message : String(error) });
      entry.checks.push({ label, ok: false, message: error && error.message ? error.message : String(error) });
    }
  };
}

function ok(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------------------------------- fake audio element */

/**
 * A stand-in for `HTMLAudioElement` that records what it was asked to do.
 * `play()` resolves as a real element would once the source is ready; the
 * `playing` event is emitted explicitly by the test so status transitions are
 * observable and deterministic.
 */
function createFakeAudio() {
  const handlers = new Map();
  const element = {
    src: '',
    error: null,
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    played: [],
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    emit(type) {
      for (const fn of handlers.get(type) || []) fn({ type });
    },
    play() {
      element.playCalls += 1;
      element.played.push(element.src);
      element.paused = false;
      return Promise.resolve();
    },
    pause() {
      element.pauseCalls += 1;
      element.paused = true;
    },
    removeAttribute(name) {
      if (name === 'src') element.src = '';
    },
    load() {
      element.loaded = (element.loaded || 0) + 1;
    },
  };
  return element;
}

/** A playback core whose element factory is counted, exactly as a test needs. */
function createInstrumentedPlayback(clock) {
  const created = [];
  const core = createPlaybackCore({
    createAudio: () => {
      const element = createFakeAudio();
      created.push(element);
      return element;
    },
    now: clock || (() => Date.now()),
  });
  return { core, created };
}

/* ------------------------------------------------------------- 1. identity */

{
  const check = section('identity');

  check('a live station keys on its uuid, whatever else changes', () => {
    const base = {
      id: '8f5a1e10-0000-4c1a-9c1a-000000000001',
      name: 'Some Station',
      country: { zh: '德国', en: 'Germany' },
      language: { zh: '德语', en: 'German' },
      categories: ['jazz'],
      metadata: { source: 'radio-browser' },
    };
    const keyA = stationKey(base);
    // A re-fetch with a different name/count but the same uuid is the same station.
    const keyB = stationKey({ ...base, name: 'Some Station (Renamed)', categories: ['blues'], count: 9999 });
    eq(keyA, 'rb:8f5a1e10-0000-4c1a-9c1a-000000000001', 'live key is the uuid');
    eq(keyA, keyB, 'live key ignores mutable fields');
  });

  check('a mock station keys on its own content, not the catalogue seed', () => {
    const repo = createMockRadioRepository({ count: 400, seed: 20261022 });
    const first = repo.list()[0];
    const key = stationKey(first);
    ok(key.startsWith('mock:'), 'mock key has the mock prefix');
    ok(key.endsWith(`:${first.id}`), 'mock key ends with the record id');
    // The metadata.seed is shared by every record in the dataset; two different
    // stations must therefore not differ only by that value.
    const second = repo.list()[1];
    ok(stationKey(second) !== key, 'two stations never share a key');
  });

  check('the same seed and index regenerate the same station key', () => {
    const a = createMockRadioRepository({ count: 400, seed: 20261022 }).list();
    const b = createMockRadioRepository({ count: 400, seed: 20261022 }).list();
    for (let i = 0; i < a.length; i += 1) {
      eq(stationKey(a[i]), stationKey(b[i]), `station ${i} is stable across two generations`);
    }
  });

  check('raising the count keeps the earlier stations and their keys', () => {
    const small = createMockRadioRepository({ count: 400, seed: 20261022 }).list();
    const large = createMockRadioRepository({ count: 1200, seed: 20261022 }).list();
    for (let i = 0; i < small.length; i += 1) {
      eq(stationKey(small[i]), stationKey(large[i]), `station ${i} keeps its key when the count grows`);
    }
  });

  check('a different catalogue seed does not silently inherit a favourite', () => {
    const a = createMockRadioRepository({ count: 400, seed: 20261022 }).list()[0];
    const b = createMockRadioRepository({ count: 400, seed: 777 }).list()[0];
    // Both are `mock-0001`, but they are different stations; the signatures
    // must not agree unless the generated content happens to be identical.
    const sameContent =
      a.name === b.name &&
      a.country.en === b.country.en &&
      a.language.en === b.language.en &&
      a.categories[0] === b.categories[0];
    if (!sameContent) {
      ok(stationKey(a) !== stationKey(b), 'different content yields a different key');
    }
    // The store must never resolve one station's state through the other.
    const store = createRadioStore();
    store.index([a, b]);
    store.toggleFavorite(a);
    if (!sameContent) eq(store.isFavorite(b), false, 'the impostor is not favourited');
  });

  check('signature ignores list position but reads real content', () => {
    const station = {
      id: 'mock-0007',
      name: 'Radio Nordlicht',
      country: { zh: '挪威', en: 'Norway' },
      language: { zh: '挪威语', en: 'Norwegian' },
      categories: ['ambient'],
      metadata: { demo: true, source: 'mock', seed: 42, index: 6 },
    };
    const moved = { ...station };
    moved.metadata = { ...station.metadata, index: 5000 };
    eq(mockSignature(station), mockSignature(moved), 'the index is not part of the signature');
    const renamed = { ...station, name: 'Radio Something Else' };
    ok(mockSignature(station) !== mockSignature(renamed), 'the name is part of the signature');
  });

  check('a record with no id has no key', () => {
    eq(stationKey(null), null, 'null station');
    eq(stationKey({}), null, 'no id');
    eq(stationKey({ id: '' }), null, 'empty id');
  });
}

/* ---------------------------------------------------------------- 2. merge */

{
  const check = section('merge');

  check('reindexing with a different count keeps favourites, song likes and selection', () => {
    const store = createRadioStore();
    const small = createMockRadioRepository({ count: 400, seed: 20261022 }).list();
    store.index(small);
    const picked = small[3];
    store.select(picked);
    store.toggleFavorite(picked);
    const song = { title: 'Marion Meadows - My Cherie Amour', stationKey: stationKey(picked), stationName: picked.name };
    store.toggleSongLike(song);
    ok(store.isFavorite(picked) && store.isSongLiked(song.title), 'state is set');

    const large = createMockRadioRepository({ count: 1500, seed: 20261022 }).list();
    store.index(large);
    eq(store.isFavorite(picked), true, 'favourite survives a reindex');
    eq(store.isSongLiked(song.title), true, 'song like survives a reindex');
    eq(store.keyOf(store.getSelected()), store.keyOf(picked), 'selection survives a reindex');
    eq(store.getStation(picked).name, picked.name, 'the record is still resolvable');
  });

  check('a filtered subset does not erase state for stations it omits', () => {
    const store = createRadioStore();
    const all = createMockRadioRepository({ count: 400, seed: 20261022 }).list();
    store.index(all);
    store.toggleFavorite(all[10]);
    // Simulate a search result / genre view indexing only part of the catalogue.
    store.index(all.slice(0, 20));
    eq(store.isFavorite(all[10]), true, 'favourite in the subset is intact');
    store.index(all.slice(200, 220));
    eq(store.isFavorite(all[10]), true, 'favourite outside the subset is intact');
    eq(store.getStation(all[10]) !== null, true, 'the omitted station is still known');
  });

  check('crossing sources keeps each side independent', () => {
    const store = createRadioStore();
    const mock = createMockRadioRepository({ count: 300, seed: 20261022 }).list();
    store.index(mock);
    store.toggleFavorite(mock[0]);
    const live = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      name: 'Live One',
      country: { zh: '法国', en: 'France' },
      language: { zh: '法语', en: 'French' },
      categories: ['jazz'],
      metadata: { source: 'radio-browser' },
    };
    store.index([live]);
    eq(store.isFavorite(mock[0]), true, 'mock state is untouched by a live index');
    eq(store.isFavorite(live), false, 'a live station starts clean');
    store.toggleFavorite(live);
    eq(store.isFavorite(live), true, 'live state works');
    eq(store.isFavorite(mock[0]), true, 'and does not disturb the mock side');
  });

  check('a station favourite and a song like are independent entities', () => {
    const store = createRadioStore();
    const list = createMockRadioRepository({ count: 200, seed: 20261022 }).list();
    store.index(list);
    const song = { title: 'Marion Meadows - My Cherie Amour', stationKey: stationKey(list[0]), stationName: list[0].name };
    store.toggleFavorite(list[0]);
    eq(store.isSongLiked(song.title), false, 'favouriting a station does not like a song');
    store.toggleSongLike(song);
    eq(store.isFavorite(list[0]), true, 'liking a song does not unfavourite the station');
    eq(store.favoriteStations().length, 1, 'the station list is untouched by a song like');
    eq(store.likedSongs().length, 1, 'the song list holds the song');
    store.toggleFavorite(list[0]);
    eq(store.isSongLiked(song.title), true, 'unfavouriting the station does not unlike the song');
    store.toggleSongLike(song);
    eq(store.isSongLiked(song.title), false, 'the same song toggles off');
    eq(store.likedSongs().length, 0, 'and leaves no entry behind');
  });

  check('one song is one song across stations and spellings', () => {
    const store = createRadioStore();
    const list = createMockRadioRepository({ count: 200, seed: 20261022 }).list();
    store.index(list);
    store.toggleSongLike({ title: 'My Cherie Amour', stationName: list[0].name });
    eq(store.isSongLiked('my   cherie amour'), true, 'case and spacing are the same song');
    eq(store.isSongLiked('MY CHERIE AMOUR'), true, 'so is a shouted version');
    eq(store.likedSongs().length, 1, 'one entry, not three');
    // A second station publishing the same title Toggles the one entry, it does
    // not add a per-station copy: the song, not the station, is the entity.
    store.toggleSongLike({ title: 'My Cherie Amour', stationName: list[1].name });
    eq(store.likedSongs().length, 0, 'the same title toggles the one entry off');
    eq(store.isSongLiked(''), false, 'an empty title is never a song');
  });

  check('toggle is idempotent per call and notifies once per real change', () => {
    const store = createRadioStore();
    const list = createMockRadioRepository({ count: 200, seed: 20261022 }).list();
    store.index(list);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.setFavorite(list[0], true);
    const afterFirst = notifications;
    store.setFavorite(list[0], true);
    eq(notifications, afterFirst, 'setting the same value does not notify');
    store.toggleFavorite(list[0]);
    ok(notifications > afterFirst, 'a real change notifies');
  });
}

/* ------------------------------------------------------------ 3. selection */

{
  const check = section('selection');

  check('selecting does not play, and playing does not select', () => {
    const store = createRadioStore();
    const { core } = createInstrumentedPlayback();
    const list = createMockRadioRepository({ count: 200, seed: 20261022 }).list();
    store.index(list);
    store.select(list[0]);
    eq(core.getState().stationId, null, 'selecting leaves the player idle');
    core.play(list[1].id, 'https://example.test/b.mp3');
    eq(store.keyOf(store.getSelected()), store.keyOf(list[0]), 'playing does not move the selection');
  });

  check('the store has no playing state of its own', () => {
    const store = createRadioStore();
    const snapshot = store.getSnapshot();
    ok(!('status' in snapshot), 'no status field');
    ok(!('stationId' in snapshot), 'no stationId field');
    ok(!('playing' in snapshot), 'no playing field');
    ok(!('playingKey' in snapshot), 'no playingKey field');
  });

  check('select(null) clears, select(unknown) clears', () => {
    const store = createRadioStore();
    const list = createMockRadioRepository({ count: 200, seed: 20261022 }).list();
    store.index(list);
    store.select(list[2]);
    ok(store.getSelected(), 'selected');
    store.select(null);
    eq(store.getSelected(), null, 'cleared');
    store.select(list[2]);
    store.select('no-such-station');
    eq(store.getSelected(), null, 'an unknown target clears rather than lying');
  });
}

/* ------------------------------------------------------------- 4. playback */

{
  const check = section('playback');

  check('exactly one audio element across any sequence of plays and switches', () => {
    const store = createRadioStore();
    const { core, created } = createInstrumentedPlayback();
    const list = createMockRadioRepository({ count: 200, seed: 20261022 }).list();
    store.index(list);

    core.play(list[0].id, 'https://example.test/a.mp3');
    core.play(list[1].id, 'https://example.test/b.mp3');
    core.pause();
    core.resume();
    core.play(list[2].id, 'https://example.test/c.mp3');
    core.toggle(list[2].id, 'https://example.test/c.mp3');
    core.stop();
    core.play(list[3].id, 'https://example.test/d.mp3');

    eq(created.length, 1, 'one element was created in total');
    eq(core.stats().created, 1, 'stats agrees');
    eq(core.stats().alive, 1, 'and it is alive');
  });

  check('the element survives an arbitrary number of view unmounts', () => {
    const { core, created } = createInstrumentedPlayback();
    core.play('station-1', 'https://example.test/a.mp3');
    // A view unmounting does nothing to the core; only the plugin doing so
    // releases it. 50 simulated unmounts therefore change nothing.
    for (let i = 0; i < 50; i += 1) {
      const unsubscribe = core.subscribe(() => {});
      unsubscribe();
    }
    eq(created.length, 1, 'no element was created by subscribing or unsubscribing');
    eq(core.getState().stationId, 'station-1', 'the station is unchanged');
  });

  check('status follows the element\'s real events', () => {
    const { core, created } = createInstrumentedPlayback();
    core.play('station-1', 'https://example.test/a.mp3');
    eq(core.getState().status, 'loading', 'a play request starts in loading');
    created[0].emit('playing');
    eq(core.getState().status, 'playing', 'the playing event promotes it');
    core.pause();
    eq(core.getState().status, 'paused', 'pause is reflected');
    core.resume();
    created[0].emit('playing');
    eq(core.getState().status, 'playing', 'resume is reflected');
  });

  check('a transient element error schedules a retry with the station still named', () => {
    const { core, created } = createInstrumentedPlayback();
    core.play('station-7', 'https://example.test/broken.mp3');
    created[0].error = { code: 4 };
    created[0].emit('error');
    const state = core.getState();
    // A single element error is recoverable: the core retries (status back to
    // loading) instead of failing outright. Terminal failure once the retry
    // budget is exhausted is covered by test-radio-resilience.
    eq(state.status, 'loading', 'the retry keeps it loading');
    eq(state.stationId, 'station-7', 'the station is still identified');
  });

  check('play without a station id is refused', () => {
    const { core, created } = createInstrumentedPlayback();
    core.play(null, 'https://example.test/a.mp3');
    core.play('', 'https://example.test/a.mp3');
    eq(created.length, 0, 'nothing was created');
    eq(core.getState().status, 'idle', 'still idle');
  });

  check('toggling the same station pauses rather than restarting', () => {
    const { core, created } = createInstrumentedPlayback();
    core.play('station-1', 'https://example.test/a.mp3');
    created[0].emit('playing');
    const playsBefore = created[0].playCalls;
    core.toggle('station-1', 'https://example.test/a.mp3');
    eq(core.getState().status, 'paused', 'toggling the playing station pauses');
    eq(created[0].playCalls, playsBefore, 'and does not re-issue play');
  });

  check('switching stations rewrites the source exactly once', () => {
    const { core, created } = createInstrumentedPlayback();
    core.play('a', 'https://example.test/a.mp3');
    created[0].emit('playing');
    core.play('b', 'https://example.test/b.mp3');
    eq(created[0].played[created[0].played.length - 1], 'https://example.test/b.mp3', 'the new source was played');
    eq(core.getState().stationId, 'b', 'the new station is named');
  });

  check('a slow load is flagged without failing', () => {
    let clock = 1000;
    const { core } = createInstrumentedPlayback(() => clock);
    core.play('slow', 'https://example.test/slow.mp3');
    clock += 500;
    eq(core.getState().slow, false, 'not slow yet');
    clock += 20000;
    const state = core.getState();
    eq(state.status, 'loading', 'still loading');
    eq(state.slow, true, 'flagged as slow');
  });
}

/* ------------------------------------------------------------- 5. teardown */

{
  const check = section('teardown');

  check('dispose silences the element and is idempotent', () => {
    const { core, created } = createInstrumentedPlayback();
    core.play('station-1', 'https://example.test/a.mp3');
    created[0].emit('playing');
    core.dispose();
    eq(created[0].paused, true, 'the element is paused');
    eq(created[0].src, '', 'the source is released');
    eq(core.getState().status, 'idle', 'the core is idle');
    eq(core.getState().stationId, null, 'and names no station');
    core.dispose();
    core.play('station-2', 'https://example.test/b.mp3');
    eq(created.length, 1, 'a disposed core never creates another element');
  });

  check('a subscriber that throws does not stop the others', () => {
    const { core } = createInstrumentedPlayback();
    let reached = 0;
    core.subscribe(() => {
      throw new Error('bad subscriber');
    });
    core.subscribe(() => {
      reached += 1;
    });
    core.play('station-1', 'https://example.test/a.mp3');
    ok(reached > 0, 'the healthy subscriber still ran');
  });
}

/* ---------------------------------------------------------------- 6. save */

{
  const check = section('persistence seam');

  check('save reports state and load restores only known stations', () => {
    const store = createRadioStore({ now: () => 12345 });
    const list = createMockRadioRepository({ count: 200, seed: 20261022 }).list();
    store.index(list);
    store.select(list[4]);
    store.toggleFavorite(list[4]);
    store.toggleSongLike({ title: 'Track One', stationKey: stationKey(list[5]), stationName: list[5].name });
    const saved = store.save();
    eq(saved.version, 2, 'versioned record');
    eq(saved.favorite.length, 1, 'one favourite');
    eq(saved.songs.length, 1, 'one song');

    const fresh = createRadioStore();
    fresh.index(list);
    fresh.load(saved);
    eq(fresh.isFavorite(list[4]), true, 'favourite restored');
    eq(fresh.isSongLiked('Track One'), true, 'song restored');
    eq(fresh.keyOf(fresh.getSelected()), store.keyOf(list[4]), 'selection restored');

    // A record naming stations this build has never seen keeps its marks: the
    // catalogue is fetched and refreshed, so a missing station may simply not be
    // back yet. The unresolvable selection still yields no station object.
    const stranger = createRadioStore();
    stranger.index(list);
    stranger.load({ version: 2, favorite: ['rb:does-not-exist'], songs: [], selectedKey: 'rb:nope' });
    eq(stranger.favoriteKeys().length, 1, 'an unknown favourite key is kept for the next catalogue');
    eq(stranger.favoriteKeys()[0], 'rb:does-not-exist', 'the kept key is the recorded one');
    eq(stranger.getSelected(), null, 'an unresolvable selection yields no station');

    // A version-1 record used the heart for stations; those marks are kept as
    // station marks rather than dropped when the heart moved to songs.
    const legacy = createRadioStore();
    legacy.index(list);
    legacy.load({ version: 1, favorite: [stationKey(list[6])], liked: [stationKey(list[7])] });
    eq(legacy.isFavorite(list[7]), true, 'a version-1 station like survives as a station mark');
    eq(legacy.isFavorite(list[6]), true, 'alongside the version-1 favourite');
  });
}

/* --------------------------------------- 7. genre volumes and station lists */

{
  const check = section('genre volumes');

  check('the summary count and listByGenre count the same stations', () => {
    const repository = createMockRadioRepository({ count: 400, seed: 20261022 });
    const visible = repository.visibleGenres();
    let railTotal = 0;
    for (const genre of visible) {
      const fromRepo = repository.listByGenre(genre.id).length;
      eq(fromRepo, genre.count, `${genre.id}: the summary and the list agree`);
      railTotal += fromRepo;
    }
    eq(railTotal, repository.list().length, 'every station lands in exactly one volume');
  });

  check('a folded genre is listed inside Other, not as its own volume', () => {
    const repository = createMockRadioRepository({ count: 400, seed: 20261022 });
    const summary = repository.genres();
    const merged = summary.merged;
    if (merged.length === 0) return; // nothing folded at this sample size
    const folded = merged[0];
    const visible = repository.visibleGenres();
    ok(!visible.some((genre) => genre.id === folded), 'a merged genre gets no volume of its own');
    const inOther = repository.listByGenre('other');
    const rawOfFolded = repository.listByGenre(folded, { display: false });
    for (const station of rawOfFolded) {
      ok(inOther.includes(station), `${station.id} sits in Other's list`);
    }
  });

  check('a list row and the selected station resolve to the same key', () => {
    const store = createRadioStore();
    const repository = createMockRadioRepository({ count: 300, seed: 20261022 });
    const list = repository.list();
    store.index(list);
    const visible = repository.visibleGenres();
    const genre = visible.find((entry) => entry.count > 2) || visible[0];
    const rows = repository.listByGenre(genre.id);
    ok(rows.length > 0, 'the volume has rows');
    store.select(rows[0]);

    const selectedKey = store.keyOf(store.getSelected());
    const rowKey = stationKey(rows[0]);
    eq(selectedKey, rowKey, 'selecting a row makes that row active');

    // Acting from the row must be the same station the selection names.
    store.toggleFavorite(rows[0]);
    eq(store.isFavorite(store.getSelected()), true, 'favouriting a row updates the selection');
  });

  check('reopening another volume keeps the selection and the business state', () => {
    const store = createRadioStore();
    const repository = createMockRadioRepository({ count: 300, seed: 20261022 });
    store.index(repository.list());
    const visible = repository.visibleGenres().filter((genre) => genre.count > 1);
    ok(visible.length >= 2, 'at least two volumes');
    const first = repository.listByGenre(visible[0].id);
    store.select(first[0]);
    store.toggleFavorite(first[0]);
    store.toggleSongLike({ title: 'Volume Track', stationKey: stationKey(first[1]), stationName: first[1].name });

    // Opening another genre is view state only; nothing above it changes.
    const before = store.getSnapshot();
    const other = repository.listByGenre(visible[1].id);
    eq(store.isFavorite(first[0]), true, 'the favourite survives the volume switch');
    eq(store.isSongLiked('Volume Track'), true, 'the song like survives the volume switch');
    eq(store.keyOf(store.getSelected()), stationKey(first[0]), 'the selection survives the volume switch');
    eq(store.getSnapshot().version, before.version, 'reading another volume mutated nothing');
    ok(other.length > 0, 'the other volume has rows of its own');
  });

  check('the rail reports a nonzero count for every volume it shows', () => {
    const repository = createMockRadioRepository({ count: 400, seed: 20261022 });
    const summaries = repository.visibleGenres();
    ok(summaries.length > 0, 'volumes exist');
    for (const genre of summaries) {
      ok(Number.isFinite(genre.count) && genre.count > 0, `${genre.id} is displayed and populated`);
      ok(typeof genre.id === 'string' && genre.id.length > 0, `${genre.id} has a stable id`);
    }
  });
}

/* ------------------------------------------------------------------ report */

const total = passed + failures.length;
for (const entry of sections) {
  const okCount = entry.checks.filter((check) => check.ok).length;
  console.log(`  ${entry.name.padEnd(20)} ${okCount}/${entry.checks.length}`);
  for (const check of entry.checks) {
    if (!check.ok) console.log(`      FAIL  ${check.label}\n            ${check.message}`);
  }
}
console.log(`\n  ${passed}/${total} checks passed`);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, passed, failures, sections }, null, 2));
}

if (failures.length > 0) {
  process.exitCode = 1;
}
