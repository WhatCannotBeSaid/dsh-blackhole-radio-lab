/**
 * The playback core — the only thing in this plugin that produces sound.
 *
 * One audio element, created lazily by a factory, owned by the plugin's
 * `apply()` scope rather than by any view. Nothing here knows about React, the
 * DOM tree the panel renders, or three.js. Disposing a panel, switching from
 * the black hole to the nebula, or tearing down the WebGL context cannot reach
 * this object: it is created one level above all of them and destroyed only
 * when the plugin itself unloads.
 *
 * ## Two owners, two facts
 *
 * `selected` lives in store.js; `playing` lives here. The card reads both. A
 * store that mirrored `playingId` would be a second source for one fact, so it
 * deliberately does not.
 *
 * ## Why a factory instead of `new Audio()` inline
 *
 * An `HTMLAudioElement` is never attached to the document, so a test cannot
 * count instances with `querySelectorAll('audio')`. The element is created
 * through an injected factory instead, which lets a test substitute a fake and
 * assert "exactly one element was ever created" across any sequence of plays,
 * pauses, switches and view unmounts. `stats()` exposes the same counters for
 * a runtime probe.
 *
 * ## Status machine
 *
 *   idle ──play()──► loading ──playing──► playing ──pause()──► paused
 *     ▲                 │                    │                   │
 *     └──stop()─────────┴────error──► error    └────resume()──────┘
 */

/** How long a `play()` may sit without reaching `playing` before it is slow. */
export const SLOW_LOAD_MS = 10000;

/**
 * @param options.createAudio - () => audio-like object (tests inject a fake)
 * @param options.now         - clock, injected for tests
 * @param options.slowLoadMs  - threshold for the "slow load" notice
 */
export function createPlaybackCore(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const slowLoadMs = Number.isFinite(opts.slowLoadMs) ? opts.slowLoadMs : SLOW_LOAD_MS;
  const createAudio =
    typeof opts.createAudio === 'function'
      ? opts.createAudio
      : () => (typeof Audio === 'function' ? new Audio() : null);

  let audio = null;
  let created = 0;
  let status = 'idle';
  let stationId = null;
  let url = null;
  let error = null;
  let startedAt = 0;
  /** The station id this element's handlers were bound for. */
  let boundHandlers = false;
  let disposed = false;
  /**
   * 0..1. It lives here, beside the element, because it is a property of the
   * audio output and not of whichever view happens to be on screen: a volume
   * set from the sidebar card must still be in force after that card unmounts.
   */
  let volume = 1;
  const listeners = new Set();
  /**
   * Bumped on every mutation, like the store's. `useShared` refreshes its memo
   * only when the snapshot carries a new version, so a snapshot without one
   * would pin every subscriber to the state it first saw.
   */
  let version = 0;

  function snapshot() {
    return {
      version,
      status,
      stationId,
      url,
      error,
      // Seconds since play() for a pending load; 0 when nothing is pending.
      pendingMs: status === 'loading' && startedAt ? now() - startedAt : 0,
      slow: status === 'loading' && startedAt ? now() - startedAt >= slowLoadMs : false,
      volume,
    };
  }

  function emit() {
    version += 1;
    const state = snapshot();
    for (const listener of Array.from(listeners)) {
      try {
        listener(state);
      } catch {
        /* a subscriber's failure must not strand the audio element */
      }
    }
  }

  /** Apply a status change and notify. Mutates the closure, then emits. */
  function transition(next, patch) {
    status = next;
    if (patch && 'error' in patch) error = patch.error;
    emit();
  }

  /** Create the element exactly once, and bind its events exactly once. */
  function ensureAudio() {
    if (audio || disposed) return audio;
    let element = null;
    try {
      element = createAudio();
    } catch {
      element = null;
    }
    if (!element) {
      error = 'audio-unavailable';
      return null;
    }
    audio = element;
    created += 1;
    // A fresh element starts at the browser default; restore what the user set.
    try {
      audio.volume = volume;
    } catch {
      /* an embedder may expose volume as read-only */
    }
    if (!boundHandlers && typeof audio.addEventListener === 'function') {
      boundHandlers = true;
      audio.addEventListener('playing', () => {
        if (disposed) return;
        if (status === 'loading' || status === 'paused') transition('playing', { error: null });
      });
      audio.addEventListener('pause', () => {
        // A pause the element reports on its own (a stream that ended, the OS
        // pausing media) is a real state change, not a no-op.
        if (disposed) return;
        if (status === 'playing') transition('paused');
      });
      audio.addEventListener('error', () => {
        if (disposed) return;
        if (status === 'idle') return;
        transition('error', { error: describeMediaError(audio) });
      });
      audio.addEventListener('stalled', () => {
        /* a stalled stream is not an error yet; the slow notice covers it */
      });
    }
    return audio;
  }

  function describeMediaError(element) {
    const mediaError = element && element.error;
    if (mediaError && typeof mediaError.code === 'number') {
      switch (mediaError.code) {
        case 1:
          return 'load-aborted';
        case 2:
          return 'network';
        case 3:
          return 'decode';
        case 4:
          return 'unsupported-or-unreachable';
        default:
          return `media-${mediaError.code}`;
      }
    }
    return 'unknown';
  }

  const core = {
    /**
     * Play one station.
     *
     * The station id is required: an element that plays without saying which
     * station it belongs to is exactly how the two owners of "what is playing"
     * drift apart.
     */
    play(nextStationId, nextUrl) {
      if (disposed) return core;
      const id = nextStationId === null || nextStationId === undefined ? '' : String(nextStationId);
      if (!id) return core;

      const element = ensureAudio();
      if (!element) {
        stationId = id;
        url = nextUrl ? String(nextUrl) : null;
        error = 'audio-unavailable';
        status = 'error';
        emit();
        return core;
      }

      const resolved = nextUrl ? String(nextUrl) : null;
      // Toggling the same station: play means resume, not restart.
      if (stationId === id && url === resolved && (status === 'paused' || status === 'loading')) {
        return core.resume();
      }

      stationId = id;
      url = resolved;
      error = null;
      startedAt = now();
      status = resolved ? 'loading' : 'error';
      if (!resolved) error = 'no-stream';
      emit();
      if (!resolved) return core;

      try {
        if (typeof element.pause === 'function') element.pause();
      } catch {
        /* pausing a fresh element can throw in odd engines; ignore */
      }
      try {
        element.src = resolved;
      } catch {
        status = 'error';
        error = 'bad-url';
        emit();
        return core;
      }
      try {
        const attempt = element.play();
        if (attempt && typeof attempt.catch === 'function') {
          // Autoplay policy and network failures both land here. The `error`
          // event usually follows; recording it now makes the state honest
          // even when the element never emits one.
          attempt.catch((reason) => {
            if (disposed) return;
            if (stationId !== id) return;
            status = 'error';
            error = reason && reason.name === 'NotAllowedError' ? 'blocked-by-browser' : `play-failed:${(reason && reason.name) || 'unknown'}`;
            emit();
          });
        }
      } catch (reason) {
        status = 'error';
        error = `play-failed:${(reason && reason.name) || 'unknown'}`;
        emit();
      }
      return core;
    },

    pause() {
      if (disposed || !audio) return core;
      try {
        audio.pause();
      } catch {
        /* already detached */
      }
      if (status === 'playing' || status === 'loading') {
        status = 'paused';
        emit();
      }
      return core;
    },

    resume() {
      if (disposed || !audio || !stationId) return core;
      status = 'loading';
      error = null;
      startedAt = now();
      emit();
      try {
        const attempt = audio.play();
        if (attempt && typeof attempt.catch === 'function') {
          attempt.catch((reason) => {
            if (disposed) return;
            status = 'error';
            error = reason && reason.name === 'NotAllowedError' ? 'blocked-by-browser' : `play-failed:${(reason && reason.name) || 'unknown'}`;
            emit();
          });
        }
      } catch (reason) {
        status = 'error';
        error = `play-failed:${(reason && reason.name) || 'unknown'}`;
        emit();
      }
      return core;
    },

    /** Convenience: play if idle/other station, pause if this one is playing. */
    toggle(nextStationId, nextUrl) {
      if (!nextStationId) return core;
      const id = String(nextStationId);
      if (stationId === id && status === 'playing') return core.pause();
      if (stationId === id && status === 'paused') return core.resume();
      return core.play(id, nextUrl);
    },

    /** Stop and release the current source; the element itself stays alive. */
    stop() {
      if (disposed) return core;
      if (audio) {
        try {
          audio.pause();
        } catch {
          /* detached */
        }
        try {
          audio.removeAttribute && audio.removeAttribute('src');
        } catch {
          /* not every engine exposes removeAttribute on media elements */
        }
      }
      stationId = null;
      url = null;
      error = null;
      startedAt = 0;
      status = 'idle';
      emit();
      return core;
    },

    /**
     * Set the output level, 0..1.
     *
     * It is applied to the element that exists now and remembered for the one
     * that may be created later, so the level survives a stop() or a source
     * switch. Values outside the range are clamped, not rejected.
     */
    setVolume(next) {
      if (disposed) return core;
      const value = Number(next);
      if (!Number.isFinite(value)) return core;
      const clamped = Math.min(1, Math.max(0, value));
      if (clamped === volume) return core;
      volume = clamped;
      if (audio) {
        try {
          audio.volume = clamped;
        } catch {
          /* read-only volume is not a reason to lose the state */
        }
      }
      emit();
      return core;
    },

    getVolume() {
      return volume;
    },

    getState() {
      return snapshot();
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      // A late subscriber still needs the current value once.
      try {
        listener(snapshot());
      } catch {
        /* ignore */
      }
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * How many audio elements were ever created, and how many are alive.
     * One of each, for the whole life of the plugin, is the invariant.
     */
    stats() {
      return { created, alive: audio ? 1 : 0, bounded: boundHandlers };
    },

    /** Plugin unload: silence and drop the element. Views never call this. */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (audio) {
        try {
          audio.pause();
        } catch {
          /* detached */
        }
        try {
          audio.removeAttribute && audio.removeAttribute('src');
        } catch {
          /* not every engine exposes it */
        }
        try {
          if (typeof audio.load === 'function') audio.load();
        } catch {
          /* releasing the source is best effort */
        }
        audio = null;
      }
      listeners.clear();
      status = 'idle';
      stationId = null;
      url = null;
      error = null;
    },
  };

  return core;
}
