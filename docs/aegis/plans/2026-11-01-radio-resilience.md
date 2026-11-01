# Radio resilience and continuity

## Authorized scope
User approved playback recovery, recoverable failed sources, volume/last successfully played station memory, system media controls and background metadata throttling. This is scoped secondary approval for behavior inside the frozen station card, not its appearance, previous-history or random-next semantics. No commits or pushes.

## Baseline
Existing dirty files: src/stage.js and client.stage.js. Preserve both byte-for-byte. Own only radio source modules, client integration, Host library schema, focused tests and documentation. Build only radio chunk; do not rebuild dirty stage.

## Design and sequence
1. Playback owner: one audio element, bounded same-station startup/stall recovery, generation-guarded async results, cancellation on pause/stop/dispose. No automatic station failover. Distinguish blocked autoplay from transient failures.
2. Cache owner: timestamped failed-source cooldown, expiry on catalog load, successful playback clears failure. Legacy untimestamped IDs become eligible rather than permanently suppressing stations. Preserve independent user favorites.
3. Store/Host library: persist validated volume and last successful station, preserve legacy version-2 fields. Restore without sound, never overwrite user changes made during hydration. Session previous-history remains unchanged.
4. Shared runtime: lifecycle-owned MediaSession play/pause/stop and metadata; no next/previous interception. Visibility-aware metadata polling, cancel pending queries, immediate foreground refresh. Audio continues while hidden.
5. Tests: fake clock/audio recovery races; schema compatibility and hydration; cache cooldown; media ownership and polling lifecycle; composition and built chunk smoke. Evaluate client entry using vm ModuleLoader and stub require, assert inject/apply exports. Independent read-only review before delivery.

## Acceptance
No indefinite loading, bounded retries, no stale async state after switch/pause/stop, no autoplay-block blacklist, no duplicate audio. Cold boot restores volume/station without playing. Hidden page does not poll song metadata; foreground refreshes. Plugin teardown releases timers/listeners/media controls and audio. Existing marks survive migration. Frozen visual/history/random code and existing stage changes preserved.

## Boundaries and evidence
No new dependencies, external code copying, AI recommendation, HLS or new visuals. Unit tests prove covered behavior, not real station audibility or GPU performance. Host runtime verification reported separately if unavailable.

## Progress
First implementation completed for all five owners; verification/review repairs in progress. Added focused unit suite tools/test-radio-resilience.mjs: 7/7 passing before latest review repairs; tools/test-radio-entry.mjs passes actual entry evaluation/factory and built radio export smoke. Radio-only build succeeded with new --radio-only build flag. Existing tools/test-transition.mjs passes all reported checks. Stage source/artifact not rebuilt.

Read-only reviewer 52d3512c-4358-4c35-95ef-4e3e0cf5cbb7 identified hydration-default-volume race, empty-selection last station restore, media-session foreign ownership, and stale hydration teardown. Main agent applied fixes; final regression and re-review still needed. Native media ownership uses metadata identity plus claims only on entering playing; cannot detect external handler-only takeover, must report limitation or integrate explicit ownership if public API exists.

Final verification (after review repairs): `npm test` = transition contracts + 9/9 focused resilience tests + entry evaluation, all green; `node tools/build-stage.mjs --radio-only` rebuilt client.radio.js (65,459 B). Stage source/artifact hashes were already changed by work outside this task before the final build and were not written by it (hashes identical before and after the build); the task-start backup of the dirty pair was not used to overwrite anything.

Read-only reviewer final pass found no remaining blocking defect. Known non-blocking boundaries:

- Failed-source cooldown takes effect on the next catalogue initialisation (6 h), not mid-session. Explicitly in scope per plan; no interval rebuild added.
- Native media ownership is proven by metadata identity; an external takeover that only replaces action handlers without touching metadata is not detectable. Documented in README.
- `tools/validate-state.mjs` (legacy, not in npm scripts) still asserts that unknown favourites are dropped, while the store at HEAD already documents and implements preserving them. Pre-existing contradiction, not caused by this task; left unchanged and reported.

Not verified: real station audibility, HLS sources, browser-native media-key behaviour, GPU/stage runtime. README (zh/en) updated for the new recoverable-quarantine, media-control and memory behaviour.

## Follow-up defect: audio kept playing after DSH quit (m00853)

Symptom: quitting DSH left the radio audible for a while. Cause: on Windows the quit path shuts the backend down before destroying the window, so the renderer page stays alive; the plugin had no `pagehide`/visibility handling at all and the only stop point was the plugin-unload cleanup (client.js `ctx.effect` disposer), which does not run early enough.

Fix (A+B, approved by the user): `pagehide` disposes immediately unless bfcache; while the page is hidden and audible, the page probes `/blackhole-radio-lab/config` every 3 s, treats any HTTP answer as alive, counts only a refused/2.5 s-timeout connection as a miss, and stops playback after two consecutive misses. `src/radio/host-watch.js` holds the timer/counter logic (injectable clock); `client.js` wires `watchUnload`, `armHostWatch`, `syncHostWatch`, and clears listeners/timers in `dispose`.

Review-driven hardening: single-flight probe (an in-flight probe skips the next tick), generation counter so a `stop()` invalidates in-flight results (no stale failure can kill a visible session), rearm on the next audible attempt so a dead watch does not silence the whole session, HTTP status ignored for liveness, and `AbortSignal.timeout` feature-guarded.

Verification: `npm test` green (transition contracts + 15/15 resilience + entry evaluation); `--radio-only` rebuild produced client.radio.js 66,393 B; stage source/artifact untouched (mtime still from the external 12:51 edit). Backup kept outside the repo in the local DSH backups directory (`radio-quit-silence-20261101-1408`). Not verified on the real Electron quit path; hidden-window probing cannot help if the window is still visible during quit, where only `pagehide` remains.
