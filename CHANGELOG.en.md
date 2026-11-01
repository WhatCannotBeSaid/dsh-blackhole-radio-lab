# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The Chinese edition is [CHANGELOG.md](CHANGELOG.md).

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
