/**
 * The local catalogue cache.
 *
 * Two facts are worth keeping between sessions, and neither belongs to a
 * server:
 *
 *   catalog    the last successful Radio Browser rows, so a cold start paints
 *              the scene before the network answers (or when it does not).
 *   blacklist  station ids whose stream failed to play. A station that could
 *              not be played once is filtered out of the next load instead of
 *              being offered again.
 *
 * IndexedDB is the store because the catalogue is far past `localStorage`'s
 * 5 MB ceiling: 5,000 rows run to roughly 6 MB, and structured cloning is
 * exactly what IndexedDB does. Every operation resolves; a private window, a
 * quota error, a blocked upgrade or an absent implementation degrades to "no
 * cache" and never to a thrown error — the data chunk's contract is that a
 * cache is an optimisation, not a dependency.
 *
 * The module is deliberately DOM-free apart from the `indexedDB` global: the
 * node-side tests and the build both import it, and there it simply reports no
 * cache.
 */

/** How long a cached catalogue is considered current. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** How many failed station ids are remembered; the oldest fall off first. */
export const BLACKLIST_LIMIT = 500;

const DB_NAME = 'dsh-blackhole-radio-lab';
const DB_VERSION = 1;
const STORE = 'kv';
const CATALOG_KEY = 'catalog:v1';
const BLACKLIST_KEY = 'blacklist:v1';

/**
 * A blocked upgrade (another tab holds an older version open) must not stall
 * the boot: the panel would wait for a cache it does not need.
 */
const OPEN_TIMEOUT_MS = 1500;

/** One connection per module instance; a second open is never worth a second handle. */
let dbPromise = null;

/**
 * Blacklist writes are read-modify-write across two transactions. Two failed
 * streams reported at once (or two tabs) would otherwise both read the same
 * set and the later write would drop the earlier id. One queue per module
 * keeps those writes ordered; a rejected task never blocks the next one.
 */
let writeQueue = Promise.resolve();

function enqueueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function indexedDbAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb() {
  if (!indexedDbAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (db) => {
      if (settled) {
        // A blocked open can still succeed later; that connection is not used,
        // so close it instead of leaving it blocking the next upgrade.
        if (db && typeof db.close === 'function') db.close();
        return;
      }
      settled = true;
      if (timer !== null) clearTimeout(timer);
      // A failed open must not be remembered as "this browser has no cache":
      // a blocked upgrade or a slow disk is worth one retry on the next boot.
      if (!db) dbPromise = null;
      resolve(db || null);
    };

    timer = setTimeout(() => finish(null), OPEN_TIMEOUT_MS);

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      finish(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      try {
        if (db && !db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      } catch {
        /* the read below reports the missing store as no cache */
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });

  return dbPromise;
}

function readKey(db, key) {
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch {
      resolve(null);
      return;
    }
    let request;
    try {
      request = tx.objectStore(STORE).get(key);
    } catch {
      resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
    request.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

function writeKey(db, key, value) {
  return new Promise((resolve) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve(false);
      return;
    }
    try {
      tx.objectStore(STORE).put(value, key);
    } catch {
      resolve(false);
      return;
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function toIdSet(record) {
  const ids = record && Array.isArray(record.ids) ? record.ids : [];
  return new Set(ids.map((id) => String(id)).filter(Boolean));
}

/**
 * Open the cache, or resolve `null` when this environment has none.
 *
 * @returns {Promise<null | {
 *   readCatalog: () => Promise<null | { rows: object[], fetchedAt: number, version: number }>,
 *   writeCatalog: (rows: object[], fetchedAt?: number) => Promise<boolean>,
 *   readBlacklist: () => Promise<Set<string>>,
 *   addBlacklisted: (id: string) => Promise<boolean>,
 * }>}
 */
export async function openRadioCache() {
  const db = await openDb();
  if (!db) return null;

  return {
    /**
     * The last catalogue for one query shape, or null when there is none.
     *
     * The key carries the query shape (limit/pageSize/order): raising the
     * station limit must not keep serving a catalogue that was fetched for the
     * old shape until the TTL expires. A record from a future version is
     * ignored rather than migrated: this is a cache, not data.
     */
    async readCatalog(key) {
      const record = await readKey(db, key || CATALOG_KEY);
      if (!record || !Array.isArray(record.rows) || record.rows.length === 0) return null;
      if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) return null;
      if (record.version !== undefined && record.version !== 1) return null;
      return { rows: record.rows, fetchedAt: record.fetchedAt, version: 1 };
    },

    /** Replace the cached catalogue for one query shape. `false` means it was not stored (quota, private mode). */
    async writeCatalog(rows, fetchedAt, key) {
      if (!Array.isArray(rows) || rows.length === 0) return false;
      const stamp = typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : Date.now();
      return writeKey(db, key || CATALOG_KEY, { rows, fetchedAt: stamp, version: 1 });
    },

    /** Station ids that must not be offered again. */
    async readBlacklist() {
      return toIdSet(await readKey(db, BLACKLIST_KEY));
    },

    /**
     * Remember one failed station. Idempotent, and bounded: the oldest ids fall
     * off once {@link BLACKLIST_LIMIT} is reached, so a long-lived profile does
     * not accumulate forever.
     *
     * Serialised through {@link enqueueWrite}: the read and the write are two
     * transactions, and two failures reported at once must not overwrite each
     * other's id.
     */
    async addBlacklisted(id) {
      const key = String(id || '').trim();
      if (!key) return false;
      return enqueueWrite(async () => {
        const ids = toIdSet(await readKey(db, BLACKLIST_KEY));
        if (ids.has(key)) return true;
        ids.add(key);
        const trimmed = Array.from(ids).slice(-BLACKLIST_LIMIT);
        return writeKey(db, BLACKLIST_KEY, { ids: trimmed, updatedAt: Date.now() });
      });
    },
  };
}
