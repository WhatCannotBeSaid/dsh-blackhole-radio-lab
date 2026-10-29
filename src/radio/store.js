/**
 * The radio store — the one place a station's identity and business state live.
 *
 * This module knows nothing about React, the DOM, three.js or audio. It is a
 * plain, dependency-free object so that the panel, the stage's overlays and any
 * future view can share exactly one copy of the truth:
 *
 *   - which stations exist (`byKey`, keyed by a stable station key)
 *   - which station is selected
 *   - which stations are favourited
 *   - which songs are liked
 *
 * ## Two entities, not two buttons
 *
 * A station and a song are different things, so they are kept apart. The star
 * favourites a station by its stable station key; the heart likes a *song* by
 * its normalised title, which outlives the station it was heard on — the same
 * track on another station is already liked. Nothing is liked "per station":
 * that is exactly the confusion the two marks must not inherit.
 *
 * Playing is deliberately NOT here. "Selected" and "playing" are two different
 * questions, and the audio element that answers the second one is owned by
 * playback.js. Two owners for one fact is how state grows a second source.
 *
 * ## Station identity
 *
 * A station key must survive a view unmounting, a panel closing and a
 * repository reload. It must NOT be reused by a different station. Two sources
 * therefore key differently:
 *
 *   live  `rb:<stationuuid>`
 *         Radio Browser's uuid is stable across sessions and independent of
 *         ordering, so it is used as-is.
 *
 *   mock  `mock:<content signature>:<index>`
 *         The mock id (`mock-0001`) is generated from the list index alone, and
 *         every record carries the same global catalogue seed, so neither is a
 *         per-station identity: changing the seed would hand an old favourite
 *         to a completely different station. The signature is computed from the
 *         station's own generated content (name, country, language, category),
 *         so a station keeps its state only while it is recognisably the same
 *         station. A regenerated dataset with different content yields a
 *         different key, which is the intended outcome: state is dropped rather
 *         than inherited by an impostor.
 *
 * The signature hashes only the record's own fields, never `count` or the list
 * position, which is what makes it independent of how many stations were
 * generated.
 */

/** Default number of stations listed for one genre, newest-first. */
export const RECENT_LIMIT = 6;

/**
 * FNV-1a over the string forms of the arguments, as an unsigned 32-bit int.
 * Re-implemented here rather than imported so the store stays dependency-free
 * (and so the data chunk keeps a single entry point).
 */
function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x3c6ef372;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The content signature of a generated station.
 *
 * Only fields the generator derives from `(seed, index)` take part. Adding the
 * station count here would make the signature depend on the dataset size, and
 * adding the index would make it depend on list order; both are exactly the
 * instabilities the key is meant to survive.
 */
export function mockSignature(station) {
  if (!station) return 'void';
  const country = (station.country && (station.country.en || station.country.zh)) || '';
  const language = (station.language && (station.language.en || station.language.zh)) || '';
  const primary = (station.categories && station.categories[0]) || '';
  const parts = [station.name || '', country, language, primary];
  return hash32('mock-station', ...parts).toString(16).padStart(8, '0');
}

/**
 * The stable key for one station record.
 *
 * @param station a record from the repository (plain object)
 * @returns a string key, or `null` when the record cannot be identified
 */
export function stationKey(station) {
  if (!station || typeof station !== 'object') return null;
  const id = station.id === undefined || station.id === null ? '' : String(station.id);
  if (!id) return null;
  const metadata = station.metadata && typeof station.metadata === 'object' ? station.metadata : {};
  if (metadata.source === 'radio-browser' || (!metadata.demo && !metadata.source)) {
    // Live rows: the uuid is the identity. A row that lost its uuid falls
    // through to the mock-style signature, which is still better than
    // pretending two different stations are one.
    return `rb:${id}`;
  }
  return `mock:${mockSignature(station)}:${id}`;
}

/**
 * The one spelling of a song title, so "My Cherie Amour" heard on two stations
 * is one song and not two.
 *
 * Case and whitespace are noise in a title — streams vary them between metadata
 * blocks of the same track — so they are collapsed here rather than at each
 * comparison. The text itself is never rewritten: what the stream published is
 * what the list shows.
 */
export function normalizeSongTitle(value) {
  if (typeof value !== 'string') return '';
  const text = (typeof value.normalize === 'function' ? value.normalize('NFC') : value).replace(/\s+/g, ' ').trim();
  return text.slice(0, 160);
}

/**
 * The stable key for one song title, or `null` when there is no title.
 *
 * A hash rather than the title itself: keys are persisted, and a title may hold
 * any character a stream felt like sending.
 */
export function songKeyOf(value) {
  const title = normalizeSongTitle(value);
  if (!title) return null;
  return `song:${hash32('bhrl-song', title.toLowerCase()).toString(16).padStart(8, '0')}`;
}

/**
 * Normalise whatever a caller hands over into the record the store keeps.
 * @param song a title string or `{ title, artist, stationKey, stationName }`
 * @param clock the store's injected clock
 */
function songRecord(song, clock) {
  const input = typeof song === 'string' ? { title: song } : song;
  if (!input || typeof input !== 'object') return null;
  const title = normalizeSongTitle(input.title);
  const key = songKeyOf(title);
  if (!key) return null;
  return {
    key,
    title,
    artist: normalizeSongTitle(input.artist),
    stationKey: input.stationKey ? String(input.stationKey) : null,
    stationName: input.stationName ? String(input.stationName) : '',
    // A record that arrives from the library brings the moment it was liked;
    // restoring must keep it, or every reload would restamp the whole list as
    // liked-just-now and the order would mean nothing.
    at: Number.isFinite(input.at) ? Math.max(0, Math.round(input.at)) : typeof clock === 'function' ? clock() : 0,
  };
}

/**
 * Create the store.
 *
 * @param options.now - clock, injected so tests are not time-dependent.
 */
export function createRadioStore(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** key → station record */
  let byKey = new Map();
  /** station.id → key, so callers can address a station the way the UI does */
  let keyById = new Map();
  let selectedKey = null;
  let favorite = new Set();
  /** song key → song record, insertion-ordered so "newest last" is cheap */
  let songs = new Map();
  /** Bumped on every mutation; a cheap version for memo dependencies. */
  let version = 0;
  const listeners = new Set();

  function emit() {
    version += 1;
    for (const listener of Array.from(listeners)) {
      try {
        listener(version);
      } catch {
        /* one bad subscriber must not stop the rest */
      }
    }
  }

  /** Resolve whatever the caller has (key, id, or a record) to a key. */
  function resolve(target) {
    if (target === null || target === undefined) return null;
    if (typeof target === 'object') return stationKey(target);
    const text = String(target);
    if (keyById.has(text)) return text;
    if (byKey.has(text)) return text;
    return null;
  }

  /** Resolve a song key, title, or song record to a song key. */
  function resolveSong(target) {
    if (target === null || target === undefined) return null;
    if (typeof target === 'object') return songKeyOf(target.title);
    const text = String(target);
    if (songs.has(text)) return text;
    return songKeyOf(text);
  }

  const store = {
    /**
     * Merge a station list into the index.
     *
     * Merge, not replace: a repository reload (a changed station count, a fresh
     * Radio Browser response, a fall back to mock) must not erase which station
     * is selected or which are favourited. Keys absent from the new list stay
     * in the index, so a station that is temporarily filtered out — a search, a
     * genre view, a cluster's subset — keeps its state and its name.
     */
    index(stations) {
      const list = Array.isArray(stations) ? stations : [];
      const next = new Map(byKey);
      const nextById = new Map(keyById);
      for (const station of list) {
        const key = stationKey(station);
        if (!key) continue;
        const prev = next.get(key);
        // The newest record wins for rendering; nothing else is merged over it.
        next.set(key, prev && prev !== station ? Object.assign({}, prev, station) : station);
        nextById.set(String(station.id), key);
      }
      byKey = next;
      keyById = nextById;
      emit();
      return store;
    },

    /** Remove every key that is neither live nor addressable. Used on teardown. */
    clear() {
      byKey = new Map();
      keyById = new Map();
      selectedKey = null;
      favorite = new Set();
      songs = new Map();
      emit();
      return store;
    },

    /** The station record for a key or id, or null. */
    getStation(target) {
      const key = resolve(target);
      return key ? byKey.get(key) || null : null;
    },

    /** The stable key of a station, or null. */
    keyOf(target) {
      return resolve(target);
    },

    /** Every indexed station, in insertion order. */
    stations() {
      return Array.from(byKey.values());
    },

    /** Stations of one display genre, catalogue order. */
    stationsByGenre(genreId) {
      const id = String(genreId);
      return Array.from(byKey.values()).filter((station) => (station.genre || 'other') === id);
    },

    /** --- selection ---------------------------------------------------- */

    /**
     * Select a station (or clear it with null). Selection is a view concern:
     * it says which station the user is looking at, never that anything plays.
     */
    select(target) {
      const key = resolve(target);
      if (key === selectedKey) return store;
      selectedKey = key;
      emit();
      return store;
    },

    getSelectedKey() {
      return selectedKey;
    },

    /** The selected station record, or null. */
    getSelected() {
      return selectedKey ? byKey.get(selectedKey) || null : null;
    },

    /** --- favourites and song likes ------------------------------------- */

    isFavorite(target) {
      const key = resolve(target);
      return key ? favorite.has(key) : false;
    },

    /**
     * Is this song already liked?
     *
     * Accepts a title, a stored song key, or a song record — the card holds a
     * title, a restored list holds keys, and neither should have to convert.
     */
    isSongLiked(target) {
      const key = resolveSong(target);
      return key ? songs.has(key) : false;
    },

    setFavorite(target, value) {
      const key = resolve(target);
      if (!key) return store;
      const want = Boolean(value);
      if (favorite.has(key) === want) return store;
      const next = new Set(favorite);
      if (want) next.add(key);
      else next.delete(key);
      favorite = next;
      emit();
      return store;
    },

    toggleFavorite(target) {
      return store.setFavorite(target, !store.isFavorite(target));
    },

    /**
     * Like or unlike one song.
     *
     * @param song a title, or `{ title, artist, stationKey, stationName }`
     * @param value true to like, false to unlike
     */
    setSongLiked(song, value) {
      const record = songRecord(song, now);
      if (!record) return store;
      const want = Boolean(value);
      if (songs.has(record.key) === want) return store;
      const next = new Map(songs);
      if (want) next.set(record.key, record);
      else next.delete(record.key);
      songs = next;
      emit();
      return store;
    },

    toggleSongLike(song) {
      return store.setSongLiked(song, !store.isSongLiked(song));
    },

    /** Keys of every favourite station, in insertion order. */
    favoriteKeys() {
      return Array.from(favorite);
    },

    /** The favourited station records themselves, in insertion order. */
    favoriteStations() {
      const list = [];
      for (const key of favorite) {
        const station = byKey.get(key);
        if (station) list.push(station);
      }
      return list;
    },

    /** Liked songs, newest first — what the heart's list shows. */
    likedSongs() {
      return Array.from(songs.values()).reverse();
    },

    /** --- snapshots ---------------------------------------------------- */

    /**
     * An immutable snapshot for `useSyncExternalStore`.
     *
     * Every mutation produces a new object, so a React consumer re-renders once
     * per real change and never once per render.
     */
    getSnapshot() {
      return {
        version,
        selectedKey,
        favorite,
        songs: Array.from(songs.values()),
        count: byKey.size,
      };
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Persistence seam: `save()` returns the record the Host writes to the
     * library file, and `load()` accepts one back. The shapes are fixed here so
     * that neither side has to know the other's storage.
     */
    save() {
      return {
        version: 2,
        savedAt: now(),
        selectedKey,
        favorite: Array.from(favorite),
        songs: Array.from(songs.values()),
      };
    },

    /**
     * Restore a record written earlier.
     *
     * It merges instead of replacing, because the record comes back from disk a
     * moment after the panel is already usable: a mark made while that read is
     * in flight must not be erased by the answer to it. A store that is still
     * empty merges into nothing, which is the same thing as a replace.
     *
     * Keys are kept even when this session's catalogue does not hold them. The
     * catalogue is fetched, cached and refreshed, so a station can be missing
     * for a while without being gone; filtering against today's list would drop
     * the mark on the next write, and the station would never come back.
     */
    load(record) {
      if (!record || typeof record !== 'object') return store;
      const keys = (values) =>
        (Array.isArray(values) ? values : []).map((value) => String(value)).filter(Boolean);
      for (const key of keys(record.favorite)) favorite.add(key);
      // A version-1 record marked stations with the heart. The heart now marks
      // songs, so those keys are kept as station marks — the entity they were
      // always about — instead of disappearing with the old meaning.
      if (!Array.isArray(record.songs) && Array.isArray(record.liked)) {
        for (const key of keys(record.liked)) favorite.add(key);
      }
      for (const entry of Array.isArray(record.songs) ? record.songs : []) {
        const restored = songRecord(entry, now);
        if (restored && !songs.has(restored.key)) songs.set(restored.key, restored);
      }
      // A selection already made in this session wins over the one on disk. The
      // stored key is kept even when this catalogue cannot resolve it, for the
      // same reason a favourite is: the station may come back with the next one.
      if (!selectedKey && typeof record.selectedKey === 'string' && record.selectedKey) {
        selectedKey = record.selectedKey;
      }
      emit();
      return store;
    },
  };

  return store;
}
