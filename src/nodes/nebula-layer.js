/**
 * One particle volume per genre, all of them in a single THREE.Points.
 *
 * The sky is a shared buffer: every particle carries its genre index, tint,
 * size, alpha and a seed. Hover and selection are uniforms, so interaction
 * never rebuilds geometry, never touches React state and never loops over the
 * buffer on the CPU. Picking runs against a padded sphere per volume — a cheap
 * analytic ray test — instead of the particles themselves, which keeps hover
 * constant-time no matter how many dust motes are on screen.
 *
 * Particle positions are generated from the layout seed only. The tiny drift in
 * the vertex shader is the only animation; positions are never regenerated.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { hash32, mulberry32 } from '../radio/random.js';

/** Sprite sizes are authored in pixels at this reference distance. */
const REFERENCE_DISTANCE = 100;
const REFERENCE_VIEWPORT = 720;
/** Ray test padding: a plus shape of dust reads as the nebula, so the proxy
 * volume is a little larger than the particle body. Published because the
 * tests check picking against an independent implementation. */
export const NEBULA_PICK_PADDING = 1.16;
/** Upper clamp for a single sprite, so dust never becomes a blob. */
export const NEBULA_MAX_POINT_PX = 24;
/** Default total budget across all volumes. */
export const NEBULA_PARTICLE_BUDGET = 34000;
const MIN_PER_VOLUME = 620;
const MAX_PER_VOLUME = 3000;
const STAR_RATIO = 0.024;
/** Share of the budget spent on broad, very faint "gas" sprites. */
const GAS_RATIO = 0.36;
const TILT_SCRATCH = [0, 0, 0];

const vertexShader = /* glsl */ `
  attribute vec3 aTint;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aSeed;
  attribute float aNebula;
  attribute float aStar;

  uniform float uTime;
  uniform float uScale;
  uniform float uPixelRatio;
  uniform float uAmount;
  uniform float uHover;
  uniform float uHoverStrength;
  uniform float uSelected;

  varying vec3 vTint;
  varying float vAlpha;
  varying float vStar;
  varying float vSeed;
  varying float vFluff;

  void main() {
    vec3 drift = vec3(
      sin(uTime * 0.11 + aSeed * 6.2832),
      cos(uTime * 0.09 + aSeed * 9.4248),
      sin(uTime * 0.13 + aSeed * 12.5664)
    );
    vec3 local = position + drift * aSize * 0.45;

    vec4 mv = modelViewMatrix * vec4(local, 1.0);
    float distance = max(-mv.z, 0.001);

    float isHover = step(abs(aNebula - uHover), 0.5) * uHoverStrength;
    float isSelected = step(abs(aNebula - uSelected), 0.5);
    float emphasis = max(isHover, isSelected * 0.85);
    // While one volume is hovered the rest recede a little, but they never go
    // dark: the sky keeps its structure.
    float dim = 1.0 - 0.24 * uHoverStrength * (1.0 - isHover);
    float nearFade = smoothstep(1.5, 8.0, distance);

    gl_PointSize = clamp(
      aSize * (1.0 + 0.12 * emphasis) * uPixelRatio * uScale / distance,
      0.8,
      ${NEBULA_MAX_POINT_PX}.0
    );

    vAlpha = aAlpha * uAmount * dim * nearFade * (1.0 + 0.8 * emphasis);
    vTint = aTint * (1.0 + 0.22 * emphasis);
    vStar = aStar;
    vSeed = aSeed;
    // Big sprites are the gas haze: they need a broad, edge-free profile.
    vFluff = smoothstep(0.55, 1.7, aSize);

    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vTint;
  varying float vAlpha;
  varying float vStar;
  varying float vSeed;
  varying float vFluff;

  void main() {
    if (vAlpha <= 0.002) discard;
    vec2 point = gl_PointCoord - 0.5;
    float d = length(point) * 2.0;
    if (d > 1.0) discard;

    float angle = atan(point.y, point.x);
    float rim = 1.0 + 0.18 * sin(vSeed * 41.0 + angle * 3.0);
    if (d > rim) discard;

    float soft = pow(1.0 - d, 1.8);
    float core = pow(1.0 - d, 5.5);
    float grain = mix(soft, core, clamp(vStar, 0.0, 1.0) * 0.85);
    // A wide plateau with no bright rim is what makes a sprite read as mist
    // rather than as a painted dot.
    // A gaussian has no rim to catch the eye: at the sprite edge it is already
    // three percent, so overlapping sprites read as one volume of mist.
    float haze = exp(-d * d * 3.2) * smoothstep(1.0, 0.9, d);
    float profile = mix(grain, haze, vFluff);
    float alpha = profile * vAlpha;

    gl_FragColor = vec4(vTint, alpha);
  }
`;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value) {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

/**
 * Split the particle budget across volumes.
 *
 * Population influences particle count, but only through a square root and
 * inside a floor and a cap: a genre with one station still gets a real cloud,
 * and the busiest genre cannot take the whole buffer.
 */
export function allocateParticles(genres, budget = NEBULA_PARTICLE_BUDGET) {
  const list = Array.isArray(genres) ? genres : [];
  if (!list.length) return [];
  const maxCount = list.reduce((top, genre) => Math.max(top, genre.count || 0), 1);
  const total = Math.max(MIN_PER_VOLUME * list.length, Math.round(budget));
  const weights = list.map((genre) => 0.6 + 0.4 * Math.sqrt((genre.count || 0) / Math.max(1, maxCount)));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  const counts = weights.map((weight) => {
    const share = weight / weightSum;
    return clamp(Math.round(total * share), MIN_PER_VOLUME, MAX_PER_VOLUME);
  });

  // Rebalance after clamping so the whole buffer is used, without pushing any
  // volume below its floor.
  let sum = counts.reduce((acc, value) => acc + value, 0);
  let guard = 0;
  while (sum !== total && guard < 8) {
    guard += 1;
    const step = sum > total ? -1 : 1;
    const order = counts
      .map((value, index) => ({ index, value }))
      .sort((a, b) => (step > 0 ? a.value - b.value : b.value - a.value));
    for (const entry of order) {
      if (sum === total) break;
      const next = counts[entry.index] + step;
      if (next < MIN_PER_VOLUME || next > MAX_PER_VOLUME) continue;
      counts[entry.index] = next;
      sum += step;
    }
  }
  return counts;
}

function makeLobes(shape, rng) {
  const lobes = [];
  for (let i = 0; i < shape.lobes; i += 1) {
    const angle = shape.spin + (i / shape.lobes) * Math.PI * 2 + rng() * 0.5;
    lobes.push({
      x: Math.cos(angle) * shape.lobeSpread,
      y: (rng() * 2 - 1) * 0.34,
      z: Math.sin(angle) * shape.lobeSpread,
    });
  }
  return lobes;
}

/**
 * Sample one local offset inside a volume.
 *
 * Two populations share the same field: a concentrated core (lobed, brighter,
 * denser) and a broader halo that fades into the dust. The radial warp and the
 * density rejection are what keep the silhouette irregular; a plain sphere
 * would read as a ball no matter how the colour is tuned.
 */
function rotateLocal(shape, x, y, z, out) {
  const tilt = shape.tilt || { x: 0, y: 0, z: 0 };
  const cx = Math.cos(tilt.x);
  const sx = Math.sin(tilt.x);
  const cy = Math.cos(tilt.y);
  const sy = Math.sin(tilt.y);
  const cz = Math.cos(tilt.z);
  const sz = Math.sin(tilt.z);
  // X, then Y, then Z: any fixed order works, the angles are seeded.
  let ax = x;
  let ay = y * cx - z * sx;
  let az = y * sx + z * cx;
  let bx = ax * cy + az * sy;
  let bz = -ax * sy + az * cy;
  let cx2 = bx * cz - ay * sz;
  let cy2 = bx * sz + ay * cz;
  out[0] = cx2;
  out[1] = cy2;
  out[2] = bz;
  return out;
}

function sampleLocal(volume, shape, lobes, rng) {
  const radius = volume.radius;
  const isCore = rng() < 0.58;
  let q = isCore
    ? 0.66 * Math.pow(rng(), 1.35)
    : 0.34 + 0.92 * Math.pow(rng(), 0.82);

  // Uniform direction on the unit sphere.
  const z = rng() * 2 - 1;
  const phi = rng() * Math.PI * 2;
  const ring = Math.sqrt(Math.max(0, 1 - z * z));
  let x = Math.cos(phi) * ring;
  let y = z;
  let zz = Math.sin(phi) * ring;

  const stretch = shape.stretch;
  x *= stretch[0];
  y *= stretch[1];
  zz *= stretch[2];

  if (isCore && lobes.length) {
    const lobe = lobes[Math.floor(rng() * lobes.length) % lobes.length];
    const pull = 0.42 * (1 - q * 0.8);
    x += (lobe.x - x) * pull;
    y += (lobe.y - y) * pull;
    zz += (lobe.z - zz) * pull;
  }

  const warp = 1 + shape.warp * Math.sin(3.1 * phi + shape.phase) * Math.cos(2.2 * z * Math.PI + shape.phase * 1.7);
  x *= warp;
  y *= warp;
  zz *= warp;

  const local = {
    x: x * radius,
    y: y * radius,
    z: zz * radius,
    q,
  };

  // Negative-space field: carve a few dim voids through the outer dust so the
  // halo does not read as a perfect sphere.
  if (q > 0.5) {
    const field = 0.5 + 0.5 *
      Math.sin(local.x / radius * 2.7 + shape.phase) *
      Math.sin(local.z / radius * 3.1 + shape.phase * 0.7) *
      Math.sin(local.y / radius * 2.3 + shape.phase * 1.3);
    local.reject = field < shape.hollow * 0.55;
  } else {
    local.reject = false;
  }
  return local;
}

function tintFor(volume, q, isStar, rng) {
  const base = volume.color;
  const core = clamp01(1 - q * 1.1);
  if (isStar) {
    const mix = 0.62 + rng() * 0.2;
    return [
      base[0] + (1.0 - base[0]) * mix,
      base[1] + (0.98 - base[1]) * mix,
      base[2] + (0.95 - base[2]) * mix,
    ];
  }
  const lift = 0.5 + 0.62 * core;
  return [
    clamp01(base[0] * lift + 0.03 * core),
    clamp01(base[1] * lift + 0.03 * core),
    clamp01(base[2] * lift + 0.04 * core),
  ];
}

/**
 * Build the shared particle buffers for a layout.
 *
 * Pure apart from the three.js import: the caller gets typed arrays back, which
 * makes the generator testable in Node and keeps the geometry construction in
 * one place.
 */
export function generateNebulaParticles(layout, options = {}) {
  const volumes = (layout && layout.genres) || [];
  const budget = Number.isFinite(Number(options.particleBudget))
    ? Number(options.particleBudget)
    : NEBULA_PARTICLE_BUDGET;
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : layout.seed || 0;

  if (!volumes.length) {
    return {
      count: 0,
      positions: new Float32Array(0),
      tints: new Float32Array(0),
      sizes: new Float32Array(0),
      alphas: new Float32Array(0),
      seeds: new Float32Array(0),
      nebulaIds: new Float32Array(0),
      stars: new Float32Array(0),
      perNebula: [],
      starsPerNebula: [],
      gasPerNebula: [],
      dustPerNebula: [],
    };
  }

  const allocation = allocateParticles(volumes, budget);
  const total = allocation.reduce((sum, value) => sum + value, 0);

  const positions = new Float32Array(total * 3);
  const tints = new Float32Array(total * 3);
  const sizes = new Float32Array(total);
  const alphas = new Float32Array(total);
  const seeds = new Float32Array(total);
  const nebulaIds = new Float32Array(total);
  const stars = new Float32Array(total);
  const perNebula = [];
  const starsPerNebula = [];
  const gasPerNebula = [];
  const dustPerNebula = [];

  let cursor = 0;
  const sizeFactorOf = (radius) => Math.pow(radius / 4.4, 0.3);
  const sizeScale = (px) => (px * REFERENCE_DISTANCE) / (REFERENCE_VIEWPORT / 2 / Math.tan((21 * Math.PI) / 180));

  volumes.forEach((volume, volumeIndex) => {
    const rng = mulberry32(hash32(seed, 'nebula-particles', volume.id));
    const shape = volume.shape;
    const lobes = makeLobes(shape, rng);
    const wanted = allocation[volumeIndex];
    const starCount = Math.max(6, Math.round(wanted * STAR_RATIO));
    const gasCount = Math.round(wanted * GAS_RATIO);
    const sizeFactor = Math.pow(volume.radius / 4.4, 0.3);
    const bell = () => (rng() + rng() + rng() - 1.5) * 0.62;
    const limit = wanted * 6;
    let made = 0;
    let attempts = 0;
    let gasMade = 0;
    let dustMade = 0;

    while (made < wanted && attempts < limit) {
      attempts += 1;
      const role = made < starCount ? 'star' : made < starCount + gasCount ? 'gas' : 'dust';
      let x;
      let y;
      let z;
      let q;
      let coreBoost = 1;

      if (role === 'star') {
        const starZ = rng() * 2 - 1;
        const starPhi = rng() * Math.PI * 2;
        const ring = Math.sqrt(Math.max(0, 1 - starZ * starZ));
        q = Math.pow(rng(), 1.7) * 0.85;
        const rr = q * volume.radius;
        x = Math.cos(starPhi) * ring * rr * shape.stretch[0];
        y = starZ * rr * shape.stretch[1];
        z = Math.sin(starPhi) * ring * rr * shape.stretch[2];
      } else if (role === 'gas') {
        // Gas rides the same lobes as the dust, so the haze thickens where the
        // grains already are instead of forming an independent balloon. A
        // minority is spread uniformly to keep the outer veil continuous.
        const lobe = lobes[Math.floor(rng() * lobes.length) % lobes.length];
        const spread = 0.48 + rng() * 0.52;
        // A fifth of the haze sits in the core: that dense pocket is what
        // makes a volume look lit from inside rather than evenly dusty.
        const coreHaze = rng() < 0.2;
        const haze = !coreHaze && rng() < 0.1;
        q = coreHaze ? 0.06 + rng() * 0.3 : haze ? 0.3 + rng() * 0.8 : 0.34 + rng() * 0.62;
        if (coreHaze) coreBoost = 1.45;
        const rr = q * volume.radius;
        const satellite = !haze && rng() < 0.22;
        const reach = satellite ? 1.12 + rng() * 0.28 : spread;
        const gx = haze ? rng() * 2 - 1 : lobe.x * reach + bell();
        const gy = haze ? rng() * 2 - 1 : lobe.y * reach + bell();
        const gz = haze ? rng() * 2 - 1 : lobe.z * reach + bell();
        const len = Math.hypot(gx, gy, gz) || 1;
        const warp = 1 + shape.warp * Math.sin(3.1 * Math.atan2(gz, gx) + shape.phase);
        x = (gx / len) * rr * warp * shape.stretch[0];
        y = (gy / len) * rr * warp * shape.stretch[1];
        z = (gz / len) * rr * warp * shape.stretch[2];
      } else {
        const local = sampleLocal(volume, shape, lobes, rng);
        if (local.reject) continue;
        q = local.q;
        x = local.x;
        y = local.y;
        z = local.z;
      }

      const at = cursor * 3;
      const tint = tintFor(volume, q, role === 'star', rng);
      tints[at] = tint[0];
      tints[at + 1] = tint[1];
      tints[at + 2] = tint[2];

      let px;
      let alpha;
      if (role === 'star') {
        px = 1.5 + rng() * 1.7;
        alpha = 0.5 + rng() * 0.32;
      } else if (role === 'gas') {
        // The veil: wide, faint, and additive, so overlapping sprites build the
        // diffuse body without any single sprite reading as a dot.
        // Two haze scales: a broad, almost invisible veil that carries the
        // silhouette, and a tighter one that gives the body its texture.
        // Three haze scales: a handful of very wide, nearly invisible glows
        // that give the body its bloom, a mid veil for the silhouette, and a
        // tight haze for texture.
        const glow = rng() < 0.07;
        const veil = !glow && rng() < 0.14;
        px = glow ? 18.0 + rng() * 12.0 : veil ? 9.0 + rng() * 7.0 : 4.4 + rng() * 4.6;
        alpha = glow
          ? 0.014 + rng() * 0.016
          : veil
            ? 0.022 + rng() * 0.026
            : (0.05 + rng() * 0.06) * coreBoost;
        gasMade += 1;
      } else {
        // Dust grain stays at one to three screen pixels: it is the texture
        // inside the haze, not a second population of soft balls.
        px = 0.7 + rng() * 1.0;
        alpha = 0.026 + rng() * 0.034;
        dustMade += 1;
      }

      // The whole cloud is oriented at generation time, not in the shader:
      // rotation costs nothing after upload, and the buffers stay reproducible.
      const tilted = rotateLocal(shape, x, y, z, TILT_SCRATCH);
      positions[at] = volume.center.x + tilted[0];
      positions[at + 1] = volume.center.y + tilted[1];
      positions[at + 2] = volume.center.z + tilted[2];

      sizes[cursor] = sizeScale(px * sizeFactor);
      alphas[cursor] = alpha;
      seeds[cursor] = rng();
      nebulaIds[cursor] = volumeIndex;
      stars[cursor] = role === 'star' ? 1 : 0;
      cursor += 1;
      made += 1;
    }

    perNebula.push(made);
    starsPerNebula.push(Math.min(starCount, made));
    gasPerNebula.push(gasMade);
    dustPerNebula.push(dustMade);
  });

  return {
    count: cursor,
    positions: positions.slice(0, cursor * 3),
    tints: tints.slice(0, cursor * 3),
    sizes: sizes.slice(0, cursor),
    alphas: alphas.slice(0, cursor),
    seeds: seeds.slice(0, cursor),
    nebulaIds: nebulaIds.slice(0, cursor),
    stars: stars.slice(0, cursor),
    perNebula,
    starsPerNebula,
    gasPerNebula,
    dustPerNebula,
  };
}

/**
 * A padded sphere test shared by picking and by the label occlusion check.
 * Padding well over 1 keeps the target generous: a plus shape of dust reads as
 * the nebula, and nobody expects to hit an exact particle.
 */
function raySphere(camera, ndcX, ndcY, coordinates, out, raycaster, vector) {
  vector.set(ndcX, ndcY);
  raycaster.setFromCamera(vector, camera);
  const origin = raycaster.ray.origin;
  const direction = raycaster.ray.direction;
  const ox = origin.x - coordinates.x;
  const oy = origin.y - coordinates.y;
  const oz = origin.z - coordinates.z;
  const tca = ox * direction.x + oy * direction.y + oz * direction.z;
  const distance2 = ox * ox + oy * oy + oz * oz;
  const h2 = coordinates.radius * coordinates.radius - (distance2 - tca * tca);
  if (h2 < 0) return null;
  const root = Math.sqrt(h2);
  const near = -tca - root;
  const far = -tca + root;
  out.near = near;
  out.far = far;
  // How far the ray passes from the centre, in world units. Picking uses the
  // ratio of this to the radius, so each volume owns the pixels closest to its
  // own core even when a bigger volume's disc overlaps it on screen.
  out.offset = Math.sqrt(Math.max(0, distance2 - tca * tca));
  out.radius = coordinates.radius;
  return far > 0 ? out : null;
}

export function createNebulaLayer(layout, options = {}) {
  const data = generateNebulaParticles(layout, options);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('aTint', new BufferAttribute(data.tints, 3));
  geometry.setAttribute('aSize', new BufferAttribute(data.sizes, 1));
  geometry.setAttribute('aAlpha', new BufferAttribute(data.alphas, 1));
  geometry.setAttribute('aSeed', new BufferAttribute(data.seeds, 1));
  geometry.setAttribute('aNebula', new BufferAttribute(data.nebulaIds, 1));
  geometry.setAttribute('aStar', new BufferAttribute(data.stars, 1));
  geometry.computeBoundingSphere();

  const material = new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: REFERENCE_VIEWPORT / 2 / Math.tan((21 * Math.PI) / 180) },
      uPixelRatio: { value: Number(options.pixelRatio) || 1 },
      uAmount: { value: Number(options.amount) || 0 },
      uHover: { value: -1 },
      uHoverStrength: { value: 0 },
      uSelected: { value: -1 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  });

  const object = new Points(geometry, material);
  object.name = 'nebula-volumes';
  object.frustumCulled = false;
  // The additive pass is drawn after the opaque disk: it must never be hidden
  // by the depth buffer, and the order keeps the glow stable frame to frame.
  object.renderOrder = 4;

  const raycaster = new RaycasterShim();
  const ndc = new Vector2();
  const scratch = { near: 0, far: 0 };
  const marker = new Vector3();
  let hoverIndex = -1;
  let hoverStrength = 0;
  let selectedIndex = -1;
  let amount = clamp01(options.amount);
  let time = 0;
  let pixelRatio = Number(options.pixelRatio) || 1;
  let viewportHeight = REFERENCE_VIEWPORT;
  let inertial = 0;

  function syncUniforms() {
    material.uniforms.uHover.value = hoverIndex;
    material.uniforms.uHoverStrength.value = hoverStrength;
    material.uniforms.uSelected.value = selectedIndex;
    material.uniforms.uAmount.value = amount;
    material.uniforms.uPixelRatio.value = pixelRatio;
  }
  syncUniforms();

  /** Which volume sits under this normalised device coordinate, cheapest first. */
  function pick(camera, ndcX, ndcY) {
    if (!camera || !layout.genres.length) return null;
    let best = null;
    for (const volume of layout.genres) {
      const hit = raySphere(camera, ndcX, ndcY, {
        x: volume.center.x,
        y: volume.center.y,
        z: volume.center.z,
        radius: volume.radius * NEBULA_PICK_PADDING,
      }, scratch, raycaster, ndc);
      if (!hit) continue;
      // Ownership, not plain depth: the volume whose centre the ray passes
      // closest to (relative to its own radius) wins. Nearest-only would make a
      // small volume sitting inside a large volume's disc impossible to hover,
      // and a nebula you can see but never select is a bug, not depth.
      const score = hit.offset / hit.radius;
      if (!best || score < best.score - 1e-6 || (Math.abs(score - best.score) <= 1e-6 && hit.near < best.near)) {
        best = { index: volume.index, id: volume.id, near: hit.near, far: hit.far, score };
      }
    }
    return best;
  }

  /** Screen radius in CSS pixels, used to place and size the label ring. */
  function radiusPx(index, camera, viewport) {
    const volume = layout.genres[index];
    if (!volume || !camera) return 0;
    const height = Number(viewport) || viewportHeight;
    marker.set(volume.center.x, volume.center.y, volume.center.z);
    const distance = camera.position.distanceTo(marker);
    const scale = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
    // A few pixels of slack: the ring should sit on the haze, not inside it.
    return (volume.radius * scale) / Math.max(1e-3, distance) + 7;
  }

  function setHover(index, strength = 1) {
    const next = Number.isInteger(index) && index >= 0 ? index : -1;
    if (next !== hoverIndex) hoverIndex = next;
    inertial = strength;
    material.uniforms.uHover.value = hoverIndex;
    material.uniforms.uHoverStrength.value = hoverStrength;
  }

  function setSelected(index) {
    const next = Number.isInteger(index) && index >= 0 ? index : -1;
    if (next === selectedIndex) return;
    selectedIndex = next;
    material.uniforms.uSelected.value = selectedIndex;
  }

  function setAmount(value) {
    amount = clamp01(value);
    material.uniforms.uAmount.value = amount;
  }

  function setPixelRatio(value) {
    pixelRatio = Math.max(0.5, Number(value) || 1);
    material.uniforms.uPixelRatio.value = pixelRatio;
  }

  function setViewport(width, height, fov = 42) {
    viewportHeight = Math.max(1, Number(height) || viewportHeight);
    const half = (Number(fov) || 42) * Math.PI / 360;
    material.uniforms.uScale.value = viewportHeight / 2 / Math.tan(half);
  }

  function update(dt, opts = {}) {
    const step = Math.max(0, Math.min(0.1, Number(dt) || 0));
    if (!opts.paused) time += step;
    material.uniforms.uTime.value = time;
    const target = hoverIndex >= 0 ? clamp01(inertial) : 0;
    const ease = opts.instant ? 1 : Math.min(1, step * 14);
    if (Math.abs(target - hoverStrength) > 0.0005) {
      hoverStrength += (target - hoverStrength) * ease;
      material.uniforms.uHoverStrength.value = hoverStrength;
    } else if (hoverStrength !== target) {
      hoverStrength = target;
      material.uniforms.uHoverStrength.value = hoverStrength;
    }
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    if (object.parent) object.parent.remove(object);
  }

  return {
    object,
    particleCount: data.count,
    perNebula: data.perNebula,
    starsPerNebula: data.starsPerNebula,
    layout,
    pick,
    radiusPx,
    setHover,
    setSelected,
    setAmount,
    setPixelRatio,
    setViewport,
    update,
    dispose,
    get hoverIndex() { return hoverIndex; },
    get selectedIndex() { return selectedIndex; },
    get amount() { return amount; },
    get time() { return time; },
    get isEmphasised() { return hoverIndex >= 0 || selectedIndex >= 0; },
  };
}

/**
 * Thin Raycaster wrapper. Importing three's Raycaster is fine, but keeping the
 * call site explicit makes it obvious that picking never touches the geometry.
 */
class RaycasterShim {
  constructor() {
    this.ray = { origin: new Vector3(), direction: new Vector3() };
  }

  setFromCamera(coords, camera) {
    const origin = this.ray.origin;
    const direction = this.ray.direction;
    origin.setFromMatrixPosition(camera.matrixWorld);
    // Build the ray from the camera basis instead of allocating a Raycaster per
    // call: same result, no per-frame garbage.
    const e = camera.matrixWorld.elements;
    const fov = (camera.fov * Math.PI) / 360;
    const tan = Math.tan(fov);
    const aspect = camera.aspect || 1;
    const x = coords.x * tan * aspect;
    const y = coords.y * tan;
    direction
      .set(
        e[0] * x + e[4] * y - e[8],
        e[1] * x + e[5] * y - e[9],
        e[2] * x + e[6] * y - e[10],
      )
      .normalize();
  }
}

export default createNebulaLayer;
