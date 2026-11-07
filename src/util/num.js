/**
 * Shared numeric helpers.
 *
 * Consolidated from the per-file copies that had drifted: `clamp` lived in
 * three files, `clamp01` in three, `smoothstep01` in two. One definition now,
 * so the clamping and easing used by the disk, the cluster and the stage can
 * never disagree.
 */

/** Clamp `value` into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamp into [0, 1]. Coerces to Number first, so a missing or NaN input reads
 * as 0 instead of propagating NaN into the animation or a shader uniform.
 */
export function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

/** Smooth Hermite ease of `value` in [0, 1]; zero allocation. */
export function smoothstep01(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}
