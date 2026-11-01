/**
 * The library — favourite stations and liked songs — as one small file on the
 * machine, owned by the Host half.
 *
 * It is not kept in the page's `localStorage` because the page's origin is not
 * durable: the desktop app serves the browser half from a local port, and a
 * different port is a different origin with its own storage. A music library
 * that empties itself the first time the port moves is not a library, so the
 * record lives where the plugin lives, next to the rest of this user's DSH data.
 *
 * The file is written whole and swapped into place with a rename, so a reader
 * at any moment sees either the previous library or the new one, never half of
 * either. Nothing here throws: a library that cannot be read is a library that
 * has not been written yet, and the store simply starts empty.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * How much a library may weigh.
 *
 * The ceiling has to hold the worst case the entry limits below allow, or the
 * caps would contradict each other: a full 4000 songs at their per-field limits
 * plus 4000 favourite keys is about 5 MiB. A library that only fits in memory
 * but not on disk is worse than a smaller one, so the byte ceiling sits above
 * that worst case and the entry caps are what actually bound the file.
 */
export const LIBRARY_MAX_BYTES = 8 * 1024 * 1024;

/** Ceiling on one list, so a runaway writer cannot grow the file without end. */
const MAX_ENTRIES = 4000;

/** Longest accepted key. Station keys (`rb:<uuid>`) and song keys fit easily. */
const MAX_TEXT = 320;

/** Longest accepted piece of display text: titles, artist names, station names. */
const MAX_LABEL = 160;

/**
 * Where the library lives.
 *
 * `DSH_HOME` is the application's data directory, which is where a plugin's own
 * records belong; the home directory is only the fallback for a process that was
 * started without it.
 *
 * @param env - environment to read, defaults to `process.env`.
 */
export function libraryFilePath(env) {
  const source = env && typeof env === 'object' ? env : process.env;
  const home = String(source.DSH_HOME || '').trim();
  const base = home || join(homedir(), '.dsh');
  return join(base, 'blackhole-radio-lab', 'library.json');
}

/**
 * Reduce whatever arrived into the record the file is allowed to hold.
 *
 * The route is reachable from anything on the local origin, so the shape is
 * rebuilt here field by field instead of being written through: only known
 * keys survive, every string is bounded, and anything unrecognised is dropped.
 *
 * @returns a clean record, or `null` when the input is not a record at all.
 */
export function sanitizeLibrary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const slice = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
  // A key is matched against the catalogue, never shown, so an over-long one is
  // refused rather than shortened: a shortened key matches no station, and the
  // mark would look saved while pointing at nothing.
  const key = (value) => (typeof value === 'string' && value && value.length <= MAX_TEXT ? value : '');

  const favorite = [];
  for (const value of Array.isArray(input.favorite) ? input.favorite : []) {
    if (favorite.length >= MAX_ENTRIES) break;
    const id = key(value);
    if (id) favorite.push(id);
  }

  const songs = [];
  for (const entry of Array.isArray(input.songs) ? input.songs : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (songs.length >= MAX_ENTRIES) break;
    const title = slice(entry.title, MAX_LABEL).trim();
    // A song without a title has no key to restore it under — the store rebuilds
    // the key from the title, which is exactly why the title is the one field
    // that cannot be missing.
    if (!title) continue;
    songs.push({
      title,
      artist: slice(entry.artist, MAX_LABEL),
      stationKey: key(entry.stationKey) || null,
      stationName: slice(entry.stationName, MAX_LABEL),
      at: Number.isFinite(entry.at) ? Math.max(0, Math.round(entry.at)) : 0,
    });
  }

  return {
    version: 2,
    savedAt: Number.isFinite(input.savedAt) ? Math.max(0, Math.round(input.savedAt)) : Date.now(),
    selectedKey: key(input.selectedKey) || null,
    ...(input.playback && typeof input.playback === 'object' ? {
      playback: {
        volume: Number.isFinite(input.playback.volume) ? Math.min(1, Math.max(0, input.playback.volume)) : 1,
        lastPlayedKey: key(input.playback.lastPlayedKey) || null,
      },
    } : {}),
    favorite,
    songs,
  };
}

/**
 * Read the library, or `null` when there is none to read.
 *
 * @param file - absolute path from {@link libraryFilePath}.
 */
export function readLibrary(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    // Bytes, not characters: the ceiling is a file size, and a Chinese title
    // costs three bytes per character.
    if (Buffer.byteLength(raw, 'utf8') > LIBRARY_MAX_BYTES) return null;
    return sanitizeLibrary(JSON.parse(raw));
  } catch {
    /* absent, unreadable, or not JSON: all three mean "nothing to restore" */
    return null;
  }
}

/**
 * Replace the library on disk.
 *
 * @returns true when the file now holds the record, false when it was rejected
 *          or could not be written.
 */
export function writeLibrary(file, record) {
  const clean = sanitizeLibrary(record);
  if (!clean) return false;
  const text = JSON.stringify(clean);
  if (Buffer.byteLength(text, 'utf8') > LIBRARY_MAX_BYTES) return false;
  // Named per process and per write: two windows writing at once would otherwise
  // share one temp path, and each would rename the other's bytes into place.
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, text, 'utf8');
    // The swap, so a concurrent read never sees a truncated library.
    renameSync(temp, file);
    return true;
  } catch {
    // A temp file left behind by a failed swap is this function's own litter,
    // not the user's data: a stale one would sit in their data directory forever.
    try {
      rmSync(temp, { force: true });
    } catch {
      /* nothing more to do */
    }
    return false;
  }
}
