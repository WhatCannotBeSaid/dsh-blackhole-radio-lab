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
 *   - which stations are liked
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
  let liked = new Set();
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
      liked = new Set();
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

    /** --- favourites and likes ----------------------------------------- */

    isFavorite(target) {
      const key = resolve(target);
      return key ? favorite.has(key) : false;
    },

    isLiked(target) {
      const key = resolve(target);
      return key ? liked.has(key) : false;
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

    setLiked(target, value) {
      const key = resolve(target);
      if (!key) return store;
      const want = Boolean(value);
      if (liked.has(key) === want) return store;
      const next = new Set(liked);
      if (want) next.add(key);
      else next.delete(key);
      liked = next;
      emit();
      return store;
    },

    toggleLike(target) {
      return store.setLiked(target, !store.isLiked(target));
    },

    /** Keys of every favourite / liked station, in insertion order. */
    favoriteKeys() {
      return Array.from(favorite);
    },

    likedKeys() {
      return Array.from(liked);
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
        liked,
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
     * Persistence seam. Phase 1 keeps state in memory for the life of the
     * plugin; `save()` returns what a later milestone would write, and
     * `load()` is a no-op today. The shapes are fixed here so the call sites
     * never change when a backend is chosen.
     */
    save() {
      return {
        version: 1,
        savedAt: now(),
        selectedKey,
        favorite: Array.from(favorite),
        liked: Array.from(liked),
      };
    },

    load(record) {
      if (!record || typeof record !== 'object') return store;
      const restore = (values) =>
        new Set(
          (Array.isArray(values) ? values : [])
            .map((value) => String(value))
            .filter((value) => byKey.has(value)),
        );
      favorite = restore(record.favorite);
      liked = restore(record.liked);
      selectedKey = typeof record.selectedKey === 'string' && byKey.has(record.selectedKey) ? record.selectedKey : null;
      emit();
      return store;
    },
  };

  return store;
}
