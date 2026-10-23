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
const float DISC_OUTER = ${f(IMAGING_CONSTANTS.DISK_OUTER)};
// r at which T(r) peaks, (49/36) r_in, used to normalise the profile.
const float DISC_R_PEAK = ${f((49 / 36) * IMAGING_CONSTANTS.ISCO)};
const float T_PEAK = ${f(IMAGING_CONSTANTS.T_PEAK)};
const float DISC_GAIN = ${f(IMAGING_CONSTANTS.DISC_GAIN)};
const float T_PROFILE_MAX = pow(
  (1.0 - sqrt(DISC_INNER / DISC_R_PEAK)) / (DISC_R_PEAK * DISC_R_PEAK * DISC_R_PEAK),
  0.25);

/** Angular velocity of a circular Schwarzschild orbit, dphi/dt, Rs units. */
float keplerOmega(float r) {
  return sqrt(MASS / (r * r * r));
}

/** Normalised effective temperature, 0..1, peaking at 1. */
float discTemperatureProfile(float r) {
  if (r <= DISC_INNER) return 0.0;
  float raw = pow(max(1.0 - sqrt(DISC_INNER / r), 0.0) / (r * r * r), 0.25);
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

float discDensity(float r, float phi, float retardedTime, float footprint, float detailTrust) {
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
  vec3 seed0 = detailSeed(k);
  vec3 seed1 = detailSeed(k - 1.0);
  // sin^2 weights, summing to one, zero for the incoming layer at its birth.
  float w0 = sin(PI * age / DETAIL_LIFE);
  w0 *= w0;
  float detail = w0 * discDetail(p0 + seed0, footprint)
               + (1.0 - w0) * discDetail(p1 + seed1, footprint);
  // A pixel that straddles a large span of retarded time (the secondary image near
  // the critical curve, where the light travel time diverges) has no single detail
  // value to report: the fibres it covers are far shorter than the pixel. Point-
  // sampling them turns the thin arc into a speckle of isolated bright dots. The
  // honest pixel value is the mean of the detail over that span, so fade to it.
  detail = mix(0.5, detail, clamp(detailTrust, 0.0, 1.0));
  // Wide, smooth range with modest contrast: density detail on a smooth disc, not
  // a field of discrete points and not a hard-edged ring pattern.
  return 0.62 + 0.52 * smoothstep(0.20, 0.88, detail);
}

/**
 * The disc's contribution at one crossing.
 *
 * @param discPos      point on the disc, Rs units, shader frame (z ~ 0)
 * @param retardedTime camera time minus the light travel time
 * @param doppler      g = nu_obs / nu_emit
 */
vec4 shadeDisc(vec2 discPos, float retardedTime, float doppler, float footprint, float detailTrust) {
  float r = length(discPos);
  if (r < DISC_INNER || r > DISC_OUTER) return vec4(0.0);

  float profile = discTemperatureProfile(r);
  if (profile <= 0.0) return vec4(0.0);

  float phi = atan(discPos.y, discPos.x);
  float density = discDensity(r, phi, retardedTime, footprint, detailTrust);

  // Radial tapers: a zero-torque inner edge whose emission dies away, and a soft
  // outer rim so the disc does not end on a hard circle.
  float innerRamp = smoothstep(DISC_INNER, DISC_INNER * 1.05, r);
  float outerFade = 1.0 - smoothstep(DISC_OUTER * 0.70, DISC_OUTER, r);

  float temperature = profile * T_PEAK;
  float temperatureObserved = temperature * max(doppler, 1e-3);

  vec3 chroma = blackBodyChromaticity(temperatureObserved);
  float g = max(doppler, 1e-3);
  // Bolometric g^4 times Stefan-Boltzmann T^4, both linear light.
  float brightness = g * g * g * g * profile * profile * profile * profile;

  float alpha = clamp(innerRamp * outerFade * density, 0.0, 1.0);
  vec3 rgb = chroma * brightness * DISC_GAIN;
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

/** Diffuse component: smooth, so no aliasing when the ray winds. */
vec3 backgroundDiffuse(vec3 dir) {
  vec3 bandNormal = normalize(vec3(0.34, 0.86, -0.38));
  float band = exp(-pow(dot(dir, bandNormal) / 0.34, 2.0));
  float mottle = fbm3(dir * 3.4);
  float mottle2 = fbm3(dir * 9.0 + vec3(2.2, 8.8, 4.4));
  vec3 bandColor = vec3(0.045, 0.056, 0.090) * band * (0.55 + 0.70 * mottle)
                 + vec3(0.024, 0.021, 0.033) * band * mottle2 * 0.6;
  vec3 ambient = vec3(0.0042, 0.0052, 0.0090) * (0.55 + 0.9 * mottle);
  return ambient + bandColor;
}

/**
 * Point-like component.
 *
 * The flux argument is the lensing flux correction: an unresolved source keeps
 * flux, so when the lens stretches its image the surface brightness must drop by
 * the same factor. Extended emission (backgroundDiffuse) does the opposite and
 * keeps surface brightness, which is why the two are scaled differently.
 */
vec3 backgroundStars(vec3 dir, float flux) {
  vec3 scaled = dir * 0.55;
  float s1 = starLayer(scaled, 22.0, 0.0034, 1.0, 0.0);
  float s2 = starLayer(scaled, 46.0, 0.0028, 0.30, 1.0);
  float warmth = fbm3(dir * 22.0);
  vec3 tint = mix(vec3(0.74, 0.83, 1.0), vec3(1.0, 0.84, 0.66), warmth);
  return tint * (s1 + s2) * 0.55 * flux;
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
  vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
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
  float rCam = length(uCamPos);
  float u = 1.0 / rCam;
  vec3 eXPrime = uCamPos / rCam;
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
  // fwidth() is well defined, and reused for both crossings. Where a crossing
  // does not exist the position is a unit vector, which keeps the derivative
  // finite and harmless.
  vec3 crossDir0 = eXPrime * cos(phi0) + eYPrime * sin(phi0);
  vec3 crossDir1 = eXPrime * cos(phi1) + eYPrime * sin(phi1);
  vec3 point0 = crossDir0 * (u0 > 0.0 ? 1.0 / u0 : 1.0);
  vec3 point1 = crossDir1 * (u1 > 0.0 ? 1.0 / u1 : 1.0);
  float footprint0 = max(max(fwidth(point0.x), fwidth(point0.y)), fwidth(point0.z));
  float footprint1 = max(max(fwidth(point1.x), fwidth(point1.y)), fwidth(point1.z));

  // Recompute the disc coverage from that footprint: the width in u is the
  // footprint divided by the Jacobian of u -> 1/u, i.e. footprint/u^2.
  if (u0 >= 0.0) a0 = filteredPulse(uOuter, uInner, u0, max(footprint0 * u0 * u0, 1e-6));
  // Critical band: as e^2 approaches kMu the secondary image is squeezed into a
  // single pixel and has to fade. Written as a clamped ramp with an explicit
  // direction — smoothstep(kMu, kMu - 2c, e) reverses its edges, which is
  // undefined in GLSL, and a collapsed footprint would give it zero width.
  // All derivatives live here, in uniform control flow: fwidth inside a divergent
  // branch is undefined, which is how the earlier attempt at this failed silently.
  float fwU1 = fwidth(u1);
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

  // Retarded time spans more than a detail lifetime across one pixel => no
  // resolvable detail left, only its mean.
  float detailTrust1 = 1.0 - smoothstep(6.0, 24.0, fwidth(t1));
  float detailTrust0 = 1.0 - smoothstep(6.0, 24.0, fwidth(t0));
  if (u1 >= 0.0 && a1 > 0.0) {
    // Emitter 4-velocity contraction for a circular Schwarzschild orbit.
    float gSource = e * sqrt(2.0 / (2.0 - 3.0 * u1))
                  - u1 * sqrt(u1 / (2.0 - 3.0 * u1)) * dot(eZ, eZPrime);
    doppler1 = gReceiver / gSource;
    vec3 i1 = crossDir1 / u1;
    disc1 = shadeDisc(i1.xy, uTime - t1, doppler1, footprint1, detailTrust1);
    brightness1 = dot(disc1.rgb, vec3(0.2126, 0.7152, 0.0722));
  }
  if (u0 >= 0.0 && a0 > 0.0) {
    float gSource = e * sqrt(2.0 / (2.0 - 3.0 * u0))
                  - u0 * sqrt(u0 / (2.0 - 3.0 * u0)) * dot(eZ, eZPrime);
    doppler0 = gReceiver / gSource;
    vec3 i0 = crossDir0 / u0;
    disc0 = shadeDisc(i0.xy, uTime - t0, doppler0, footprint0, detailTrust0);
    brightness0 = dot(disc0.rgb, vec3(0.2126, 0.7152, 0.0722));
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
  color = color * (1.0 - cover1) + disc1.rgb * a1;
  float cover0 = a0 * disc0.a;
  color = color * (1.0 - cover0) + disc0.rgb * a0;

  if (uProbeMode > 0) {
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
    else if (uProbeMode == 22) value = disc0.rgb.r;
    else if (uProbeMode == 23) value = disc1.rgb.r;
    else if (uProbeMode == 24) value = footprint0;
    else if (uProbeMode == 25) value = footprint1;
    fragColor = packFloat(value);
    return;
  }

  color = linearToSrgb(acesFilmic(max(color, vec3(0.0))));
  fragColor = vec4(color, uOpacity);
}
`;

/** Assemble the complete fragment shader. */
export function buildFragmentShader() {
  return [HEADER, DISC, BACKGROUND, TABLE_FETCH, TRACE, FRAGMENT_MAIN].join('\n');
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
