/**
 * "Is the host still there?" — the watch that silences the radio when DSH quits.
 *
 * The audio element belongs to the page. Quitting DSH destroys the window, but
 * a media element keeps rendering until the renderer really goes away, and on
 * Windows the host backend can be gone while the page is still visible: the
 * quit path shuts the server down first and kills the window afterwards. That
 * gap is what the user hears as "the radio plays for a while after I quit".
 *
 * `pagehide` covers the ordinary case (the page is being torn down: stop now).
 * This watcher covers the other half: while the page is hidden and audible,
 * ask the host whether it is still answering. A live host means the app is
 * merely minimised and the music continues — the radio is a background player,
 * not a foreground toy. A host that stops answering twice in a row means the
 * app is on its way out, so the page stops the sound itself instead of waiting
 * to be killed.
 *
 * Pure logic: the clock, the probe and the timers are injected, so the node
 * test drives it without a browser or a network.
 */

/** How often a hidden, audible page asks the host whether it is still alive. */
export const HOST_PROBE_INTERVAL_MS = 3000;

/** Consecutive unanswered probes before the page decides the app is quitting. */
export const HOST_PROBE_MISSES = 2;

/**
 * @param options.probe        - async () => boolean; true while the host answers
 * @param options.onDead       - called once, when the host has stopped answering
 * @param options.active       - () => boolean; false means "nothing to watch now"
 * @param options.intervalMs   - probe spacing (default 3000)
 * @param options.maxMisses    - unanswered probes that count as gone (default 2)
 * @param options.setInterval  - injected timer, for tests
 * @param options.clearInterval- injected timer disposal, for tests
 */
export function createHostWatch(options) {
  const opts = options || {};
  const probe = typeof opts.probe === 'function' ? opts.probe : async () => true;
  const onDead = typeof opts.onDead === 'function' ? opts.onDead : () => {};
  const active = typeof opts.active === 'function' ? opts.active : () => true;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : HOST_PROBE_INTERVAL_MS;
  const maxMisses = Number.isFinite(opts.maxMisses) ? opts.maxMisses : HOST_PROBE_MISSES;
  const setTimer =
    typeof opts.setInterval === 'function' ? opts.setInterval : (fn, ms) => setInterval(fn, ms);
  const clearTimer =
    typeof opts.clearInterval === 'function' ? opts.clearInterval : (id) => clearInterval(id);

  let timer = null;
  let failures = 0;
  let dead = false;
  let probing = false;
  // Bumped by every stop(): a probe already in flight belongs to the interval
  // that asked for it, and its answer must not count against a later one.
  let generation = 0;

  const stop = () => {
    generation += 1;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    failures = 0;
    return api;
  };

  async function tick() {
    if (dead || probing) return;
    // The reason to watch can disappear between two ticks (paused, visible
    // again): stop on the next one instead of probing a page nobody asked for.
    if (!active()) {
      stop();
      return;
    }
    const epoch = generation;
    probing = true;
    let answered = false;
    try {
      answered = (await probe()) === true;
    } catch {
      answered = false;
    } finally {
      probing = false;
    }
    if (dead || epoch !== generation) return;
    if (answered) {
      failures = 0;
      return;
    }
    failures += 1;
    if (failures < maxMisses) return;
    dead = true;
    stop();
    onDead();
  }

  function start() {
    if (dead || timer !== null) return api;
    failures = 0;
    timer = setTimer(tick, intervalMs);
    return api;
  }

  const api = {
    /** Begin probing, idempotent while already running. */
    start,
    /** Stop probing and forget the failure count; the watch may start again. */
    stop,
    /**
     * Give a dead watch a fresh budget. The page calls this when the user
     * starts playing again: that is a new audible attempt, and the old verdict
     * ("the host was gone a minute ago") says nothing about this one.
     */
    rearm() {
      if (!dead) return api;
      dead = false;
      failures = 0;
      generation += 1;
      return api;
    },
    isWatching: () => timer !== null,
    isDead: () => dead,
    stats: () => ({ failures }),
  };
  return api;
}
