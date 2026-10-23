/**
 * One place for every length, mass and time in the black-hole scene.
 *
 * UNIT CONVENTION (phase 2)
 * -------------------------
 * World space is normalised so that **one world unit is exactly one critical
 * impact parameter**, b_crit = 3*sqrt(3)*M = (3*sqrt(3)/2)*Rs. That makes the
 * shadow's asymptotic radius 1.0 and keeps the camera framing constants below
 * numerically close to what phase 1 used, while every radius in the model keeps
 * a closed-form meaning:
 *
 *   world unit    = b_crit                 = 1
 *   Rs            = 2/(3*sqrt(3))          ~ 0.3849001794597505
 *   M = Rs/2      = 1/(3*sqrt(3))          ~ 0.1924500897298753
 *   photon sphere = 3*M = 1.5*Rs           ~ 0.5773502691896257
 *   ISCO          = 6*M = 3*Rs             ~ 1.1547005383792515
 *
 * These four radii are DIFFERENT and must never be conflated:
 *   - the horizon r = Rs is not drawn and is not the shadow edge;
 *   - the photon sphere is where circular null orbits live;
 *   - b_crit is the critical impact parameter, the asymptotic shadow radius;
 *   - the on-screen shadow edge is an angular size that depends on the
 *     observer's distance (see shadowAngularRadius below), and equals b_crit
 *     only in the limit r -> infinity.
 *
 * The upstream ray tables (src/scene/ray-tables.data.js) are expressed in units
 * where Rs = 1. Everything handed to the shader is therefore converted to Rs
 * units first, and the shader does all of its geometry in Rs units, so no
 * conversion ever happens inside a table lookup. The conversion factors are:
 *
 *   r_Rs  = r_world / RS
 *   u_Rs  = 1/r_Rs
 *   e^2   = (Rs/b)^2          [table index]
 *   t_Rs  = t_world / RS      [c = 1]
 *
 * Note that RS^2 = 4/27 = kMu, the constant that appears in the upstream
 * capture test, which is the arithmetic check that the two unit systems agree.
 */

/** Schwarzschild radius in world units: 2/(3*sqrt(3)). */
export const RS = 2 / (3 * Math.sqrt(3));

/** Mass in world units: M = Rs/2. */
export const BH_MASS = RS / 2;

/** World units per Schwarzschild radius. */
export const WORLD_PER_RS = 1 / RS;

/** Critical impact parameter in world units. Exactly 1 by construction. */
export const CRITICAL_IMPACT_PARAMETER = 3 * Math.sqrt(3) * BH_MASS;

/** Event horizon radius, world units. Present for completeness; never drawn. */
export const HORIZON_RADIUS = RS;

/** Photon sphere radius, world units: r = 3M. */
export const PHOTON_SPHERE_RADIUS = 3 * BH_MASS;

/** ISCO radius for a Schwarzschild thin disc, world units: r = 6M. */
export const ISCO_RADIUS = 6 * BH_MASS;

/**
 * Accretion disc inner edge. A standard Schwarzschild thin disc is truncated at
 * the ISCO, so this is 6M and not a number chosen to make the disc touch the
 * shadow. (Phase 1 used 1.03 world units, which sat *inside* the ISCO purely for
 * a visual effect; that is the value phase 2 replaces.)
 */
export const DISK_INNER = ISCO_RADIUS;

/**
 * Accretion disc outer edge, world units: 12 Rs. The outer radius of a real disc
 * is set by where the disc is fed and is not fixed by the metric, so this is a
 * declared modelling choice, kept close to phase 1's 4.30 for framing
 * continuity. Upstream's demo uses the same 3..12 Rs band.
 */
export const DISK_OUTER = 12 * RS;

/**
 * Radius of the disc's peak effective temperature, in world units.
 *
 * For T(r) ∝ r^(-3/4) * (1 - sqrt(r_in/r))^(1/4) the maximum sits at
 * r = (49/36) * r_in. This is used to normalise the temperature profile so the
 * peak is exactly the configured peak temperature.
 */
export const DISK_PEAK_RADIUS = (49 / 36) * DISK_INNER;

/**
 * Legacy alias. The old `RING_RADIUS` named the radius of a hand-drawn glow
 * ring, which phase 2 removes: the bright band near the shadow now falls out of
 * the light path itself. Kept only so nothing silently imports a missing name.
 *
 * @deprecated no geometry is placed at this radius any more.
 */
export const RING_RADIUS = CRITICAL_IMPACT_PARAMETER;

/**
 * Default camera home, world units. Same framing as phase 1 (r ~ 8.2, a little
 * under 5 degrees above the disc plane, ~6 degrees in azimuth) expressed through
 * the new unit: the camera distance is now ~8.2 b_crit.
 */
export const CAMERA_HOME = Object.freeze({ x: 0.856, y: 0.401, z: 8.146 });

/**
 * Animation time scale: how much coordinate time (in Rs/c units, the unit the
 * upstream light-propagation times use) advances per second of wall clock.
 *
 * Derived rather than chosen freely. The Keplerian angular velocity at the ISCO
 * is Omega = sqrt(M/r^3) = sqrt(1/54) in Rs/c units, so the ISCO orbital period
 * is 2*pi*sqrt(54) ~ 46.17 Rs/c. At 7.7 Rs/c per second that period is about six
 * seconds, which is close to the visual rate phase 1 hand-tuned, but now it is a
 * consequence of the Schwarzschild orbit instead of an artistic coefficient.
 */
export const TIME_SCALE = 7.7;

/**
 * Angular radius of the black-hole shadow as seen by a static observer at
 * radius `r` (world units), in radians.
 *
 * For a static observer a photon leaving at angle psi from the outward radial
 * direction has impact parameter
 *
 *   b = r * sin(psi) / sqrt(1 - Rs/r),
 *
 * so the critical impact parameter b_crit = 3*sqrt(3)*M corresponds to
 *
 *   sin(psi_shadow) = b_crit * sqrt(1 - Rs/r) / r.
 *
 * The naive small-angle answer b_crit/r is only the r -> infinity limit; at the
 * default camera distance the two differ by about 2%, which matters because the
 * shadow edge is what the interaction hit region and the station keep-out are
 * built on. If the observer is inside the photon sphere no shadow edge is
 * visible, and this returns NaN.
 *
 * @param rWorld - observer radius in world units.
 * @returns angular radius in radians, or NaN when undefined.
 */
export function shadowAngularRadius(rWorld) {
  const r = Number(rWorld);
  if (!Number.isFinite(r) || r <= HORIZON_RADIUS) return Number.NaN;
  const s = (CRITICAL_IMPACT_PARAMETER * Math.sqrt(1 - RS / r)) / r;
  if (!(s >= 0)) return Number.NaN;
  return Math.asin(Math.min(1, s));
}

/**
 * The same quantity as a projected fraction of the viewport half-height, which
 * is what the stage needs to place the hole mask in CSS pixels.
 *
 * @param rWorld - observer radius, world units.
 * @param fovDegrees - vertical field of view of the perspective camera.
 * @returns fraction of half the viewport height, or NaN when undefined.
 */
export function shadowScreenFraction(rWorld, fovDegrees) {
  const psi = shadowAngularRadius(rWorld);
  if (!Number.isFinite(psi)) return Number.NaN;
  const halfFov = ((Number(fovDegrees) || 42) * Math.PI) / 360;
  return Math.tan(psi) / Math.tan(halfFov);
}
