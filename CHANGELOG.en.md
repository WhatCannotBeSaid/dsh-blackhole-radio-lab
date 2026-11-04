# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The Chinese edition is [CHANGELOG.md](CHANGELOG.md).

## [1.2.1] - 2026-11-04

### Security: a track probe can no longer reach the local network

- The private-address check used to be a spelling match only, so a public name that resolved to loopback slipped through. Every hop is now checked twice: literals first, then DNS, and one private answer in the lookup refuses the name — including IPv4-mapped forms such as `::ffff:127.0.0.1` and `::ffff:7f00:1`. A lookup that fails is refused too, instead of the old "cannot resolve, let it through".
- Redirects are followed by hand with `redirect: 'manual'`: each 3xx target is checked before the next request goes out, five hops at most, after which the read ends as `redirect-blocked`. With `redirect: 'follow'` only the final URL was re-checked, and the request into the local network had already been sent.
- The DNS lookup shares the read's six-second cap, so a hung resolver no longer holds a concurrency slot.
- `/blackhole-radio-lab/now-playing` now checks `sec-fetch-site`: a probe started by another site is answered with 403, the same rule the library write already used.
- New `tools/test-now-playing.mjs` (17 cases), wired into `npm test`.

### Cluster → hole: a per-point phased arrival

- The return no longer cross-fades the disk against the fragments. The shadow reaches its final size first (progress 0.72), the first star lands at 0.74, and the disk fades in locally at the traced gas positions instead of a stand-in disc drawn over them.
- Each point carries its own phase and stays round the whole way: stars in flight, disk pixels where they land.
- `discReturnProgress` inverts the timeline's ease and `discReturnPhase` interleaves locally, with no angular wipe cutting through the light band.
- The hole view's far stop is no longer derived from the shadow's size; both spaces share the field layout's limit, so opening the sidebar no longer shrinks the hole's usable distance.
- `client.stage.js` rebuilt by `npm run build`.

### Camera and framing

- Default framing is r = 11 b_crit, 15° above the disc plane and 6° in azimuth, putting the whole disc in frame with margin; the cluster frames at 3.9× its radius and the same 15°.
- The camera rig accepts `preserveView`: a space handover keeps the current pose instead of flying back to the old focus first.

### Fixes

- Haze particles now use the same `(x, -z, y)` frame as the hole; the previous mapping pointed them the wrong way.
- The loading spinner is an SVG ring with a fixed `pathLength` instead of a rotating CSS border, which no longer depends on how the browser joins border corners.
- The wide footer card's padding now compensates the host sidebar's bottom padding, leaving a 0.5 px outer gap.

### Tests

- Transition cases 40 → 61: per-point phase, shadow-then-reveal ordering, cancelling mid-return, `preserveView`, space handover and the framing limit.
- 17 new track-probe cases; `npm test` is green (61 + 19 + 17 + the loader smoke test).

### Validation boundary

- The automated tests do not cover the GPU: shader compilation, real frame rate and the look of the HDR tone mapping still need a human on real hardware.

## [1.2.0] - 2026-11-01

### Cluster → hole: a continuous spiralling return

The previous return was the entry played backwards: about 1.2 seconds sending the fragments home, with the disk handed over on the first moving frame — it read as a jump-cut. It is now a choreography of its own.

- Stars spiral inward from where they are, in polar coordinates: the angle moves monotonically towards the target with a coefficient in `[π, 3π)`, so the motion keeps **one direction the whole way and never reverses mid-flight**; the radius shrinks linearly to the disk radius and the height flattens early.
- The cluster palette and knot shape hold until the last part of the return, and the disk only starts to appear after 65% of the run, the two cross-fading instead of swapping.
- The return now lasts 2.5 seconds (counted after `WORM_OUT_RING_S`), deliberately different from the 2.3-second entry.
- A return from a full cluster **no longer re-captures the disk**: it skips the `captureDisc` render-target readback and the fragment BFS rebuild and starts from the live positions. Only a partial exit from inside the cluster still takes the old reversed path, so no geometry jumps.
- No dust burst fires during the return; brightness comes only from the complementary fade.

### Hole → cluster: same look and timing, less work

- Entry path, duration, ring and shadow timing, and shaders are untouched.
- The disk capture cap drops from 1024 to 512: a quarter of the readback area, with cell-for-cell identical colour and station-ownership mapping and the same fragment flight.
- The BFS that assigns fragments no longer allocates a closure per cell; the visit order (left / right / down / up) and the ownership rule are unchanged.
- New adaptive pixel ratio during transitions: on repeated slow frames the pixel budget is first capped at `√(700000 / viewport area)`, then stepped down by 0.8 (floor 0.5), climbing back to `pixelRatioCap` once idle. The station sprite shader no longer clamps its pixel ratio to 1, so a lower resolution never inflates sprites.

### Fixed

- Cancelling a return immediately after the press (before it advanced, or within 0.003 of progress) used to leak the return state into the next entry, which inherited its opacity and palette. It now always goes through `restoreClusterAfterCancel`.
- The sprite layer's `uPixelRatio` was pushed back to 1 by `Math.max(1, …)` below 1 device pixels, so sprites were sized against CSS pixels during adaptive downscaling. It now takes the finite positive ratio as-is.

### Tests

- The exit duration in `tools/test-transition.mjs` is derived from the source constants and asserted to be 2.5 seconds.
- New: one-directional angle on the way back over 150 steps, state reset after a near-zero cancellation, the adaptive pixel-ratio budget and fallback, and the real sprite layer's uniforms at 0.5 / 0.581 / 1 / 2.
- Cases went from 39 to 40, `npm test` is green, and `npm run build` plus the `--bundles` loader smoke test pass.

### What was and was not verified

- Frame rate was confirmed on real hardware by the project author (60 FPS target, 30 FPS floor, across the whole transition).
- The automated tests do **not** cover the GPU: shader compilation, real frame rate and the look of the HDR tone mapping still need a human.
- The frozen sidebar radio card is unchanged: `StationFootCard`, `SidebarStation` and the `.bhrl-foot` / `.bhrl-fcard` styles have zero hits (`git diff -U0 client.js | grep -c "bhrl-foot\|bhrl-fcard\|StationFootCard"` = 0). The rest of `client.js` did change, as part of the concurrent radio batch, not as a product of this transition change.

### Sources

The choreography, interpolation and timing of this change are original work; no code was copied. The design drew on the public implementations and write-ups of two radio plugins, [CXZAAA/dsh-radio](https://github.com/CXZAAA/dsh-radio) (MIT) and [joeseesun/qiaomu-radio-dsh](https://github.com/joeseesun/qiaomu-radio-dsh) (GPL-3.0-or-later); see "Sources and acknowledgement" in the README. Neither project's code is included, so this repository stays MIT. The BSD-3-Clause upstream behind the black-hole rendering is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## [1.0.0] - 2026-11-01

First public release: the black-hole stage, the cluster, the wormhole, the 24k-station catalogue, playback and favourites.
