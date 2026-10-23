/**
 * Background starfield.
 *
 * One Points object, three shells of differing radius, seeded so the layout is
 * identical on every mount. Depth is real: the camera orbits inside the near
 * shell, so moving it produces parallax between the layers instead of a flat
 * backdrop sliding past.
 *
 * Deliberately sparse and dim — the disk has to stay the brightest thing in the
 * frame. Points render additively with depth testing on, so the black-hole
 * sphere occludes the stars behind it without any extra work.
 */

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';

const SHELLS = [
  { count: 680, inner: 13, outer: 30, size: [1.15, 2.4], brightness: 1.0 },
  { count: 1900, inner: 30, outer: 72, size: [0.9, 1.85], brightness: 0.78 },
  { count: 2500, inner: 72, outer: 165, size: [0.7, 1.4], brightness: 0.55 },
];

const vertexShader = /* glsl */ `
attribute float aSize;
attribute float aWarmth;
attribute float aPhase;

uniform float uTime;
uniform float uPixelRatio;
uniform float uScale;
uniform float uDim;

varying float vAlpha;
varying float vWarmth;

void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-view.z, 0.001);

  // Parallax-correct size: nearer stars are allowed to be larger, but the
  // exponent above 1 keeps the nearest layer from looking like dust on the lens.
  float size = aSize * uScale / pow(dist, 1.08);
  gl_PointSize = clamp(size * uPixelRatio, 0.7, 7.0);

  float twinkle = 0.82 + 0.18 * sin(uTime * 0.7 + aPhase * 6.28318530718);
  vAlpha = twinkle * smoothstep(0.6, 3.2, dist) * uDim;
  vWarmth = aWarmth;

  gl_Position = projectionMatrix * view;
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

varying float vAlpha;
varying float vWarmth;

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p);
  if (r > 0.5) discard;
  // Soft core with a compact halo: reads as a point of light rather than a disc.
  float core = smoothstep(0.5, 0.06, r);
  float glow = pow(core, 2.4);
  vec3 cool = vec3(0.70, 0.80, 1.0);
  vec3 warm = vec3(1.0, 0.86, 0.70);
  vec3 color = mix(cool, warm, vWarmth);
  float alpha = (core * 0.55 + glow * 0.9) * vAlpha;
  gl_FragColor = vec4(color * (0.55 + 0.65 * glow), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createStarfield() {
  const positions = [];
  const sizes = [];
  const warms = [];
  const phases = [];
  const rand = mulberry32(0x9e3779b9);

  for (const shell of SHELLS) {
    for (let i = 0; i < shell.count; i++) {
      // Uniform on the sphere, then a radius that biases outward slightly: a
      // shell has no visible edge if more of it sits away from the camera.
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      const radial = Math.pow(rand(), 0.62);
      const r = shell.inner + (shell.outer - shell.inner) * radial;
      positions.push(Math.cos(a) * s * r, z * r, Math.sin(a) * s * r);
      sizes.push(shell.size[0] + rand() * (shell.size[1] - shell.size[0]));
      // Most stars sit near white; a minority lean warm or cool.
      const roll = rand();
      warms.push(roll > 0.86 ? 0.65 + rand() * 0.35 : roll < 0.16 ? -0.35 : 0.0);
      phases.push(rand());
      sizes[sizes.length - 1] *= shell.brightness;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aSize', new BufferAttribute(new Float32Array(sizes), 1));
  geometry.setAttribute('aWarmth', new BufferAttribute(new Float32Array(warms), 1));
  geometry.setAttribute('aPhase', new BufferAttribute(new Float32Array(phases), 1));
  geometry.computeBoundingSphere();

  const uniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uScale: { value: 46 },
    // Phase 4 dims the sky rather than deleting it when the cluster takes over:
    // removing it entirely makes the cluster look pasted onto flat black.
    uDim: { value: 1 },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  });
  const object = new Points(geometry, material);
  object.name = 'bh-starfield';
  object.frustumCulled = false;
  object.renderOrder = -1;

  return {
    object,
    count: positions.length / 3,
    setPixelRatio(ratio) {
      uniforms.uPixelRatio.value = ratio;
    },
    /**
     * 0 hides the field entirely. Phase 5's imaging pass supplies its own sky,
     * sampled along the deflected ray direction, so this one has to be able to
     * reach zero or it paints a second, unlensed star layer on top.
     */
    setDim(value) {
      const v = Number(value);
      uniforms.uDim.value = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
      object.visible = uniforms.uDim.value > 0.004;
    },
    update(time, dt) {
      uniforms.uTime.value = time;
      // A very slow drift of the whole sky. Too slow to read as rotation, but
      // it stops long sessions from looking like a still frame.
      object.rotation.y += dt * 0.006;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Small deterministic PRNG so the sky is stable across mounts and reloads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
