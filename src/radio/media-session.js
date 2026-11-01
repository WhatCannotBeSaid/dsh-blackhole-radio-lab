/**
 * Optional global media controls.
 *
 * Ownership is cooperative: the session is claimed only while this plugin is
 * audible, and released as soon as it stops, so a host with its own player is
 * not silenced by a card that merely exists. The identity of the metadata this
 * owner installed is what proves "still ours": if something else replaces it,
 * the session belongs elsewhere and this owner leaves it alone.
 */
const owners = new WeakMap();

export function bindMediaSession(
  playback,
  stationFor,
  session = globalThis.navigator?.mediaSession,
  Metadata = globalThis.MediaMetadata,
) {
  // Without a metadata constructor there is no way to prove ownership, so the
  // plugin stays out of the native session entirely rather than fight for it.
  if (!session || typeof Metadata !== 'function') return () => {};
  const owner = {};
  let installed = false;
  let metadata = null;
  let previousStatus = null;

  const stillOurs = () => installed && owners.get(session) === owner && session.metadata === metadata;

  const release = () => {
    if (!installed) return;
    installed = false;
    if (owners.get(session) === owner) owners.delete(session);
    if (session.metadata !== metadata) return;
    for (const action of ['play', 'pause', 'stop']) {
      try { session.setActionHandler(action, null); } catch { /* optional action */ }
    }
    try { session.metadata = null; session.playbackState = 'none'; } catch { /* unsupported */ }
  };

  const claim = (state) => {
    let next;
    try {
      const station = stationFor(state.stationId);
      next = new Metadata({ title: (station && station.name) || 'Radio', artist: 'Black Hole Radio' });
      session.metadata = next;
    } catch {
      return; // metadata is optional: no proof of ownership, so no handlers
    }
    metadata = next;
    owners.set(session, owner);
    installed = true;
    const handlers = { play: () => playback.resume(), pause: () => playback.pause(), stop: () => playback.stop() };
    for (const [action, handler] of Object.entries(handlers)) {
      try { session.setActionHandler(action, handler); } catch { /* optional action */ }
    }
    try { session.playbackState = 'playing'; } catch { /* unsupported */ }
  };

  const unsubscribe = playback.subscribe((state) => {
    const entered = state.status !== previousStatus;
    previousStatus = state.status;
    if (state.status === 'playing') {
      if (entered) claim(state);
      return;
    }
    if (state.status === 'paused') {
      if (!stillOurs()) return;
      try { session.playbackState = 'paused'; } catch { /* unsupported */ }
      return;
    }
    if (state.status === 'idle' || state.status === 'error') release();
  });

  return () => { unsubscribe(); release(); };
}
