/**
 * The unified light-path shader.
 *
 * Everything the frame shows — the shadow, the bent bright arcs of the disc, the
 * lensed background — comes out of ONE null-geodesic trace per pixel. There is no
 * black sphere, no analytically drawn glow ring, and no second front/back disc
 * pass: those were phase 1's stand-ins and phase 2 removes them.
 *
 * ---------------------------------------------------------------------------
 * GEOMETRY AND UNITS
 * ---------------------------------------------------------------------------
 * The trace runs in the upstream table's units: Rs = 1, c = 1, M = 1/2, so
 *
 *     b_crit = 3*sqrt(3)/2 = 2.598076...,   kMu = 1/b_crit^2 = 4/27.
 *
 * The disc lies in the plane z = 0 with normal +z, which is what the upstream
 * model.glsl assumes (`const vec3 e_z = vec3(0,0,1)`). The plugin's world space is
 * y-up with the disc in the y = 0 plane, so JS rotates world into the shader
 * frame once per frame:
 *
 *     (x, y, z)_shader = (x, -z, y)_world / RS
 *
 * That is a proper rotation (det = +1), so the image is not mirrored, and it maps
 * the world disc normal +y onto the shader normal +z.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS COPIED FROM UPSTREAM, AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * Copied (BSD-3-Clause, Eric Bruneton, commit e72b3f2; see THIRD-PARTY-NOTICES.md):
 *   - the texture-coordinate mappings and both TraceRay implementations,
 *     including the capture test, the one-apsis / two-crossing logic and the
 *     anti-aliasing FilteredPulse;
 *   - the structure of SceneColor: the orbital-plane frame (e_x_prime,
 *     e_y_prime), the g_k_l_receiver / g_k_l_source Doppler split, the post-trace
 *     d_prime reconstruction, and the "background only when not captured" rule.
 *
 * NOT copied:
 *   - the disc material. Upstream advects precomputed particle data and reads a
 *     3D Doppler texture; here the temperature profile, the Keplerian frequency
 *     and the blackbody chromaticity are evaluated analytically. The brightness
 *     asymmetry therefore comes from the computed frequency ratio g, never from
 *     a screen-space gradient.
 *   - the galaxy/star cubemaps; the background here is procedural.
 *   - the demo's camera model. This plugin keeps its own orbit rig and needs only
 *     the static-observer special case.
 *
 * ---------------------------------------------------------------------------
 * COLOUR SPACE, IN ORDER, ONCE
 * ---------------------------------------------------------------------------
 *  1. Emission is evaluated in linear light, normalised so the disc's peak
 *     blackbody intensity is ~1.
 *  2. The disc is composited over the lensed background with explicit alpha, far
 *     crossing first, so no contribution is ever added twice.
 *  3. ONE exposure multiply, ONE ACES fit, ONE sRGB transfer at the very end.
 *     A RawShaderMaterial never receives three.js's renderer-level tone mapping
 *     or output encoding, so both are written out here; the coefficients are
 *     copied from three.js r186 (`tonemapping_pars_fragment`,
 *     `colorspace_pars_fragment`) so the two paths agree.
 */

import { TABLE_SIZES } from './ray-tables.js';

/**
 * Physical and shading constants shared by the shader and the JS verification
 * harness, so the numerical test asserts against the same numbers the GPU
 * compiles.
 */
export const IMAGING_CONSTANTS = Object.freeze({
  /** Schwarzschild radius in shader units. */
  RS: 1,
  /** Mass in shader units. */
  M: 0.5,
  /** 3*sqrt(3)/2. */
  B_CRIT: (3 * Math.sqrt(3)) / 2,
  /** 1/b_crit^2 = 4/27, the upstream capture constant. */
  K_MU: 4 / 27,
  /** 6M, the ISCO: the disc's inner edge. */
  ISCO: 3,
  /** Disc outer edge, Rs. A declared modelling choice. */
  DISK_OUTER: 12,
  /** Coordinate time (Rs/c) advanced per second of wall clock. */
  TIME_SCALE: 7.7,
  /** Peak effective temperature of the disc, kelvin. */
  T_PEAK: 6800,
  /** Exposure applied once, after compositing. */
  EXPOSURE: 1.15,
  /** Overall disc gain; 1.0 means the peak blackbody intensity is 1 in linear light. */
  DISC_GAIN: 0.28,
});

/** A GLSL float literal that always carries a decimal point. */
function f(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`glsl: ${value} is not finite`);
  const s = String(n);
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
}

/** A GLSL int literal. */
function i(value) {
  return String(Math.round(Number(value)));
}

/**
 * Header: version, precisions, table dimensions, and the blackbody fit.
 *
 * The fit is a degree-10 Chebyshev polynomial for the Planckian locus in CIE
 * 1931 (x, y), checked against the 1 nm CIE 1931 2-degree observer. On
 * [1000, 40343] K its maximum chromaticity error is 2.6e-4, far below a visible
 * step. Below roughly 1500 K the locus moves fast enough that the fit should not
 * be trusted, so the temperature is clamped and that clamp is reported rather
 * than silently producing a wrong hue.
 */
// No #version here: three.js emits '#version 300 es' itself because the
// material sets glslVersion = GLSL3, and a second directive is a hard
// compile error.
const HEADER = `precision highp float;
precision highp int;
precision highp sampler2D;

const float PI = ${f(Math.PI)};
const float RAD = 1.0;
const float RS = ${f(IMAGING_CONSTANTS.RS)};
const float MASS = ${f(IMAGING_CONSTANTS.M)};
const float K_MU = ${f(IMAGING_CONSTANTS.K_MU)};
const float B_CRIT = ${f(IMAGING_CONSTANTS.B_CRIT)};

const int RAY_DEFLECTION_TEXTURE_WIDTH = ${i(TABLE_SIZES.deflection.width)};
const int RAY_DEFLECTION_TEXTURE_HEIGHT = ${i(TABLE_SIZES.deflection.height)};
const int RAY_INVERSE_RADIUS_TEXTURE_WIDTH = ${i(TABLE_SIZES.inverseRadius.width)};
const int RAY_INVERSE_RADIUS_TEXTURE_HEIGHT = ${i(TABLE_SIZES.inverseRadius.height)};

// ---------------------------------------------------------------------------
// Blackbody chromaticity: Planckian locus, then CIE XYZ -> linear sRGB (D65).
// The XYZ result is scaled to Y = 1, i.e. it carries HUE only. Luminance is
// applied separately as a physical factor, so colour and brightness never
// double count.
// ---------------------------------------------------------------------------
const float BB_T_MIN = 1000.0;
const float BB_T_MAX = 40343.0;
const float BB_LOG10_2 = 0.30102999566398120;

float bbPlanckianX(float T) {
  float t = log2(clamp(T, BB_T_MIN, BB_T_MAX)) * BB_LOG10_2;
  float u = 2.0 * (t - 3.0) * 0.622754894562362 - 1.0;
  float b0 = 1.0;
  float b1 = u;
  float b2 = 0.0;
  float s = 0.3944082782414149;
  s += -0.2083975220074624 * b1;
  b2 = 2.0 * u * b1 - b0;
  s += 0.06589241517198785 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.00333712343368001 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -0.011656784655231258 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.003210118949162825 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.0012204048132033515 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -0.0011180838407367096 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.00015138125575560243 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.00018022099900372217 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -0.0001265050036640206 * b2;
  b0 = b1;
  b1 = b2;
  return s;
}

float bbPlanckianY(float T) {
  float t = log2(clamp(T, BB_T_MIN, BB_T_MAX)) * BB_LOG10_2;
  float u = 2.0 * (t - 3.0) * 0.622754894562362 - 1.0;
  float b0 = 1.0;
  float b1 = u;
  float b2 = 0.0;
  float s = 0.3203811162294174;
  s += -0.07806252385629983 * b1;
  b2 = 2.0 * u * b1 - b0;
  s += -0.01952073265514039 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.0325114529913781 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -0.00959926225761849 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -0.003829589999638488 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.003879720231548383 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -0.0007451083541766444 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -0.000543728834392749 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += 0.0004185661270778589 * b2;
  b0 = b1;
  b1 = b2;
  b2 = 2.0 * u * b1 - b0;
  s += -7.341043781744952e-05 * b2;
  b0 = b1;
  b1 = b2;
  return s;
}

vec3 blackBodyChromaticity(float temperature) {
  float T = clamp(temperature, BB_T_MIN, BB_T_MAX);
  float x = bbPlanckianX(T);
  float y = max(bbPlanckianY(T), 1e-4);
  vec3 xyz = vec3(x / y, 1.0, (1.0 - x - y) / y);
  // CIE XYZ -> linear sRGB, D65 white. Exact inverse of the sRGB->XYZ matrix.
  return max(vec3(
     3.2404541621141045 * xyz.x - 1.5371385127977166 * xyz.y - 0.4985314095560160 * xyz.z,
    -0.9692660305051868 * xyz.x + 1.8760108454466942 * xyz.y + 0.0415560175303498 * xyz.z,
     0.0556434309591147 * xyz.x - 0.2040259135167538 * xyz.y + 1.0572251882231791 * xyz.z), vec3(0.0));
}

// ---------------------------------------------------------------------------
// Value noise. Used ONLY for disc density detail; it never invents light.
// ---------------------------------------------------------------------------
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 fr = fract(p);
  vec3 u = fr * fr * (3.0 - 2.0 * fr);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 4; k++) {
    sum += amp * valueNoise(p);
    p = p * 2.03 + vec3(11.3, 7.7, 3.1);
    amp *= 0.5;
  }
  return sum / 0.9375;
}

/**
 * The same fractal noise with a per-octave band limit.
 *
 * footprint is how much the sample point moves across one pixel, in the same
 * units as p. An octave whose cell is smaller than that cannot be sampled
 * without aliasing, so its amplitude fades out instead of being point-sampled.
 * The sum is renormalised by the amplitudes that survived, so the mean and the
 * contrast of the field stay put as detail is dropped.
 */
float fbm3Lod(vec3 p, float footprint) {
  float sum = 0.0;
  float norm = 0.0;
  float amp = 0.5;
  float scale = 1.0;
  for (int k = 0; k < 4; k++) {
    // An octave is resolvable while its cells are wider than a few footprints.
    float keep = 1.0 - smoothstep(0.35, 0.85, footprint * scale);
    sum += amp * keep * valueNoise(p * scale);
    norm += amp * keep;
    scale *= 2.03;
    amp *= 0.5;
  }
  return norm > 1e-4 ? sum / norm : 0.5;
}
`;

/**
 * The disc material.
 *
 * RADIATION QUANTITY. The disc is a geometrically thin, optically thick
 * Keplerian annulus in local thermodynamic equilibrium, so its specific
 * intensity is a blackbody at the local effective temperature. Two things happen
 * to that light on the way to the camera:
 *
 *   - the frequency is shifted by g = nu_obs / nu_emit, and a frequency-shifted
 *     blackbody is still a blackbody, so the observed colour is that of
 *     temperature g * T_emit;
 *   - the bolometric intensity scales as g^4: I_nu / nu^3 is Lorentz invariant,
 *     and integrating over nu gives the fourth power.
 *
 * So the colour comes from blackBodyChromaticity(g * T), which is normalised to
 * unit luminance and carries no brightness, and the brightness is the separate
 * factor g^4 * (T / T_peak)^4. Neither is applied twice, and g^4 is derived from
 * the computed g: there is no screen-space "left bright / right dim" term.
 *
 * TEMPERATURE PROFILE. For a thin disc with a zero-torque inner boundary,
 *
 *   T(r) ~ r^(-3/4) * (1 - sqrt(r_in / r))^(1/4),
 *
 * which vanishes at r_in and peaks at r = (49/36) r_in. It is normalised so the
 * peak equals T_PEAK. This is the standard Shakura-Sunyaev effective-temperature
 * shape with the inner-boundary factor in a Newtonian potential; it is NOT a full
 * relativistic disc solution.
 *
 * ROTATION. d(phi)/d(t_coordinate) = sqrt(M / r^3), the exact Schwarzschild
 * circular-orbit angular velocity in these units, so the disc rotates
 * differentially with the inner edge fastest. The time fed in is the RETARDED
 * time (camera time minus the traced light travel time), so the finite
 * propagation delay is included rather than ignored.
 */
const DISC = `
const float DISC_INNER = ${f(IMAGING_CONSTANTS.ISCO)};
/**
 * Where the disc actually starts, in Rs units. Equal to DISC_INNER at rest; the
 * hold pulls it inward, which is what makes the shadow shrink: the gas reaches
 * closer in, so less of the frame is hole and more of it is disc.
 */
uniform float uDiscInner;
const float DISC_OUTER = ${f(IMAGING_CONSTANTS.DISK_OUTER)};
// r at which T(r) peaks, (49/36) r_in, used to normalise the profile.
const float DISC_R_PEAK = ${f((49 / 36) * IMAGING_CONSTANTS.ISCO)};
const float T_PEAK = ${f(IMAGING_CONSTANTS.T_PEAK)};
const float DISC_GAIN = ${f(IMAGING_CONSTANTS.DISC_GAIN)};
/**
 * Wind-up under the hold, 0..1.
 *
 * Applied to the station raster only: the points that make up the disc are the
 * catalogue's stations, and the hold makes those stations turn faster toward the
 * inner edge while drawing very slightly inward. The procedural turbulence and
 * the shadow are untouched, so what moves is the point layer itself.
 */
uniform float uCharge;
const float T_PROFILE_MAX = pow(
  (1.0 - sqrt(DISC_INNER / DISC_R_PEAK)) / (DISC_R_PEAK * DISC_R_PEAK * DISC_R_PEAK),
  0.25);

/** Angular velocity of a circular Schwarzschild orbit, dphi/dt, Rs units. */
float keplerOmega(float r) {
  return sqrt(MASS / (r * r * r));
}

/** Normalised effective temperature, 0..1, peaking at 1. */
float discTemperatureProfile(float r) {
  if (r <= uDiscInner) return 0.0;
  float raw = pow(max(1.0 - sqrt(uDiscInner / r), 0.0) / (r * r * r), 0.25);
  return raw / T_PROFILE_MAX;
}

/**
 * Density detail. The pattern is defined in a frame that co-rotates with the
 * local Keplerian flow, so it shears into spiral bands instead of rotating
 * rigidly. Low contrast on purpose: this is turbulence detail on an otherwise
 * smooth disc, not a field of discrete sparkles.
 */
/**
 * One realisation of the detail field, sampled at a point of the sheared frame.
 * footprint is how far that point moves across one pixel, in Rs: octaves
 * finer than the footprint fade out instead of aliasing.
 */
float discDetail(const in vec3 p, float footprint) {
  float coarse = fbm3Lod(p * 0.62, footprint * 0.62);
  float fine = fbm3Lod(p * 1.55 + vec3(4.7, 1.3, 9.1), footprint * 1.55);
  return coarse * 0.68 + fine * 0.32;
}

/** Per-realisation offset of the detail field. Depends on the birth index only. */
vec3 detailSeed(float k) {
  return vec3(hash31(vec3(k, 0.0, 1.0)),
              hash31(vec3(k, 3.0, 2.0)),
              hash31(vec3(k, 7.0, 5.0))) * 53.0;
}

/**
 * Density detail. The pattern is defined in a frame that co-rotates with the
 * local Keplerian flow, so it shears into spiral bands instead of rotating
 * rigidly, and each realisation of the field lives one ISCO orbit.
 *
 * WHY A LIFETIME, AND WHAT THE LIFETIME HAS TO BE. The advected coordinate is
 * phi - omega(r)*t, so its radial phase gradient is t*domega/dr and grows
 * without bound: after a few minutes neighbouring radii sample unrelated noise
 * cells and the disc degenerates into the concentric grooves of a vinyl record.
 * Decorrelating on an orbital timescale fixes that, but only if the bound is on
 * the ADVEction age, not merely on a fraction that resets per radius: if the
 * birth time is quantised with a radius-dependent period, the layer index
 * changes with r and the seams come back. So the phase is global here:
 *
 *   k   = floor(t / (P/2))          birth index, same at every radius
 *   age = t - k*P/2                 in [0, P/2]
 *
 * and each layer is sampled at phi - omega(r)*age. Every visible age is at most
 * P (the layer is retired after that), so the wound angle is bounded by
 * |domega/dr|*P <= 3*pi*omega/(omega_isco*r) <= 3*pi/r for all time, with P the
 * orbital period at the inner edge and omega_isco the fastest orbit on the disc.
 * The wavelengths hidden below that bound are dropped by fbm3Lod rather than
 * aliased. The two weights are sin^2, which sum to one and are continuous in t,
 * so a birth is a cross-fade and never a jump.
 */
const float DETAIL_LIFE = 46.1718; // 2*pi/omega(ISCO), Rs/c

/**
 * One instant of the detail field: the two co-rotating layers blended by sin^2
 * weights. Split out of discDensity so that the undersampled case can average
 * several instants along the pixel's retarded-time span instead of substituting a
 * constant for the whole field.
 */
float discDetailAt(float r, float phi, float retardedTime, float footprint) {
  float halfLife = DETAIL_LIFE * 0.5;
  float k = floor(retardedTime / halfLife);
  float age = retardedTime - k * halfLife; // 0 .. halfLife, the young layer's age
  float omega = keplerOmega(r);
  // The younger layer is born at the current boundary; the older one, exactly
  // half a life ahead, was born at the previous one. Both are sampled at the
  // same radius, so neither weight depends on r and the blend has no seam.
  float spun0 = phi - omega * age;
  float spun1 = phi - omega * (age + halfLife);
  // Isotropic 3D field sampled at the advected disc position, so a feature has
  // one physical size in every direction; the differential rotation is the only
  // thing making the pattern anisotropic. The third coordinate is a shallow
  // vertical shear. The seed is a birth-index offset, constant in r.
  vec3 p0 = vec3(cos(spun0), sin(spun0), 0.0) * r;
  vec3 p1 = vec3(cos(spun1), sin(spun1), 0.0) * r;
  p0.z = r * 0.35;
  p1.z = r * 0.35;
  // sin^2 weights, summing to one, zero for the incoming layer at its birth.
  float w0 = sin(PI * age / DETAIL_LIFE);
  w0 *= w0;
  return w0 * discDetail(p0 + detailSeed(k), footprint)
       + (1.0 - w0) * discDetail(p1 + detailSeed(k - 1.0), footprint);
}

float discDensity(float r, float phi, float retardedTime, float footprint, float detailTrust) {
  float detail = discDetailAt(r, phi, retardedTime, footprint);
  // Wide, smooth range with modest contrast: density detail on a smooth disc, not
  // a field of discrete points and not a hard-edged ring pattern.
  return 0.62 + 0.52 * smoothstep(0.20, 0.88, detail);
}

/**
 * Station density raster.
 *
 * x is azimuth (0..2pi, wrapping) and y is radius (DISC_INNER..DISC_OUTER),
 * both normalised. The raster is built on the CPU from the catalogue, so the
 * disc's surface brightness is literally the station distribution: where many
 * stations sit the gas radiates harder, and where none do the disc falls back
 * to its procedural turbulence.
 */
uniform sampler2D uStationField;
uniform sampler2D uStationIds;
uniform vec2 uStationSize;
uniform float uStationInner;
uniform float uStationOuter;
uniform float uStationGain;
uniform float uStationPlaying;
uniform int uStationOn;
/**
 * Radiance the catalogue emits on its own, independent of the disc's own
 * surface brightness. Without it the outer field is invisible: the disc falls
 * off as r^-3, so density modulation has nothing to modulate out there.
 */
uniform float uStationEmission;
/**
 * Seconds the disc clock has been held back, subtracted from the retarded time
 * before any pattern is evaluated.
 *
 * Pausing used to scale the age toward zero, which did freeze the pattern — but
 * it freezes it at phase zero, so the disc snapped back to where it started.
 * Holding back an accumulating offset instead leaves the current phase alone and
 * lets the motion resume from exactly there.
 */
uniform float uStationPhase;
// -1: ordinary imaging. 0..1: the captured disc has become moving fragments;
// this pass owns ONLY the background/shadow, never a second copy of the disc.
uniform float uDiscTransfer;

/** Normalised raster coordinates for one advected disc point. */
vec2 stationUvAt(float r, float phi, float age) {
  // The raster lives in the disc's co-rotating frame: rewind the azimuth by
  // The local Keplerian advance, so a station stays with its parcel of gas
  // instead of sliding through the pattern. The hold adds the same differential
  // twist the density detail gets, so the stations themselves wind up under the
  // hand: this is the point layer moving, not a pattern over it.
  float spun = phi - keplerOmega(r) * age + uCharge * 2.2 / max(r, 1.0);
  float u = fract(spun * 0.15915494309189535); // 1 / (2 pi)
  float v = (r * (1.0 - 0.05 * uCharge) - uStationInner) / max(1e-6, uStationOuter - uStationInner);
  return vec2(u, v);
}

vec4 stationSampleAt(float r, float phi, float age) {
  vec2 uv = stationUvAt(r, phi, age);
  if (uv.y < -0.02 || uv.y > 1.02) return vec4(0.0);
  return texture(uStationField, vec2(uv.x, clamp(uv.y, 0.0, 1.0)));
}

/**
 * (density, concentration, state bits, coverage) at one disc point.
 *
 * The advection is clamped exactly the way the procedural detail clamps it:
 * two generations half a life apart, blended by sin^2 weights. Without that the
 * phase would grow without bound, lose float precision after a few minutes, and
 * the raster would visibly crawl and snap.
 */
vec4 stationFieldAt(float r, float phi, float clock) {
  if (uStationOn == 0) return vec4(0.0);
  float halfLife = DETAIL_LIFE * 0.5;
  float age = clock - floor(clock / halfLife) * halfLife;
  float w0 = sin(PI * age / DETAIL_LIFE);
  w0 *= w0;
  vec4 young = stationSampleAt(r, phi, age);
  vec4 old = stationSampleAt(r, phi, age + halfLife);
  // State bits are categorical: they come from whichever generation dominates,
  // never from a blend of the two.
  float bits = w0 >= 0.5 ? young.b : old.b;
  return vec4(mix(old.r, young.r, w0), mix(old.g, young.g, w0), bits, max(young.a, old.a));
}

/** Station index owning a disc point, or -1. Nearest texel, no filtering. */
float stationIndexAt(float r, float phi, float clock) {
  if (uStationOn == 0) return -1.0;
  float halfLife = DETAIL_LIFE * 0.5;
  float age = clock - floor(clock / halfLife) * halfLife;
  float w0 = sin(PI * age / DETAIL_LIFE);
  w0 *= w0;
  vec2 uv = stationUvAt(r, phi, w0 >= 0.5 ? age : age + halfLife);
  if (uv.y < 0.0 || uv.y > 1.0) return -1.0;
  ivec2 size = ivec2(uStationSize);
  ivec2 texel = clamp(ivec2(floor(uv * uStationSize)), ivec2(0), size - 1);
  return texelFetch(uStationIds, texel, 0).r;
}

/**
 * The disc's contribution at one crossing.
 *
 * @param discPos      point on the disc, Rs units, shader frame (z ~ 0)
 * @param retardedTime camera time minus the light travel time
 * @param patternClock the disc's own clock: camera time minus the pause offset,
 *                     with no light-travel term
 * @param doppler      g = nu_obs / nu_emit
 * @param stationId    out: index of the station under this point, or -1
 */
vec4 shadeDisc(vec2 discPos, float retardedTime, float patternClock, float doppler, float footprint, float detailTrust, out float stationId) {
  stationId = -1.0;
  float r = length(discPos);
  if (r < uDiscInner || r > DISC_OUTER) return vec4(0.0);

  float profile = discTemperatureProfile(r);
  if (profile <= 0.0) return vec4(0.0);

  // One clock for every pattern on the disc: the procedural turbulence and the
  // catalogue's density field have to pause and resume together, or the stations
  // would slide through the gas instead of riding it.
  //
  // It is NOT the retarded time. The retarded time carries the light-travel term,
  // which changes the moment the camera dollies: the pattern would then slide
  // round, and its detail layers would re-seed, on every step of a zoom. The
  // wheel must change how large the disc looks and nothing else, so the pattern
  // reads the camera clock, and the light-travel term stays where it belongs —
  // in the emission pulse below, which really does travel with the light.
  float clock = patternClock;

  float phi = atan(discPos.y, discPos.x);
  float density = discDensity(r, phi, clock, footprint, detailTrust);

  // Stations ARE the disc. Their density drives the emission above the
  // procedural floor, so the visible structure of the disc is the catalogue's
  // own distribution rather than a texture laid over it.
  vec4 field = stationFieldAt(r, phi, clock);
  stationId = stationIndexAt(r, phi, clock);
  float load = clamp(field.r * uStationGain, 0.0, 1.0);
  float concentration = field.g;
  // Radial tapers: a zero-torque inner edge whose emission dies away, and a soft
  // outer rim so the disc does not end on a hard circle.
  float innerRamp = smoothstep(uDiscInner, uDiscInner * 1.05, r);
  float outerFade = 1.0 - smoothstep(DISC_OUTER * 0.70, DISC_OUTER, r);
  // The catalogue reaches further out than the procedural disc's own taper, so
  // the stations get a later rim of their own. Held to the disc's taper they
  // vanish at 0.7 of the radius, which reads as a ring of stations sitting in
  // the middle of an empty disc instead of a disc made of stations.
  float stationFade = 1.0 - smoothstep(uStationOuter * 0.92, uStationOuter * 1.10, r);

  // Faded out with the field's own rim: past it the procedural disc is all that
  // is left, so the modulation has to hand the texels back at full brightness
  // instead of leaving a step where the field stops.
  density *= mix(1.0, 0.38 + 1.22 * load, stationFade);
  // A lone station in an empty stretch reads as a distinct knot instead of
  // dissolving into the ambient glow; a crowded band stays smooth.
  density *= mix(1.0, 1.0 + 0.55 * (1.0 - concentration), load * stationFade);

  float temperature = profile * T_PEAK;
  // Crowded texels average over many sources and run a little cooler; isolated
  // knots run hotter, and a favourite is warmer still (state bit 1).
  float warmer = (1.0 - concentration) * load * 0.16;
  float favourite = mod(floor(field.b * 255.0 + 0.5), 2.0);
  float temperatureObserved = temperature * (1.0 + warmer + 0.07 * favourite) * max(doppler, 1e-3);

  vec3 chroma = blackBodyChromaticity(temperatureObserved);
  float g = max(doppler, 1e-3);
  // Bolometric g^4 times Stefan-Boltzmann T^4, both linear light.
  float brightness = g * g * g * g * profile * profile * profile * profile;

  // The playing station breathes: a slow, shallow pulse at its own position.
  // The retarded time drives it, so the pulse travels with the light.
  if (stationId >= 0.0 && abs(stationId - uStationPlaying) < 0.5) {
    brightness *= 1.30 + 0.18 * sin(retardedTime * 2.4);
  }

  float alpha = clamp(innerRamp * max(outerFade, stationFade) * density, 0.0, 1.0);
  vec3 rgb = chroma * brightness * DISC_GAIN;
  // The field carries its own light.
  //
  // The disc's surface brightness falls as r^-3, so a field that only modulates
  // alpha is unreadable past the inner third: the density, the id and the click
  // are all still there, but there is no light left to see them against. This
  // term is the catalogue glowing in its own right, held to the same radial
  // tapers so it still ends where the disc ends.
  rgb += chroma * load * load * uStationEmission * innerRamp * stationFade;
  return vec4(rgb * alpha, alpha);
}
`;

/**
 * Procedural far-field background, sampled ONLY along the bent direction.
 *
 * This is an environment map, not a lensed 3D scene: it has no parallax and its
 * features are infinitely far away. Lensing an infinitely distant background is
 * exactly what the trace computes; lensing a finite-distance object is NOT
 * modelled and is not claimed.
 *
 * No magnification gain is applied. Lensing conserves surface brightness, so an
 * extended source is not brightened by it; the bright arcs in the frame come from
 * the disc's own crossings. Unresolved higher-order images that would form a full
 * photon ring are outside what a two-crossing table resolves, and the report
 * says so.
 */
const BACKGROUND = `
/** Inverse of the cube-face map used by starLayer. */
vec3 dirFromFace(float face, vec2 uv) {
  if (face < 0.5) return normalize(vec3(1.0, uv.x, uv.y));
  if (face < 1.5) return normalize(vec3(-1.0, uv.x, uv.y));
  if (face < 2.5) return normalize(vec3(uv.x, 1.0, uv.y));
  if (face < 3.5) return normalize(vec3(uv.x, -1.0, uv.y));
  if (face < 4.5) return normalize(vec3(uv.x, uv.y, 1.0));
  return normalize(vec3(uv.x, uv.y, -1.0));
}

float starLayer(vec3 dir, float cells, float size, float gain, float seed) {
  // Cube-face parametrisation, so stars do not clump at the poles.
  vec3 a = abs(dir);
  vec2 uv;
  float face;
  if (a.x >= a.y && a.x >= a.z) {
    uv = dir.yz / a.x;
    face = dir.x > 0.0 ? 0.0 : 1.0;
  } else if (a.y >= a.z) {
    uv = dir.xz / a.y;
    face = dir.y > 0.0 ? 2.0 : 3.0;
  } else {
    uv = dir.xy / a.z;
    face = dir.z > 0.0 ? 4.0 : 5.0;
  }
  vec2 g = (uv * 0.5 + 0.5) * cells;
  vec2 cell = floor(g);
  float acc = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 c = cell + vec2(float(dx), float(dy));
      float h = hash31(vec3(c, face + seed * 13.0));
      if (h < 0.90) continue;
      vec2 jitter = vec2(hash31(vec3(c, face + 3.1 + seed)),
                         hash31(vec3(c, face + 5.7 + seed)));
      // Chord distance between the sample direction and the star direction. This
      // is isotropic on the sphere, so the star is round on every cube face.
      vec2 starUv = ((c + jitter) / cells) * 2.0 - 1.0;
      vec3 starDir = dirFromFace(face, starUv);
      float d = length(dir - starDir);
      float radius = size * (0.35 + 0.65 * hash31(vec3(c, face + 9.4 + seed)));
      acc += smoothstep(radius, 0.0, d) * gain * (0.25 + 0.75 * h);
    }
  }
  return acc;
}

/**
 * Diffuse component: smooth, so no aliasing when the ray winds.
 *
 * The first version put ALL of the diffuse light into one narrow galactic band
 * (exp(-(dot/0.34)^2), about +-19 degrees) and left the rest of the sky at a
 * near-zero ambient. The band is a legitimate sky feature, but it made the
 * lensing legible in exactly one direction: every other azimuth showed a black
 * field with a few faint stars, so the warped sky had nothing to warp. This is
 * NOT a path bug — the same shader samples dPrime in every direction, and the
 * stars do bend all the way round. It is a content-distribution problem.
 *
 * So the band stays (it is the one feature that reads as a real galaxy) and
 * three low-contrast layers are added underneath it, all of them full-sky:
 *
 *   - a deep black-blue base, slightly modulated by the existing mottle;
 *   - one extra low-frequency octave set, turned into a soft veil, so every
 *     direction has broad patches that a lens can visibly stretch;
 *   - the same mottle/mottle2 as before, which keeps the fine grain aligned
 *     with the band instead of looking like a second, unrelated sky.
 *
 * The veil is deliberately SMOOTH and low-amplitude: it must give the lens
 * something to bend without competing with the disc, and a fine grid would
 * alias when the ray winds near the critical curve. Only one new fbm3 call is
 * added; the other two are the ones already here.
 */
vec3 backgroundDiffuse(vec3 dir) {
  vec3 bandNormal = normalize(vec3(0.34, 0.86, -0.38));
  float band = exp(-pow(dot(dir, bandNormal) / 0.42, 2.0));
  float mottle = fbm3(dir * 3.4);
  float mottle2 = fbm3(dir * 9.0 + vec3(2.2, 8.8, 4.4));
  vec3 bandColor = vec3(0.045, 0.056, 0.090) * band * (0.55 + 0.70 * mottle)
                 + vec3(0.024, 0.021, 0.033) * band * mottle2 * 0.6;
  // Full-sky base: the deep black-blue floor, no longer dependent on the band.
  vec3 ambient = vec3(0.0075, 0.0088, 0.0145) * (0.62 + 0.85 * mottle);
  // Full-sky veil: broad, soft nebula patches visible from every azimuth.
  float nebula = fbm3(dir * 1.35 + vec3(-5.3, 2.7, 8.1));
  float veil = smoothstep(0.26, 0.88, 0.72 * nebula + 0.28 * mottle);
  vec3 veilColor = vec3(0.0190, 0.0180, 0.0280) * veil * (0.45 + 0.55 * mottle2);
  return ambient + veilColor + bandColor;
}

/**
 * Point-like component.
 *
 * The flux argument is the lensing flux correction: an unresolved source keeps
 * flux, so when the lens stretches its image the surface brightness must drop by
 * the same factor. Extended emission (backgroundDiffuse) does the opposite and
 * keeps surface brightness, which is why the two are scaled differently.
 *
 * Three layers instead of two: the bright and medium layers are the original
 * stars, and a third, far denser but very faint layer gives every direction a
 * resident speckle field. That layer is what makes a bend readable when the
 * camera looks away from the galactic band — the bright layer alone has too few
 * stars there to show a shape.
 */
vec3 backgroundStars(vec3 dir, float flux) {
  vec3 scaled = dir * 0.55;
  float s1 = starLayer(scaled, 22.0, 0.0034, 1.0, 0.0);
  float s2 = starLayer(scaled, 46.0, 0.0028, 0.38, 1.0);
  float s3 = starLayer(scaled, 96.0, 0.0022, 0.16, 2.0);
  float warmth = fbm3(dir * 22.0);
  vec3 tint = mix(vec3(0.74, 0.83, 1.0), vec3(1.0, 0.84, 0.66), warmth);
  return tint * (s1 + s2 + s3) * 0.62 * flux;
}
`;

/**
 * Table sampling. One fetch when 32-bit float textures filter in hardware;
 * otherwise the same bilinear weights from four nearest texels, so the values
 * agree and only the cost differs.
 */
const TABLE_FETCH = `
uniform sampler2D uDeflectionTable;
uniform sampler2D uInverseRadiusTable;
uniform bool uHardwareFilter;

vec4 texelFetchClamped(sampler2D tex, ivec2 coord, ivec2 size) {
  return texelFetch(tex, clamp(coord, ivec2(0), size - ivec2(1)), 0);
}

vec4 sampleTable(sampler2D tex, vec2 uv, ivec2 size) {
  if (uHardwareFilter) {
    return texture(tex, uv);
  }
  vec2 base = uv * vec2(size) - 0.5;
  vec2 f0 = floor(base);
  vec2 frac = base - f0;
  ivec2 c0 = ivec2(f0);
  vec4 t00 = texelFetchClamped(tex, c0 + ivec2(0, 0), size);
  vec4 t10 = texelFetchClamped(tex, c0 + ivec2(1, 0), size);
  vec4 t01 = texelFetchClamped(tex, c0 + ivec2(0, 1), size);
  vec4 t11 = texelFetchClamped(tex, c0 + ivec2(1, 1), size);
  return mix(mix(t00, t10, frac.x), mix(t01, t11, frac.x), frac.y);
}
`;

/**
 * The upstream trace, ported with the IN/OUT macros inlined and Real reduced to
 * float. Function bodies are verbatim except for three added guards, each marked
 * GUARD below, which replace a NaN or a division by zero with the same limiting
 * value the maths would give. See THIRD-PARTY-NOTICES.md.
 */
const TRACE = `
float getRayDeflectionTextureUFromEsquare(float eSquare) {
  if (eSquare < K_MU) {
    return 0.5 - sqrt(-log(max(1.0 - eSquare / K_MU, 1e-30)) * (1.0 / 50.0));
  }
  return 0.5 + sqrt(-log(max(1.0 - K_MU / eSquare, 1e-30)) * (1.0 / 50.0));
}

float getUapsisFromEsquare(float eSquare) {
  float x = (2.0 / K_MU) * eSquare - 1.0;
  // GUARD: asin is undefined outside [-1,1]; x reaches 1 exactly at e^2 = kMu.
  return 1.0 / 3.0 + (2.0 / 3.0) * sin(asin(clamp(x, -1.0, 1.0)) * (1.0 / 3.0));
}

float getRayDeflectionTextureVFromEsquareAndU(float eSquare, float u) {
  if (eSquare > K_MU) {
    float x = u < 2.0 / 3.0 ? -sqrt(max(2.0 / 3.0 - u, 0.0)) : sqrt(max(u - 2.0 / 3.0, 0.0));
    return (sqrt(2.0 / 3.0) + x) / (sqrt(2.0 / 3.0) + sqrt(1.0 / 3.0));
  }
  return 1.0 - sqrt(max(1.0 - u / getUapsisFromEsquare(eSquare), 0.0));
}

float getTextureCoordFromUnitRange(float x, int textureSize) {
  return 0.5 / float(textureSize) + x * (1.0 - 1.0 / float(textureSize));
}

vec2 lookupRayDeflection(float eSquare, float u, out vec2 deflectionApsis) {
  float texU = getTextureCoordFromUnitRange(
    getRayDeflectionTextureUFromEsquare(eSquare), RAY_DEFLECTION_TEXTURE_WIDTH);
  float texV = getTextureCoordFromUnitRange(
    getRayDeflectionTextureVFromEsquareAndU(eSquare, u), RAY_DEFLECTION_TEXTURE_HEIGHT);
  float texVApsis = getTextureCoordFromUnitRange(1.0, RAY_DEFLECTION_TEXTURE_HEIGHT);
  ivec2 size = ivec2(RAY_DEFLECTION_TEXTURE_WIDTH, RAY_DEFLECTION_TEXTURE_HEIGHT);
  deflectionApsis = sampleTable(uDeflectionTable, vec2(texU, texVApsis), size).xy;
  return sampleTable(uDeflectionTable, vec2(texU, texV), size).xy;
}

float getPhiUbFromEsquare(float eSquare) {
  return (1.0 + eSquare) / (1.0 / 3.0 + 2.0 * eSquare * sqrt(eSquare)) * RAD;
}

vec2 lookupRayInverseRadius(float eSquare, float phi) {
  float texU = getTextureCoordFromUnitRange(
    1.0 / (1.0 + 6.0 * eSquare), RAY_INVERSE_RADIUS_TEXTURE_WIDTH);
  float texV = getTextureCoordFromUnitRange(
    phi / getPhiUbFromEsquare(eSquare), RAY_INVERSE_RADIUS_TEXTURE_HEIGHT);
  ivec2 size = ivec2(RAY_INVERSE_RADIUS_TEXTURE_WIDTH, RAY_INVERSE_RADIUS_TEXTURE_HEIGHT);
  return sampleTable(uInverseRadiusTable, vec2(texU, texV), size).xy;
}

float filteredPulse(float edge0, float edge1, float x, float fw) {
  fw = max(fw, 1e-6);
  float x0 = x - fw * 0.5;
  float x1 = x0 + fw;
  return max(0.0, (min(x1, edge1) - max(x0, edge0)) / fw);
}

/**
 * Upstream TraceRay. Returns the total deflection in radians, or -RAD when the
 * ray is captured. u0/u1 are the inverse radii of up to two disc crossings, -1
 * when there is none; t0/t1 are light travel times; alpha0/alpha1 are the
 * anti-aliased radial opacities.
 */
float traceRay(float u, float uDot, float eSquare, float delta, float alpha,
               float uInner, float uOuter,
               out float u0, out float phi0, out float t0, out float alpha0,
               out float u1, out float phi1Out, out float t1, out float alpha1,
               out float eSquareAps) {
  u0 = -1.0;
  u1 = -1.0;
  phi0 = 0.0;
  phi1Out = 0.0;
  t0 = 0.0;
  t1 = 0.0;
  alpha0 = 0.0;
  alpha1 = 0.0;
  eSquareAps = eSquare;

  if (eSquare < K_MU && u > 2.0 / 3.0) {
    return -1.0 * RAD;
  }

  vec2 deflectionApsis;
  vec2 deflection = lookupRayDeflection(eSquare, u, deflectionApsis);
  float rayDeflection = deflection.x;
  if (uDot > 0.0) {
    rayDeflection =
      eSquare < K_MU ? 2.0 * deflectionApsis.x - rayDeflection : -1.0 * RAD;
  }

  float s = sign(uDot);
  float phi = deflection.x + (s == 1.0 ? PI - delta : delta) + s * alpha;
  float phiApsis = deflectionApsis.x + PI / 2.0;

  phi0 = mod(phi, PI);
  vec2 ui0 = lookupRayInverseRadius(eSquare, phi0);
  // The side test uses the unrounded coordinate so it stays stable near u.
  if (phi0 < phiApsis) {
    float side = s * (ui0.x - u);
    if (side > 1e-3 || (side > -1e-3 && alpha < delta)) {
      u0 = ui0.x;
      phi0 = alpha + phi - phi0;
      t0 = s * (ui0.y - deflection.y);
    }
  }

  phi = 2.0 * phiApsis - phi;
  phi1Out = mod(phi, PI);
  vec2 ui1 = lookupRayInverseRadius(eSquare, phi1Out);
  if (eSquare < K_MU && s == 1.0 && phi1Out < phiApsis) {
    u1 = ui1.x;
    phi1Out = alpha + phi - phi1Out;
    t1 = 2.0 * deflectionApsis.y - ui1.y - deflection.y;
  }

  // DEVIATION FROM UPSTREAM: upstream sets both crossings to the harmonic mean of
  // the disc edges inside a fwidth-wide band around e^2 = kMu. That does not
  // remove the hard edge, it just relocates it, and it carves a dark ring where
  // the disc should be. The coverage is computed by the caller instead, in
  // uniform control flow, where fwidth() of the crossing position is actually
  // defined; see the footprint block in main().
  return rayDeflection;
}
`;

/**
 * Radio patches: a handful of finite-size emitters lying in the disc plane.
 *
 * This is deliberately the SMALLEST source model that the existing two-crossing
 * trace can support. A patch is a disc of radius rho on z = 0; it is evaluated at
 * the same crossing points the accretion disc already uses, with the same pixel
 * footprint, the same static-observer frequency shift and the same composite
 * order. Nothing here re-implements the ray; there is no extra image, no
 * screen-space offset and no area that grows the pick region.
 *
 * SCOPE, stated as a limit rather than a feature: only sources ON the disc plane
 * exist, so their images are the same two crossings the disc produces. A general
 * 3D source would need its own intersection solve and more than two images; that
 * is phase 3 work and is not claimed here. Because the patch is shaded from the
 * crossing point, a patch outside the disc annulus is invisible: the crossing
 * coverage that gates it is the disc's own coverage.
 *
 * FREQUENCY MODEL. Fixtures are STATIC (no orbital motion), so
 *   nu_emit = E / sqrt(f_emit),  nu_obs = E / sqrt(f_cam),  g = sqrt(f_emit / f_cam).
 * The disc's Keplerian g has an extra 1/sqrt(1 - 3u/2) orbital term and a
 * dot(eZ, eZPrime) beaming term; applying that to a static source would be wrong
 * by up to 30% at the inner edge, so it is not applied.
 *
 * ID CHANNEL. The visible id is decided by the contribution after everything in
 * front of it, using the same cover value that attenuates the radiance. It is a
 * hard per-pixel decision (no filtering, no blending, no tone mapping) and is
 * read back through packFloat, so an id survives exactly or not at all.
 */
const RADIO = `
const int RADIO_MAX = 4;
uniform int uRadioCount;   // active entries, 0..RADIO_MAX
uniform int uRadioMask;    // bit i enables entry i
uniform vec4 uRadioGeom[RADIO_MAX];  // xy = centre on the disc plane, z = radius, w = gpu id
uniform vec3 uRadioColor[RADIO_MAX]; // linear radiance, gain excluded
uniform float uRadioGain;

const vec3 RADIO_LUM = vec3(0.2126, 0.7152, 0.0722);

/**
 * Accumulate the patch emission at one crossing.
 *
 * Coverage. The patch is a finite disc of radius geom.z lying in the disc
 * plane, and a pixel is a small patch of that plane. What a pixel sees is the
 * fraction of its footprint that falls inside the disc, so the coverage must be
 * measured across the disc edge with the pixel's own radial width, not with a
 * square box of an arbitrary width. fwp supplies that width per screen axis:
 * the radial half-extent is 0.5 * (|ux| * fwp.x + |uy| * fwp.y). The result is a
 * ramp that is 1 inside, 0 outside, and exactly 0.5 on the geometric edge
 * regardless of how anisotropic the footprint is (measured anisotropy on these
 * fixtures is 5.6x to 59x, so a scalar fwidth could not express it).
 *
 * The hard floor that used to be here (cov < 0.05) quantised that ramp: a pixel
 * whose centre missed the edge by a hair was dropped to zero, and the sub-pixel
 * images broke into dashes. Nothing is thresholded now except cov <= 0.
 *
 * @param p              crossing position in the disc plane, shader units
 * @param uCross         inverse radius of the crossing, for the static shift
 * @param coverCross     crossing coverage from the trace (0..1)
 * @param fwp            per-axis pixel footprint at this crossing, plane units
 * @param tableSlot      1 for the trace's first slot (u0), 2 for the second (u1)
 * @param crossingIndex  1 for the first plane crossing along the ray, 2 for the
 *                       second; this is the physical order, not the table slot
 */
void radioAtCrossing(vec2 p, float uCross, float coverCross, vec2 fwp,
                     vec2 dxp, vec2 dyp,
                     float sqrtF, int tableSlot, int crossingIndex,
                     inout vec3 premul, inout float cover,
                     inout float bestLum, inout float bestId,
                     inout int bestSlot, inout int bestCrossing,
                     inout float bestCov, inout float areaAny) {
  float fSrc = max(1.0 - uCross, 1e-3);
  float gStatic = sqrt(fSrc) / sqrtF;
  float flux = pow(clamp(gStatic, 0.0, 4.0), 4.0);
  for (int i = 0; i < RADIO_MAX; i++) {
    if (i >= uRadioCount) break;
    if ((uRadioMask & (1 << i)) == 0) continue;
    vec4 geom = uRadioGeom[i];
    vec2 radial = p - geom.xy;
    float dist = length(radial);
    vec2 unit = dist > 1e-6 ? radial / dist : vec2(1.0, 0.0);
    float wRadial = 0.5 * (abs(unit.x) * fwp.x + abs(unit.y) * fwp.y);
    float cov = clamp((geom.z - dist) / max(wRadial, 1e-6) + 0.5, 0.0, 1.0);
    if (cov <= 0.0) continue;
    // Geometric attribution, separate from the coverage ramp above.
    //
    // A pixel belongs to the emitter when the emitter's disc overlaps the
    // pixel's own footprint — the parallelogram spanned by the screen-space
    // derivatives of the crossing point, dxp and dyp, centred on the crossing.
    // The disc is sampled against that cell on an 8x8 grid, so the test is the
    // real overlap and not a reach taken along one axis.
    //
    // Why this shape. Near the disc's edge-on projection one screen pixel
    // sweeps 0.17 world units of the disc plane while the patch is 0.04 in
    // radius, so the cell is several times the patch and no pixel centre can
    // land inside it: the weak-field fixture is 0.30 px thick and a
    // centre-inside test reports zero pixels for a source the reference table
    // puts at 3.0 x 0.30 px. A reach along the offset direction is no better —
    // it inherits whichever axis of the footprint happens to be wide and
    // smeared that same image over 14 px. The parallelogram keeps the narrow
    // axis narrow, because the cell is thin across the image and long along it.
    float reach = geom.z + 0.5 * (length(dxp) + length(dyp));
    float idCov = 0.0;
    if (dist <= reach) {
      float hits = 0.0;
      for (int a = 0; a < 8; a++) {
        for (int b = 0; b < 8; b++) {
          vec2 off = (vec2(float(a), float(b)) + 0.5) * 0.125 - 0.5;
          vec2 q = p + off.x * dxp + off.y * dyp;
          hits += step(length(q - geom.xy), geom.z);
        }
      }
      idCov = hits * 0.015625;
    }
    // Unconditional area coverage: the id rule above thresholds it, but the
    // anchor weight needs the integral over the whole footprint, which is
    // non-zero (and continuous) wherever the cell overlaps the patch at all.
    areaAny = max(areaAny, idCov);
    bool attributed = idCov >= 0.25;
    // The emitter's own coverage, NOT the disc's crossing coverage. The disc
    // coverage carries critFade, which fades the disc's squeezed second image as
    // e^2 approaches kMu. An emitter is not that image: its footprint is a real
    // geometric footprint, and multiplying by critFade quantised the axial arc
    // into a handful of pixels wherever the fade happened to land. What still
    // occludes an emitter is the composite order below (near crossing drawn after
    // far), not this factor.
    float a = cov;
    vec3 radiance = uRadioColor[i] * uRadioGain * flux;
    premul += radiance * a;
    // Two layers can share the pixel; occlusion unions, radiance adds. Declared
    // here so the id rule below and the picture agree.
    cover = 1.0 - (1.0 - cover) * (1.0 - a);
    float lum = dot(radiance * a, RADIO_LUM);
    // The id marks every pixel whose cell the emitter's disc overlaps — the
    // geometric footprint, not the filtered halo. The fade-out contributes
    // colour without widening the clickable region, and a disc thinner than a
    // pixel still owns the pixel it passes through instead of vanishing.
    if (attributed && lum > bestLum) {
      bestLum = lum;
      bestId = geom.w;
      bestSlot = tableSlot;
      bestCrossing = crossingIndex;
      bestCov = cov;
    }
  }
}

/**
 * Nearest emitter to a crossing, with the two projected half-extents of the
 * pixel footprint. Diagnostic only (probes 41..57): it answers "which source
 * does this crossing belong to, how far is it, and how wide is the pixel there",
 * which is what decides attribution. Reports the index 1-based so that 0 can
 * mean "no emitter reached this crossing" through an unsigned float pack.
 */
void radioNearest(vec2 p, vec2 fwp, vec2 dxp, vec2 dyp,
                  out float idx, out float dist, out float hRadial,
                  out float hTangential, out float radius, out float cov,
                  out float dRadial, out float dTangential, out float attr) {
  idx = 0.0;
  dist = 0.0;
  hRadial = 0.0;
  hTangential = 0.0;
  radius = 0.0;
  cov = 0.0;
  dRadial = 0.0;
  dTangential = 0.0;
  attr = 0.0;
  float best = 1e30;
  for (int i = 0; i < RADIO_MAX; i++) {
    if (i >= uRadioCount) break;
    if ((uRadioMask & (1 << i)) == 0) continue;
    vec4 geom = uRadioGeom[i];
    vec2 radial = p - geom.xy;
    float d = length(radial);
    if (d >= best) continue;
    best = d;
    vec2 unit = d > 1e-6 ? radial / d : vec2(1.0, 0.0);
    vec2 radialAxis = geom.xy / max(length(geom.xy), 1e-6);
    idx = float(i + 1);
    dist = d;
    radius = geom.z;
    hRadial = 0.5 * (abs(radialAxis.x) * fwp.x + abs(radialAxis.y) * fwp.y);
    hTangential = 0.5 * (abs(radialAxis.y) * fwp.x + abs(radialAxis.x) * fwp.y);
    cov = clamp((geom.z - d) / max(0.5 * (abs(unit.x) * fwp.x + abs(unit.y) * fwp.y), 1e-6) + 0.5, 0.0, 1.0);
    dRadial = abs(dot(radial, radialAxis));
    dTangential = abs(radial.x * radialAxis.y - radial.y * radialAxis.x);
    float reach = geom.z + 0.5 * (length(dxp) + length(dyp));
    float hits = 0.0;
    if (d <= reach) {
      for (int a = 0; a < 8; a++) {
        for (int b = 0; b < 8; b++) {
          vec2 off = (vec2(float(a), float(b)) + 0.5) * 0.125 - 0.5;
          vec2 q = p + off.x * dxp + off.y * dyp;
          hits += step(length(q - geom.xy), geom.z);
        }
      }
    }
    attr = hits > 0.0 ? 1.0 : 0.0;
  }
}
`;

/**
 * Fragment entry point.
 *
 * `uProbeMode` > 0 turns the shader into a numerical probe: instead of a picture
 * it packs one traced quantity per pixel as an exact float32 across RGBA8, so the
 * validation harness can compare the values the GPU actually produced against the
 * independent reference. Nothing about the trace changes between the two modes.
 */
const FRAGMENT_MAIN = `
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uViewport;
uniform float uTanHalfFov;
uniform float uTime;
uniform float uOpacity;
uniform float uExposure;
uniform int uProbeMode;
// Probe sub-rectangle: xy = bottom-left origin in drawing-buffer pixels,
// zw = size. Zero means "no region": the quad maps the whole viewport, which is
// what every phase-1 probe does and stays bit-identical.
uniform vec4 uProbeRect;

out vec4 fragColor;

/** Pack a non-negative finite float32 into RGBA8, most significant byte first. */
vec4 packFloat(float v) {
  uint bits = floatBitsToUint(v);
  return vec4(
    float((bits >> 24) & 0xFFu),
    float((bits >> 16) & 0xFFu),
    float((bits >> 8) & 0xFFu),
    float(bits & 0xFFu)) / 255.0;
}

// ACES filmic tone mapping, exactly as three.js r186 defines it, so a
// RawShaderMaterial matches what every other material in the scene would get.
vec3 acesFilmic(vec3 color) {
  const mat3 inputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 outputMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color *= uExposure / 0.6;
  color = inputMat * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outputMat * (a / b);
  return clamp(color, 0.0, 1.0);
}

// sRGB opto-electronic transfer, matching three.js's sRGBTransferOETF.
vec3 linearToSrgb(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92,
             vec3(lessThanEqual(c, vec3(0.0031308))));
}

void main() {
  vec2 fragPos = gl_FragCoord.xy + uProbeRect.xy;
  vec2 ndc = fragPos / uViewport * 2.0 - 1.0;
  float aspect = uViewport.x / uViewport.y;
  vec3 viewDir = normalize(
    uCamForward +
    uCamRight * (ndc.x * uTanHalfFov * aspect) +
    uCamUp * (ndc.y * uTanHalfFov));

  // ---- static observer frame (the plugin's camera never falls) -------------
  //
  // viewDir is the pixel direction in the CAMERA's local orthonormal frame,
  // i.e. what a static observer at r actually sees. The tables and the orbit
  // equation are written in Schwarzschild COORDINATES, whose radial basis vector
  // is shorter by sqrt(f): a coordinate displacement dr corresponds to a proper
  // length dr/sqrt(f). So the radial component of the direction has to be
  // divided by sqrt(f) before it can be used as a coordinate direction:
  //
  //   D = n_perp + sqrt(f) n_radial
  //
  // Using viewDir directly (as the previous version did) fed a LOCAL angle to a
  // CHART formula, which inflates uDot by 1/sqrt(f) and the shadow by the same
  // factor: 2.43% at the default camera distance, measured on the GPU.
  // Only the disc-free passage changes the apparent lens size. A virtual
  // observer recedes radially while the REAL camera and captured disc cells stay
  // untouched: the shadow and its lensed rim shrink together about the hole.
  // Probes/capture and the resting image retain the original observer exactly.
  float holeScale = 1.0;
  if (uDiscTransfer >= 0.0 && uProbeMode == 0) {
    holeScale = 1.0 - smoothstep(0.0, 1.0, uDiscTransfer);
  }
  vec3 traceCamPos = uCamPos / max(holeScale, 0.002);
  float rCam = length(traceCamPos);
  float u = 1.0 / rCam;
  vec3 eXPrime = traceCamPos / rCam;
  float fCam = max(1.0 - u, 1e-6);
  float sqrtF = sqrt(fCam);
  float dRadial = dot(viewDir, eXPrime);
  vec3 dChart = normalize(viewDir + (sqrtF - 1.0) * dRadial * eXPrime);

  // GUARD: a purely radial ray makes cross(eXPrime, d) vanish, and normalize()
  // of a zero vector is NaN. Any perpendicular is a valid orbital-plane normal
  // for a radial ray (it has no angular momentum), so pick one deterministically.
  vec3 eZPrime = cross(eXPrime, dChart);
  float eZLen = length(eZPrime);
  if (eZLen < 1e-6) {
    vec3 fallback = abs(eXPrime.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
    eZPrime = cross(eXPrime, fallback);
    eZLen = length(eZPrime);
  }
  eZPrime /= max(eZLen, 1e-9);
  vec3 eYPrime = normalize(cross(eZPrime, eXPrime));

  const vec3 eZ = vec3(0.0, 0.0, 1.0);
  // GUARD: an orbital plane containing the disc axis makes cross(eZ, eZPrime)
  // vanish. Any unit vector perpendicular to eZPrime is a valid azimuth origin
  // for that ray, so fall back to one instead of normalising zero.
  vec3 tAxis = cross(eZ, eZPrime);
  float tLen = length(tAxis);
  if (tLen < 1e-6) tAxis = cross(eYPrime, eZPrime);
  tAxis = normalize(tAxis);
  if (dot(tAxis, eYPrime) < 0.0) tAxis = -tAxis;

  float alpha = acos(clamp(dot(eXPrime, tAxis), -1.0, 1.0));
  // GUARD: delta = 0 or pi is a purely radial ray, where 1/tan(delta) blows up.
  // Clamping keeps uDot finite; the limiting values are still the correct ones
  // (an inward radial ray has e^2 >> kMu and is captured, an outward one is
  // undeflected), so this changes no classification.
  float delta = acos(clamp(dot(eXPrime, dChart), -1.0, 1.0));
  delta = clamp(delta, 1e-4, PI - 1e-4);

  // Exact for the chart angle: du/dphi = -u*cos(delta)/sin(delta).
  float uDot = -u / tan(delta);
  float eSquare = uDot * uDot + u * u * (1.0 - u);
  float e = -sqrt(max(eSquare, 0.0));

  float uInner = 1.0 / DISC_INNER;
  float uOuter = 1.0 / DISC_OUTER;

  float u0, phi0, t0, a0, u1, phi1, t1, a1, eSquareAps;
  float deflection = traceRay(u, uDot, eSquare, delta, alpha, uInner, uOuter,
                              u0, phi0, t0, a0, u1, phi1, t1, a1, eSquareAps);

  // Receiver frequency shift. The photon's conserved energy is E = -p_t, and the
  // trace parameterises p_t = e (so E = -e, positive). A STATIC observer has
  // 4-velocity u^t = 1/sqrt(f), not 1: u^t u_t = -1 with u_t = -f u^t. The
  // observed frequency is therefore nu = -p.u = f u^t E/sqrt(f)... evaluated
  // directly: nu = -p_mu u^mu = -p_t u^t = E/sqrt(f). So the receiver factor is
  // e/sqrt(f), and dropping the 1/sqrt(f) made every frequency 2.4% low at the
  // default camera (4.7% on brightness, since the flux goes as g^4).
  float gReceiver = e / sqrtF;

  // Pixel footprint on the disc, computed in uniform control flow so that
  // fwidth() is well defined, and reused for both crossings. A ray close to the
  // disc plane can lose one of its two crossings, and along the curve where that
  // happens the SAME crossing is merely re-labelled: the crossing that ran off
  // to infinity was index 0, so what is left reads as index 1 on one side of the
  // curve and index 0 on the other. The absent slot must therefore fall back to
  // the slot that does exist, not to a sentinel. A sentinel (u = -1, or a unit
  // position vector) differs from the real crossing by ~5 Rs, and fwidth() reads
  // that jump across the 2x2 quad as a genuine pixel footprint. That inflated
  // footprint then widens the coverage ramps far past the disc's own radial band
  // and the coverage collapses to a hairline — the thin dark arc that used to
  // cut across the disc and out to both frame edges.
  vec3 crossDir0 = eXPrime * cos(phi0) + eYPrime * sin(phi0);
  vec3 crossDir1 = eXPrime * cos(phi1) + eYPrime * sin(phi1);
  vec3 point0 = u0 > 0.0 ? crossDir0 / u0 : (u1 > 0.0 ? crossDir1 / u1 : crossDir0);
  vec3 point1 = u1 > 0.0 ? crossDir1 / u1 : (u0 > 0.0 ? crossDir0 / u0 : crossDir1);
  float footprint0 = max(max(fwidth(point0.x), fwidth(point0.y)), fwidth(point0.z));
  float footprint1 = max(max(fwidth(point1.x), fwidth(point1.y)), fwidth(point1.z));
  // Per-axis footprint in the disc plane, for the radio coverage ramp. The disc
  // plane is the (x, y) chart plane, so only those two components matter.
  vec2 fwp0 = vec2(fwidth(point0.x), fwidth(point0.y));
  vec2 fwp1 = vec2(fwidth(point1.x), fwidth(point1.y));

  // Recompute the disc coverage from that footprint: the width in u is the
  // footprint divided by the Jacobian of u -> 1/u, i.e. footprint/u^2.
  //
  // Both ramps need a second, independent floor: fwidth() of the crossing itself.
  // The radial footprint only measures how fast the crossing slides across the
  // plane, so it does not see the disc's inner or outer edge cutting through the
  // pixel. Near the critical curve, and where a ray barely grazes the plane, the
  // edge does exactly that; without the floor the coverage switched on and off in
  // whole-pixel steps and printed a dotted line across the disc.
  float u0ForDerivative = u0 > 0.0 ? u0 : max(u1, 0.0);
  float u1ForDerivative = u1 > 0.0 ? u1 : max(u0, 0.0);
  float fwU0 = fwidth(u0ForDerivative);
  float fwU1 = fwidth(u1ForDerivative);
  if (u0 >= 0.0) a0 = filteredPulse(uOuter, uInner, u0, max(max(footprint0 * u0 * u0, fwU0), 1e-6));
  // Critical band: as e^2 approaches kMu the secondary image is squeezed into a
  // single pixel and has to fade. Written as a clamped ramp with an explicit
  // direction — smoothstep(kMu, kMu - 2c, e) reverses its edges, which is
  // undefined in GLSL, and a collapsed footprint would give it zero width.
  // All derivatives live here, in uniform control flow: fwidth inside a divergent
  // branch is undefined, which is how the earlier attempt at this failed silently.
  // Same sentinel rule as the positions above: the differential is taken on the
  // crossing whichever slot it landed in, so a label swap does not read as a
  // ~1 unit jump and does not collapse this branch's coverage ramp.
  float crit = min(fwidth(eSquare), K_MU);
  float critBand = max(2.0 * crit, 1e-6);
  float critFade = clamp((K_MU - eSquare) / critBand, 0.0, 1.0);
  if (u1 >= 0.0) {
    // Near the critical curve the secondary image is thinner than a pixel, and the
    // disc's inner and outer edges cut across it inside one pixel. The radial
    // footprint does not see that cut — it only sees how fast the crossing slides
    // radially — so the coverage switched on and off pixel by pixel and the arc
    // rendered as a dotted line. fwidth(u1) measures exactly the jump the footprint
    // misses; taking it as a floor turns the arc back into a continuous, dimmer
    // band, which is what a sub-pixel feature has to integrate to.
    float coverWidth = max(max(footprint1 * u1 * u1, fwU1), 1e-6);
    a1 = filteredPulse(uOuter, uInner, u1, coverWidth) * critFade;
  }

  float doppler0 = 1.0;
  float doppler1 = 1.0;
  vec4 disc0 = vec4(0.0);
  vec4 disc1 = vec4(0.0);
  float brightness0 = 0.0;
  float brightness1 = 0.0;
  float stationId0 = -1.0;
  float stationId1 = -1.0;

  // Radio fixture accumulators. They are filled at the same two crossings the
  // disc uses, so a patch can never appear where the ray did not actually go.
  vec3 radioPrem0 = vec3(0.0);
  vec3 radioPrem1 = vec3(0.0);
  float radioCover0 = 0.0;
  float radioCover1 = 0.0;
  float radioLum0 = 0.0;
  float radioLum1 = 0.0;
  float radioId0 = 0.0;
  float radioId1 = 0.0;
  int radioSlot0 = 0;
  int radioSlot1 = 0;
  int radioCrossing0 = 0;
  int radioCrossing1 = 0;
  float radioCov0 = 0.0;
  float radioCov1 = 0.0;
  // Area coverage of the winning emitter: the fraction of this pixel's footprint
  // the patch actually covers, before the coverage ramp's clamp. It is a smooth
  // integral of the geometry, unlike the binary attribution, so anchor positions
  // derived from it do not jump when the attribution threshold flips a row.
  float radioArea0 = 0.0;
  float radioArea1 = 0.0;

  // Crossing points and their screen-space derivatives, computed OUTSIDE the
  // crossing branches. A derivative taken inside the u1 >= 0 branch is undefined
  // wherever that condition is not uniform across the 2x2 quad, which is most of
  // the shadow's edge; the guarded denominator keeps the value finite when a
  // branch does not exist, and the branch below still decides what is drawn.
  vec2 i1s = crossDir1.xy / max(u1, 1e-6);
  vec2 i0s = crossDir0.xy / max(u0, 1e-6);
  vec2 dxp1 = dFdx(i1s);
  vec2 dyp1 = dFdy(i1s);
  vec2 dxp0 = dFdx(i0s);
  vec2 dyp0 = dFdy(i0s);

  // Retarded time spans more than a detail lifetime across one pixel => no
  // resolvable detail left, only its mean.
  float detailTrust1 = 1.0 - smoothstep(6.0, 24.0, fwidth(t1));
  float detailTrust0 = 1.0 - smoothstep(6.0, 24.0, fwidth(t0));
  // The crossing must EXIST; it need not have disc coverage. A radio emitter is
  // not the disc's squeezed second image, so critFade inside a1 must not gate it.
  if (u1 >= 0.0) {
    // Emitter 4-velocity contraction for a circular Schwarzschild orbit.
    float gSource = e * sqrt(2.0 / (2.0 - 3.0 * u1))
                  - u1 * sqrt(u1 / (2.0 - 3.0 * u1)) * dot(eZ, eZPrime);
    doppler1 = gReceiver / gSource;
    vec3 i1 = crossDir1 / u1;
    disc1 = shadeDisc(i1.xy, uTime - t1, uTime - uStationPhase, doppler1, footprint1, detailTrust1, stationId1);
    brightness1 = dot(disc1.rgb, vec3(0.2126, 0.7152, 0.0722));
    radioAtCrossing(i1.xy, u1, a1, fwp1, dxp1, dyp1, sqrtF, 2, (u0 >= 0.0 ? 2 : 1),
                    radioPrem1, radioCover1, radioLum1, radioId1, radioSlot1,
                    radioCrossing1, radioCov1, radioArea1);
  }
  if (u0 >= 0.0) {
    float gSource = e * sqrt(2.0 / (2.0 - 3.0 * u0))
                  - u0 * sqrt(u0 / (2.0 - 3.0 * u0)) * dot(eZ, eZPrime);
    doppler0 = gReceiver / gSource;
    vec3 i0 = crossDir0 / u0;
    disc0 = shadeDisc(i0.xy, uTime - t0, uTime - uStationPhase, doppler0, footprint0, detailTrust0, stationId0);
    brightness0 = dot(disc0.rgb, vec3(0.2126, 0.7152, 0.0722));
    radioAtCrossing(i0.xy, u0, a0, fwp0, dxp0, dyp0, sqrtF, 1, 1,
                    radioPrem0, radioCover0, radioLum0, radioId0, radioSlot0,
                    radioCrossing0, radioCov0, radioArea0);
  }

  // ---- assemble: background, then the far crossing, then the near one ------
  vec3 color = vec3(0.0);
  // The ray reaches the sky iff it ESCAPES. e = 1/b and kMu = 1/b_crit^2, so
  // b < b_crit is the capture condition — but only for a ray that is actually
  // heading IN. A ray leaving the camera outwards escapes for any b: it is not
  // going to fall in, it is already going the other way. Gating this on e^2 alone
  // would paint the sky black behind the camera's own escape cone. And it must
  // not be gated on the sign of the deflection instead: for an inbound captured
  // ray the table returns a small POSITIVE deflection, so a deflection sign test
  // paints a sky inside the shadow.
  bool inbound = uDot > 0.0;
  bool captured = inbound && (eSquare >= K_MU);
  if (!captured) {
    float deltaPrime = delta + max(deflection, 0.0);
    vec3 dPrime = cos(deltaPrime) * eXPrime + sin(deltaPrime) * eYPrime;
    // Per-pixel solid angle of the undeflected vs the deflected direction. Their
    // ratio is the magnification, applied to the point sources only.
    float omega = length(cross(dFdx(viewDir), dFdy(viewDir)));
    float omegaPrime = length(cross(dFdx(dPrime), dFdy(dPrime)));
    // A point source keeps its flux, so its surface brightness falls by the same
    // ratio — but only while the lensed image still covers the pixel. Towards the
    // critical curve omegaPrime collapses, the affine approximation fails, the
    // ratio diverges and a single star saturates into a one-pixel white arc. That
    // is undersampling, not the photon ring, so the gain is capped where the image
    // would shrink below a pixel. Extended emission is unaffected.
    float starFlux = omegaPrime > 1e-12 ? min(omega / omegaPrime, 4.0) : 1.0;
    // A point source is only meaningful while its image is still resolved: past a
    // compression of a few pixels per pixel, hundreds of independent sky cells land
    // on one sample, and the star field aliases into a dotted white arc that looks
    // like a photon ring but is not one. Where that happens the star layer is
    // faded to its mean and the diffuse sky — which is smooth — carries the annulus.
    float starTrust = 1.0 - smoothstep(2.0, 8.0, omega / max(omegaPrime, 1e-12));
    color = (backgroundDiffuse(dPrime) + backgroundStars(dPrime, starFlux) * starTrust) * critFade;
    // The escape test is a hard yes/no, and the sky is noisy, so the boundary
    // between "got a sky pixel" and "got the shadow" lands between pixel centres
    // and breaks into a one-pixel dotted arc. Weighting the sky by the same
    // critical-band ramp makes that edge continuous: a pixel straddling the
    // critical curve gets the fraction of sky that actually reaches it.
    // (kept in one place above)
  }
  vec3 backgroundColor = color;

  // shadeDisc returns premultiplied rgb and the MATERIAL alpha in .a, while a0/a1
  // are the COVERAGE weights from the trace (how much of the pixel's footprint
  // lands on the disc at all). These are different quantities and the previous
  // version conflated them: it multiplied the background by (1-a) but never by
  // the material opacity, so a crossing with density 0.002 still erased the sky
  // behind it. The composite is the product: coverage scales both the emitted
  // radiance and the occlusion, and the premultiplied rgb is added as is.
  float cover1 = a1 * disc1.a;
  float cover0 = a0 * disc0.a;

  // ---- one composite: radiance adds, occlusion unions ----------------------
  // At a single crossing the disc and a radio patch are both emitters that also
  // occlude, so the fraction of anything behind BOTH of them is
  // (1 - cover) * (1 - radioCover); call it merged. Emitted radiance is added
  // scaled by its own coverage and is never scaled by the other emitter.
  //
  // The far crossing is composited first and the near crossing attenuates it, so
  // the near merged applies to everything the far crossing emitted. This used to
  // be a two-step composite: the disc was drawn into color first and the patch
  // branch then re-added disc.rgb * a, which counted the far disc emission twice
  // and multiplied the background by both (1 - cover) and (1 - merged). Doing it
  // once removes both errors and is bit-identical whenever radioCover is zero.
  float merged1 = 1.0 - (1.0 - cover1) * (1.0 - radioCover1);
  float merged0 = 1.0 - (1.0 - cover0) * (1.0 - radioCover0);
  color = backgroundColor * (1.0 - merged1) * (1.0 - merged0)
    + (disc1.rgb * a1 + radioPrem1) * (1.0 - merged0)
    + (disc0.rgb * a0 + radioPrem0);

  // Capture the actual displayed disc, not another procedural particle field.
  // Coverage is binary here: a source tile carries the complete original pixel,
  // including its lensed arc and local sky contribution. At progress zero these
  // tiles reconstruct the original image exactly over the disc-free background.
  if (uProbeMode == 66) {
    float present = max(a0 * disc0.a, a1 * disc1.a) > 0.00001 ? 1.0 : 0.0;
    fragColor = vec4(linearToSrgb(acesFilmic(max(color, vec3(0.0)))), present);
    return;
  }
  if (uDiscTransfer >= 0.0 && uProbeMode == 0) {
    vec3 straightSky = backgroundDiffuse(viewDir) + backgroundStars(viewDir, 1.0);
    // Keep a solid silhouette while it contracts; dissolve only the last small
    // remnant. Running the same progress backwards reveals it before it expands.
    float dissolve = 1.0 - smoothstep(0.0, 0.12, holeScale);
    color = mix(backgroundColor, straightSky, dissolve);
  }

  // Visible id: the far patch only counts for what survives the near crossing.
  // The id carries TWO independent labels: the table slot the trace used, and
  // the crossing index in physical order along the ray. They are not the same
  // thing — a ray that crosses the plane once but is solved by the table's second
  // branch reports slot 2, crossing 1 — so they are reported separately.
  float effFar = radioLum1 * (1.0 - cover0);
  float visibleId = 0.0;
  float visibleSlot = 0.0;
  float visibleCrossing = 0.0;
  float visibleRadioLum = 0.0;
  float visibleCov = 0.0;
  // Area coverage of the isolated emitter at whichever crossing is in front: the
  // anchor weight. max() of the two, because both crossings are images of the
  // same source and only one of them can be local to a pixel.
  float visibleArea = 0.0;
  visibleArea = max(radioArea0, radioArea1);
  if (radioLum0 >= effFar && radioLum0 > 0.0) {
    visibleId = radioId0;
    visibleSlot = float(radioSlot0);
    visibleCrossing = float(radioCrossing0);
    visibleRadioLum = radioLum0;
    visibleCov = radioCov0;
  } else if (effFar > 0.0) {
    visibleId = radioId1;
    visibleSlot = float(radioSlot1);
    visibleCrossing = float(radioCrossing1);
    visibleRadioLum = effFar;
    visibleCov = radioCov1;
  }

  // ---- diagnostic geometry probes 41..57 ----------------------------------
  // Which emitter each crossing is nearest to, how far, and how wide the pixel
  // is there. Guarded by a uniform so the picture path pays nothing.
  float d1Idx = 0.0;
  float d1Dist = 0.0;
  float d1HR = 0.0;
  float d1HT = 0.0;
  float d1DR = 0.0;
  float d1DT = 0.0;
  float d1Attr = 0.0;
  float d1Rad = 0.0;
  float d1Cov = 0.0;
  float d1X = 0.0;
  float d1Y = 0.0;
  float d0Idx = 0.0;
  float d0Dist = 0.0;
  float d0HR = 0.0;
  float d0HT = 0.0;
  float d0DR = 0.0;
  float d0DT = 0.0;
  float d0Attr = 0.0;
  float d0Rad = 0.0;
  float d0Cov = 0.0;
  float d0X = 0.0;
  float d0Y = 0.0;
  if (uProbeMode >= 41) {
    if (u1 >= 0.0) {
      vec3 i1 = crossDir1 / u1;
      d1X = i1.x;
      d1Y = i1.y;
      radioNearest(i1.xy, fwp1, dFdx(i1s), dFdy(i1s), d1Idx, d1Dist, d1HR, d1HT, d1Rad, d1Cov, d1DR, d1DT, d1Attr);
    }
    if (u0 >= 0.0) {
      vec3 i0 = crossDir0 / u0;
      d0X = i0.x;
      d0Y = i0.y;
      radioNearest(i0.xy, fwp0, dFdx(i0s), dFdy(i0s), d0Idx, d0Dist, d0HR, d0HT, d0Rad, d0Cov, d0DR, d0DT, d0Attr);
    }
  }

  if (uProbeMode > 0) {
    // A click asks one question: which station does this pixel belong to? The
    // brighter crossing wins, because that is the one that dominates the image.
    // A crossing that does not exist must not contribute to the comparison.
    bool has0 = u0 >= 0.0;
    bool has1 = u1 >= 0.0;
    float pickedStation = -1.0;
    if (has0 && has1) {
      pickedStation = brightness0 * a0 >= brightness1 * a1 ? stationId0 : stationId1;
    } else if (has0) {
      pickedStation = stationId0;
    } else if (has1) {
      pickedStation = stationId1;
    }
    float value = 0.0;
    if (uProbeMode == 1) value = deflection;
    else if (uProbeMode == 2) value = eSquare;
    else if (uProbeMode == 3) value = u0;
    else if (uProbeMode == 4) value = t0;
    else if (uProbeMode == 5) value = u1;
    else if (uProbeMode == 6) value = t1;
    else if (uProbeMode == 7) value = doppler0;
    else if (uProbeMode == 8) value = a0;
    else if (uProbeMode == 9) value = brightness0;
    else if (uProbeMode == 10) value = brightness1;
    else if (uProbeMode == 11) value = doppler1;
    else if (uProbeMode == 12) value = alpha;
    else if (uProbeMode == 13) value = delta;
    else if (uProbeMode == 14) value = uDot;
    else if (uProbeMode == 15) value = color.r;
    else if (uProbeMode == 16) value = color.b;
    else if (uProbeMode == 17) value = length(color);
    else if (uProbeMode == 18) value = a1;
    else if (uProbeMode == 19) value = disc0.a;
    else if (uProbeMode == 20) value = disc1.a;
    else if (uProbeMode == 21) value = backgroundColor.r;
    // 65: the station index under this pixel, or -1. Appended after the whole
    // existing range so no fixture probe number moves.
    else if (uProbeMode == 65) value = pickedStation;
    else if (uProbeMode == 22) value = disc0.rgb.r;
    else if (uProbeMode == 23) value = disc1.rgb.r;
    else if (uProbeMode == 24) value = footprint0;
    else if (uProbeMode == 25) value = footprint1;
    // 26..32 are the phase-2 radio fixture probes. Existing numbering above is
    // untouched on purpose: the CPU validator and the phase-1 harness depend on it.
    else if (uProbeMode == 26) value = visibleId;
    else if (uProbeMode == 27) value = visibleSlot;
    else if (uProbeMode == 28) value = radioCover0;
    else if (uProbeMode == 29) value = radioCover1;
    else if (uProbeMode == 30) value = radioLum0;
    else if (uProbeMode == 31) value = radioLum1;
    else if (uProbeMode == 32) value = visibleRadioLum;
    // 33.. are the phase-2 review additions: the physical crossing index, the
    // emitter coverage of the visible pixel, and the colour chain in two layers —
    // linear before tone mapping, and the value actually written to the framebuffer.
    else if (uProbeMode == 33) value = visibleCrossing;
    else if (uProbeMode == 34) value = visibleCov;
    else if (uProbeMode == 35) value = color.r;
    else if (uProbeMode == 36) value = color.g;
    else if (uProbeMode == 37) value = color.b;
    else if (uProbeMode == 38) value = linearToSrgb(acesFilmic(max(color, vec3(0.0)))).r;
    else if (uProbeMode == 39) value = linearToSrgb(acesFilmic(max(color, vec3(0.0)))).g;
    else if (uProbeMode == 40) value = linearToSrgb(acesFilmic(max(color, vec3(0.0)))).b;
    // 41..57: crossing geometry per slot, for the weak-field and near-axis
    // investigation. Slot 2 is the trace's u1 branch, slot 1 its u0 branch.
    // The index is 1-based (0 = no emitter), because packFloat is unsigned.
    else if (uProbeMode == 41) value = d1Idx;
    else if (uProbeMode == 42) value = d1Dist;
    else if (uProbeMode == 43) value = d1HR;
    else if (uProbeMode == 44) value = d1HT;
    else if (uProbeMode == 45) value = d1Rad;
    else if (uProbeMode == 46) value = d1X;
    else if (uProbeMode == 47) value = d1Y;
    else if (uProbeMode == 48) value = d1Cov;
    else if (uProbeMode == 49) value = d0Idx;
    else if (uProbeMode == 50) value = d0Dist;
    else if (uProbeMode == 51) value = d0HR;
    else if (uProbeMode == 52) value = d0HT;
    else if (uProbeMode == 53) value = d0X;
    else if (uProbeMode == 54) value = d0Y;
    else if (uProbeMode == 55) value = d0Cov;
    // 56/57: the attribution predicate itself, so a mismatch between the id map
    // and the geometry can be read off one pixel at a time.
    else if (uProbeMode == 56) value = d1Attr;
    else if (uProbeMode == 57) value = d0Attr;
    // 58..61: the two axis-aligned offsets the attribution predicate compares,
    // so a pixel that is attributed (or not) can be explained from the dump.
    else if (uProbeMode == 58) value = d1DR;
    else if (uProbeMode == 59) value = d1DT;
    else if (uProbeMode == 60) value = d0DR;
    else if (uProbeMode == 61) value = d0DT;
    // 62: area coverage of the winning emitter — the fraction of the pixel's
    // footprint the patch covers, before the coverage ramp's clamp. Continuous
    // under camera motion, so anchors are read from this instead of the
    // thresholded id set. 63/64: the two crossings separately, for comparison.
    else if (uProbeMode == 62) value = visibleArea;
    else if (uProbeMode == 63) value = radioArea0;
    else if (uProbeMode == 64) value = radioArea1;
    fragColor = packFloat(value);
    return;
  }

  color = linearToSrgb(acesFilmic(max(color, vec3(0.0))));
  fragColor = vec4(color, uOpacity);
}
`;

/** Assemble the complete fragment shader. */
export function buildFragmentShader() {
  return [HEADER, DISC, BACKGROUND, TABLE_FETCH, TRACE, RADIO, FRAGMENT_MAIN].join('\n');
}

/**
 * Vertex shader: a full-viewport quad, no camera matrices involved. The ray for
 * each pixel is built in the fragment shader from uCamPos / uCamRight / uCamUp /
 * uCamForward, so the imaging pass is independent of where the quad sits.
 */
export const VERTEX_SHADER = `precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;
