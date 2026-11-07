/**
 * HLS playback, in its own lazily loaded chunk.
 *
 * A bare `.m3u8` is not a media file: it is a playlist that points at segments,
 * sometimes encrypted, sometimes fragmented MP4. Chrome plays the simplest of
 * them by itself and Electron plays none; hls.js feeds the audio element
 * through MediaSource instead, which covers both.
 *
 * This file is the `client.hls.js` chunk entry. It is fetched only when a
 * station's URL actually ends in `.m3u8`, so the plain MP3/AAC majority never
 * downloads it. The chunk is DOM-heavy by design — that is exactly why it is
 * not part of the DOM-free data chunk (`src/radio/index.js`).
 */

import Hls from 'hls.js';

/**
 * Attach `url` to an audio element through MediaSource.
 *
 * @param audio - the one element the playback core owns
 * @param url   - the playlist URL
 * @param onError - (reason) => void, called once on a fatal HLS error;
 *   `network` is recoverable, everything else means this source is unusable.
 * @returns `{ detach() }`, or null when this environment has no MediaSource
 *   (the caller then falls back to the native element).
 */
export function attachHls(audio, url, onError) {
  if (!audio || !Hls || typeof Hls.isSupported !== 'function' || !Hls.isSupported()) return null;
  let disposed = false;
  const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
  const report = (reason) => {
    if (disposed) return;
    disposed = true;
    try {
      hls.destroy();
    } catch {
      /* already torn down */
    }
    if (typeof onError === 'function') onError(reason);
  };
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data || !data.fatal) return;
    // A missing segment or a 404 playlist is the station's problem; a timeout
    // or a reset connection is worth one more attempt. Only a real media
    // decode failure indicts the source as broken — an append or parsing
    // error says nothing about whether the station is alive.
    report(
      data.type === 'networkError'
        ? 'network'
        : data.type === 'mediaError'
          ? 'decode'
          : 'unsupported-or-unreachable',
    );
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (disposed) return;
    try {
      const started = audio.play();
      if (started && typeof started.catch === 'function') {
        // Swallowing this used to turn an autoplay block into a 15-second
        // startup timeout; report it so the core names the real cause.
        started.catch((error) => {
          const name = (error && error.name) || 'unknown';
          report(name === 'NotAllowedError' ? 'blocked-by-browser' : `play-failed:${name}`);
        });
      }
    } catch (error) {
      const name = (error && error.name) || 'unknown';
      report(name === 'NotAllowedError' ? 'blocked-by-browser' : `play-failed:${name}`);
    }
  });
  hls.loadSource(url);
  hls.attachMedia(audio);
  return {
    detach() {
      if (disposed) return;
      disposed = true;
      try {
        hls.destroy();
      } catch {
        /* destroying twice is harmless */
      }
    },
  };
}
