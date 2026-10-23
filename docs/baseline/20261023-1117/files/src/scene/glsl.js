/**
 * Shared GLSL snippets.
 *
 * The noise here is value noise on a 3-D lattice: it is seamless in every
 * direction, which is exactly what the disk needs. Sampling 2-D noise in
 * (angle, radius) would leave a visible seam at angle = 0/2π; sampling a
 * continuous 3-D field on the circle gets rid of it without any wrap trick.
 */

/**
 * `hash` is Inigo Quilez's integer-free hash13. `vnoise` interpolates it with a
 * smoothstep-weighted trilinear blend, and `fbm` stacks four octaves. Costs
 * 32 hash evaluations per fbm call, which is fine for the disk (the only place
 * it is used) but would be wasteful in a full-screen pass.
 */
export const NOISE_GLSL = /* glsl */ `
float bhHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float bhNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(bhHash(i + vec3(0.0, 0.0, 0.0)), bhHash(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(bhHash(i + vec3(0.0, 1.0, 0.0)), bhHash(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(bhHash(i + vec3(0.0, 0.0, 1.0)), bhHash(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(bhHash(i + vec3(0.0, 1.0, 1.0)), bhHash(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

float bhFbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * bhNoise(p);
    p = p * 2.03 + vec3(11.3, 7.7, 3.1);
    amp *= 0.5;
  }
  return sum / 0.9375;
}
`;
