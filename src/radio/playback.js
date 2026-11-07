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
 * @param options.attachStream - (audio, url, onError) => { detach(), ready? } | null.
 *   A handle owns the source; null keeps the native path. An optional `ready`
 *   promise resolves to the final handle (or null) after a cancellable chunk load.
 */
export function createPlaybackCore(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const slowLoadMs = Number.isFinite(opts.slowLoadMs) ? opts.slowLoadMs : SLOW_LOAD_MS;
  const createAudio =
    typeof opts.createAudio === 'function'
      ? opts.createAudio
      : () => (typeof Audio === 'function' ? new Audio() : null);
  const attachStream = typeof opts.attachStream === 'function' ? opts.attachStream : null;

  let audio = null;
  /** The attacher's handle while it owns the element's source (HLS). */
  let streamHandle = null;
  let sourceNeedsReload = true;
  let created = 0;
  let status = 'idle';
  let stationId = null;
  let url = null;
  let error = null;
  let startedAt = 0;
  /** The station id this element's handlers were bound for. */
  let boundHandlers = false;
  let disposed = false;
  let generation = 0;
  let timer = null;
  let retries = 0;
  const schedule = opts.setTimeout || setTimeout;
  const cancel = opts.clearTimeout || clearTimeout;
  const startupMs = Number.isFinite(opts.startupMs) ? opts.startupMs : 15000;
  // A link that flapped for less than this is noise, not an outage worth reopening for.
  const resumeAfterOnlineMs = 1500;
  const stallMs = Number.isFinite(opts.stallMs) ? opts.stallMs : 15000;
  // Three attempts total: the initial connection plus retries after 1s and 2s.
  const retryDelays = [1000, 2000];
  const maxRetries = retryDelays.length;
  const online = opts.isOnline || (() => globalThis.navigator?.onLine !== false);
  const eventTarget = opts.eventTarget || globalThis.window;
  let retryPending = false;
  let offlineAt = null;
  let stableAt = null;
  let stableMediaTime = 0;
  let stableReported = false;
  let lastTime = null;
  const failedStations = new Set();

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  /** Let go of a source the attacher owns before the element is reused. */
  function detachStream() {
    sourceNeedsReload = true;
    const handle = streamHandle;
    streamHandle = null;
    if (handle && typeof handle.detach === 'function') {
      try {
        handle.detach();
      } catch {
        /* an attached player may already be gone */
      }
    }
  }

  /**
   * Offline is a failure the user can see, not a pause. It never counts
   * against the station: the network dropped, the stream did not.
   */
  function failOffline() {
    clearTimer();
    generation += 1;
    retryPending = false;
    stableAt = null;
    detachStream();
    status = 'error';
    error = 'offline';
    try { if (audio) audio.pause(); } catch { /* detached */ }
    emit();
  }

  function fail(reason, exhausted = false) {
    clearTimer();
    generation += 1;
    retryPending = false;
    stableAt = null;
    detachStream();
    if (!online()) return failOffline();
    if (exhausted) {
      const id = stationId;
      const token = generation;
      failedStations.add(String(id));
      try { opts.onFailure?.(id); } catch { /* evidence is optional */ }
      let next = null;
      if (failedStations.size < 3) {
        try { next = opts.nextStation?.(new Set(failedStations)); } catch { /* no eligible station */ }
      }
      if (token !== generation || disposed) return;
      if (next && next.id && next.url) return core.play(next.id, next.url, true);
      // Nothing left to hop to: fall through and keep the failure visible. A
      // bare pause here looks exactly like the user pressing pause, so the card
      // would say "paused" for a stream that never played.
    }
    status = 'error';
    error = reason;
    try { if (audio) audio.pause(); } catch { /* detached */ }
    emit();
  }

  function recover(reason) {
    if (disposed || retryPending || !url || (status !== 'loading' && status !== 'playing')) return;
    if (!online()) return failOffline();
    clearTimer();
    if (retries >= maxRetries) return fail(reason, true);
    const delay = retryDelays[Math.min(retries, retryDelays.length - 1)] || 0;
    retries += 1;
    retryPending = true;
    stableAt = null;
    status = 'loading';
    const token = ++generation;
    try { audio.pause(); } catch { /* detached */ }
    detachStream();
    timer = schedule(() => {
      timer = null;
      if (token === generation && !disposed) startAttempt(true);
    }, delay);
    emit();
  }

  function arm(delay, reason) {
    clearTimer();
    const token = generation;
    timer = schedule(() => {
      timer = null;
      if (token === generation) recover(reason);
    }, delay);
  }

  function startAttempt(reload) {
    if (!online()) return failOffline();
    clearTimer();
    const token = ++generation;
    retryPending = false;
    stableAt = null;
    stableReported = false;
    lastTime = null;
    status = 'loading';
    error = null;
    startedAt = now();
    const reject = (cause) => {
      if (disposed || token !== generation) return;
      const reason = typeof cause === 'string' ? cause : `play-failed:${cause?.name || 'unknown'}`;
      if (reason === 'blocked-by-browser' || reason === 'play-failed:NotAllowedError') return fail('blocked-by-browser');
      if (reason === 'load-aborted' || reason === 'play-failed:AbortError') return fail('load-aborted');
      recover(reason);
    };
    const startPlayback = () => {
      sourceNeedsReload = false;
      emit();
      if (token !== generation || disposed) return;
      arm(startupMs, 'startup-timeout');
      // Attached sources play from their manifest handler; a resume still
      // needs an explicit play because that manifest event already happened.
      if (!streamHandle || !reload) {
        try { Promise.resolve(audio.play()).catch(reject); } catch (reason) { reject(reason); }
      }
    };
    if (!reload) { startPlayback(); return; }
    try { audio.pause(); } catch { /* detached */ }
    detachStream();
    let attached = null;
    try {
      attached = attachStream?.(audio, url, (reason) => reject(reason || 'attach-failed'));
    } catch {
      return fail('bad-url');
    }
    if (token !== generation || disposed) {
      try { attached?.detach?.(); } catch { /* superseded source */ }
      return;
    }
    const finishAttachment = (handle) => {
      streamHandle = handle && typeof handle === 'object' ? handle : null;
      if (!streamHandle) {
        try { audio.src = url; } catch { return fail('bad-url'); }
      }
      startPlayback();
    };
    if (attached?.ready) {
      streamHandle = attached;
      Promise.resolve(attached.ready).then((handle) => {
        if (!disposed && token === generation) finishAttachment(handle);
      }, reject);
      emit();
      if (token !== generation || disposed) return;
      // Loading player code is bounded separately and never penalizes a station.
      timer = schedule(() => {
        timer = null;
        if (token === generation && !disposed) fail('hls-load-timeout');
      }, startupMs);
      return;
    }
    finishAttachment(attached);
  }
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
        if (disposed || retryPending) return;
        if (status === 'loading' || status === 'playing') {
          clearTimer();
          if (stableAt === null) {
            stableAt = now();
            stableMediaTime = Number(audio.currentTime) || 0;
          }
          const token = generation;
          transition('playing', { error: null });
          if (token === generation && status === 'playing' && !disposed) arm(stallMs, 'stall-timeout');
        } else {
          try { audio.pause(); } catch { /* cancelled playback */ }
        }
      });
      audio.addEventListener('pause', () => {
        // A pause the element reports on its own (a stream that ended, the OS
        // pausing media) is a real state change, not a no-op.
        if (disposed) return;
        if (status === 'playing') {
          clearTimer();
          generation += 1;
          transition('paused');
        }
      });
      audio.addEventListener('error', () => {
        if (disposed) return;
        if (status !== 'loading' && status !== 'playing') return;
        const reason = describeMediaError(audio);
        if (reason === 'load-aborted') fail(reason);
        else recover(reason);
      });
      const stalled = () => {
        if (!disposed && status === 'playing') {
          stableAt = null;
          // Repeated waiting events must not postpone the existing deadline.
          if (timer === null) arm(stallMs, 'stall-timeout');
        }
      };
      audio.addEventListener('stalled', stalled);
      audio.addEventListener('waiting', stalled);
      audio.addEventListener('timeupdate', () => {
        const time = Number(audio.currentTime);
        if (disposed || status !== 'playing' || !Number.isFinite(time) || (lastTime !== null && time <= lastTime)) return;
        lastTime = time;
        arm(stallMs, 'stall-timeout');
        if (stableAt === null) { stableAt = now(); stableMediaTime = time; }
        if (!stableReported && now() - stableAt >= 10000 && time - stableMediaTime >= 10) {
          stableReported = true;
          retries = 0;
          failedStations.clear();
          try { opts.onStable?.(stationId); } catch { /* evidence is optional */ }
        }
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
    play(nextStationId, nextUrl, automatic = false) {
      if (disposed) return core;
      const id = nextStationId === null || nextStationId === undefined ? '' : String(nextStationId);
      if (!id) return core;
      if (!automatic) failedStations.clear();

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

      clearTimer();
      generation += 1;
      // Set loading before pausing so our own pause event is not a user action.
      status = 'loading';
      stationId = id;
      url = resolved;
      retries = 0;
      if (!resolved) {
        fail('no-stream');
        return core;
      }
      startAttempt(true);
      return core;
    },

    pause() {
      if (disposed || !audio) return core;
      clearTimer();
      generation += 1;
      retryPending = false;
      stableAt = null;
      const active = status === 'playing' || status === 'loading';
      if (active) status = 'paused';
      if (streamHandle?.ready) detachStream();
      try { audio.pause(); } catch { /* already detached */ }
      if (active) emit();
      return core;
    },

    resume() {
      if (disposed || !audio || !stationId) return core;
      if (!url || status === 'playing' || status === 'loading') return core;
      retries = 0;
      failedStations.clear();
      startAttempt(sourceNeedsReload);
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
      clearTimer();
      generation += 1;
      detachStream();
      status = 'idle';
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
      eventTarget?.removeEventListener?.('offline', onOffline);
      eventTarget?.removeEventListener?.('online', onOnline);
      generation += 1;
      clearTimer();
      detachStream();
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

  const onOffline = () => {
    if (disposed || !stationId) return;
    offlineAt = now();
    if (status === 'playing' || status === 'loading') failOffline();
  };
  // The user asked for that station; when the link returns, keep the promise.
  // Debounced so a flapping link settles before the stream is reopened.
  const onOnline = () => {
    const since = offlineAt;
    offlineAt = null;
    if (disposed || status !== 'error' || error !== 'offline' || !stationId || !url) return;
    // A brief flap is noise: leave it failed and let the user decide.
    if (since !== null && now() - since < resumeAfterOnlineMs) return;
    if (online()) core.resume();
  };
  eventTarget?.addEventListener?.('offline', onOffline);
  eventTarget?.addEventListener?.('online', onOnline);
  return core;
}
