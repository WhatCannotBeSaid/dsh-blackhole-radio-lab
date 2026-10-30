/**
 * The station layer: the disk's own microstructure — and, in phase 4, the same
 * stations reorganised into a true 3-D star cluster.
 *
 * In the disk, every station contributes a handful of micro-sprites, and those
 * sprites are modulated by the *same* shear/density field the accretion disk
 * renders with. A station therefore brightens where the disk is already bright
 * and fades where it is thin, which is what makes the nodes read as local
 * structure of the matter band instead of a second object placed on top of it.
 *
 * In the cluster, the same sprites travel along a continuous path — a swirl
 * around the origin, then an inward/outward settling onto their seeded
 * destination — and their appearance changes with them: round soft points,
 * brighter and larger toward the dense core, no disk band, no hole mask. One
 * buffer, one material, one draw call for the whole catalogue in both modes.
 *
 * Layout and animation are deliberately separated:
 *   - disk positions are authored once, in cylindrical coordinates;
 *   - cluster positions are authored once per category (src/cluster/layout.js);
 *   - neither mode ever rewrites the other's layout. Transitions ease the
 *     presentation toward the other destination and reverse from wherever they
 *     currently are, so an interrupted transition can never leave a station
 *     assigned to the wrong place.
 *
 * The selection marker is the only Mesh here, exactly one, reused.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { categoryRgb } from '../radio/taxonomy.js';
import { centered, hash32, mulberry32 } from '../radio/random.js';
import { DISK_INNER, DISK_OUTER, CRITICAL_IMPACT_PARAMETER } from '../scene/dimensions.js';
import { STATION_RADIUS } from '../radio/distribution.js';
import { NOISE_GLSL } from '../scene/glsl.js';

const DISK_PARTICLES = 5;
const FEATURED_PARTICLES = 8;
const MAX_POINT_PX = 44;
/** How fast the cluster transition settles, per station-speed unit. */
const CLUSTER_RATE = 3.1;

const VERTEX_SHADER = /* glsl */ `
  ${NOISE_GLSL}

  attribute vec3 aTint;
  attribute float aSize;
  attribute float aBase;
  attribute float aSeed;
  attribute float aTier;
  attribute float aMatch;
  attribute float aStation;
  attribute float aPresence;
  attribute float aCluster;
  attribute float aMember;
  attribute float aVeil;
  // Favourite is a property of the station, not of the scene: it survives every
  // transition and drives colour temperature only (never size or a second ring).
  attribute float aFav;

  uniform float uPixelRatio;
  uniform float uScale;
  uniform float uLod;
  uniform float uTime;
  uniform float uSelected;
  uniform float uFilterActive;
  uniform float uInner;
  uniform float uOuter;
  uniform float uBandInner;
  uniform float uBandOuter;
  uniform float uClusterAmount;
  uniform float uClusterRadius;
  // 1 while the black-hole panel owns the frame: phase 5 hides the station
  // sprites so only the traced image is visible. The data model is untouched.
  uniform float uHoleOnly;
  // The station whose stream is live, or -1. One knob, read by the vertex pass
  // only: the heat source is the full brightening, the ring lives on the marker.
  uniform float uPlaying;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSelected;
  varying vec2 vNdc;
  varying float vSeed;
  varying float vAngle;
  varying float vCluster;
  // Heat 0 (outer, dark red) .. 1 (inner, white hot); favourite is a whisper of
  // both colour and stability, never an extra shape.
  varying float vHeat;
  varying float vFav;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mv.z, 0.001);

    float r = max(length(position.xz), 0.001);
    float ang = atan(position.z, position.x);
    float t = clamp((r - uInner) / (uOuter - uInner), 0.0, 1.0);

    // The disk's own physics, reused for the heat spots. Temperature falls
    // steeply outward, so the inner rim is white hot and the outer bands are a
    // dull red — the same gradient the traced image shows underneath.
    float heat = pow(1.0 - t, 2.4);

    // Relativistic beaming. The matter orbits with the disk, so the side moving
    // toward the camera is brighter and the receding side is darker and redder.
    // This is a lighting term, not a second colour: it multiplies the heat.
    vec3 radial = vec3(position.x, 0.0, position.z) / r;
    vec3 tangent = vec3(-radial.z, 0.0, radial.x);
    vec3 toEye = normalize(cameraPosition - position);
    float beta = 0.62 * clamp(uInner / r, 0.0, 1.0);
    float doppler = clamp(1.0 + beta * dot(tangent, toEye), 0.25, 1.85);
    vHeat = heat;
    vFav = aFav;

    // The accretion disk's shear field, reused verbatim. Sampling it here means
    // a node is invisible where the disk is dark and bright where it is hot.
    float omega = uTime * 0.40 * pow(uInner / r, 1.5);
    float shear = 2.1 * log(r / uInner);
    float phase = ang + omega - shear;
    vec2 dir = vec2(cos(phase), sin(phase));
    float n1 = bhFbm(vec3(dir * (1.9 + 2.2 * t), t * 5.5 + uTime * 0.05));
    float n2 = bhFbm(vec3(dir * (4.6 + 5.0 * t), t * 11.0 - uTime * 0.08) + n1 * 1.1);
    float detail = n1 * 0.62 + n2 * 0.38;
    float bands = 0.5 + 0.5 * sin(log(r) * 27.0 - uTime * 0.5 + n1 * 3.4);
    float dens = smoothstep(0.20, 0.68, detail + bands * 0.07);

    float cluster = clamp(aCluster, 0.0, 1.0);
    vCluster = cluster;

    // In the cluster the disk density field is irrelevant: every station is a
    // star of its own. Mixing it to 1.0 rather than switching branches keeps
    // the whole thing one shader and one draw call.
    float matter = mix(mix(0.40, 1.0, dens), 1.0, cluster);

    float near = 1.0 - smoothstep(5.5, 13.5, dist);
    float lodSize = mix(1.22, 0.60, clamp(uLod, 0.0, 1.0));
    float cloudGrow = 1.0 + 1.6 * aMatch * uFilterActive;
    // Close in, a single unit has to become readable as a knot: the sprite grows
    // with proximity instead of the camera being allowed to dive into the disk.
    float sizePx = aSize * lodSize * cloudGrow * mix(1.0, 1.5, near)
      * (1.0 + aTier * 0.45) * uPixelRatio * uScale / dist;
    sizePx *= mix(0.86, 1.16, matter);

    float clusterRad = clamp(length(position) / max(uClusterRadius, 0.001), 0.0, 1.0);
    float coreWeight = pow(1.0 - clusterRad, 1.35);
    // A cluster sprite is a compact star: small, round, and only slightly larger
    // in the core. The veil particle must NOT carry over its disk size,
    // otherwise the core becomes one clipped white disc. The core sprites are
    // deliberately not enlarged — size overlap is what turns a dense centre
    // into a featureless white blob.
    float clusterSize = aBase * mix(0.58, 0.74, coreWeight) * mix(1.0, 2.4, aVeil) * (1.0 + aTier * 0.5)
      * uPixelRatio * uScale / dist;
    sizePx = mix(sizePx, clusterSize, cluster);
    gl_PointSize = clamp(sizePx, 1.0, ${MAX_POINT_PX.toFixed(1)});

    gl_Position = projectionMatrix * mv;
    vNdc = gl_Position.xy / max(gl_Position.w, 0.0001);

    float selected = step(abs(aStation - uSelected), 0.5);
    vSelected = selected;

    float dim = mix(1.0, 0.13, uFilterActive * (1.0 - aMatch));
    // A revealed cloud is denser, not brighter: per-sprite energy goes DOWN while
    // the cluster packs more sprites per pixel. That is what keeps the cloud a
    // coloured nebula instead of a white clipped smear.
    float boost = mix(1.0, 0.90, aMatch * uFilterActive) * mix(1.0, 1.4, selected);
    float lodAlpha = mix(1.0, 0.72, clamp(uLod, 0.0, 1.0));
    // The field has to dissolve into the disk at both radial ends. A hard band
    // edge is what makes a station field read as its own ring rather than as
    // part of the matter.
    float bandFade = smoothstep(uBandInner - 0.08, uBandInner + 0.34, r)
      * (1.0 - smoothstep(uBandOuter - 0.62, uBandOuter + 0.06, r));
    // Featured stations keep their identity in the inner rim: a gentler fade.
    float tierFade = mix(bandFade, 0.94, aTier);
    // The disk fade must not apply once a station has left the disk: the mix
    // follows the same per-station cluster factor as the geometry.
    float diskFade = mix(tierFade, 1.0, cluster);

    // Not every station belongs to the chosen category. Those keep their disk
    // place and fade out as the scene becomes a cluster; they never duplicate.
    float memberFade = mix(1.0, aMember, uClusterAmount);
    // Per-sprite energy drops in the core on purpose: hundreds of additive
    // sprites overlap there, and the density must read as many stars, not as a
    // single over-exposed disc. The rim keeps enough light to stay findable.
    float energy = mix(0.52, 0.62 + 0.30 * coreWeight, cluster)
      * mix(1.0, 1.85, cluster * aVeil);
    // Tiny sprites are filtered out gradually in the disk, but a cluster star
    // must remain a findable speck even at the far rim.
    float sizeFade = mix(
      smoothstep(0.7, 2.4, sizePx),
      smoothstep(0.55, 1.6, clusterSize),
      cluster
    );

    // Cluster sprites are small, so their per-pixel coverage is low; a modest
    // gain keeps single stars readable without turning the core into a disc.
    float clusterGain = mix(1.0, 2.1, cluster);
    // Heat spots are lit by the disk they sit in: the doppler gain and the
    // radial heat both scale the energy, so a spot on the approaching side
    // outshines one on the receding side instead of every node glowing alike.
    float diskLight = mix(doppler * (0.70 + 0.64 * heat), 1.0, cluster);
    float live = step(abs(aStation - uPlaying), 0.5);
    float liveGain = mix(1.0, 1.42, live);
    vAlpha = aPresence * matter * dim * boost * lodAlpha * diskFade
      * sizeFade * energy * memberFade * clusterGain * diskLight * liveGain
      * (1.0 - uHoleOnly);

    // Black-body ladder: dull red at the outer edge, amber in the body, white
    // hot at the rim. A featured station does NOT grow — it shifts one step up
    // the temperature ladder, which is what tells it apart without breaking the
    // one-material read of the field.
    vec3 coldRed = vec3(1.0, 0.26, 0.06);
    vec3 ember = vec3(1.0, 0.55, 0.20);
    vec3 amber = vec3(1.0, 0.84, 0.60);
    vec3 whiteHot = vec3(1.0, 0.97, 0.92);
    vec3 hot = mix(coldRed, ember, smoothstep(0.0, 0.45, heat));
    hot = mix(hot, amber, smoothstep(0.30, 0.75, heat));
    hot = mix(hot, whiteHot, smoothstep(0.60, 1.0, heat));
    hot = mix(hot, whiteHot, aTier * 0.30);
    // A favourite runs warmer and steadier. The shift is small on purpose: a
    // shelf of favourites must still read as one band.
    hot = mix(hot, vec3(1.0, 0.78, 0.44), aFav * 0.42);
    // The receding side is redshifted; the approaching side keeps its heat
    // colour and takes the extra energy from diskLight above.
    hot = mix(hot, coldRed, clamp((1.0 - doppler) * 0.55, 0.0, 0.45));
    // Category colour stays a whisper, exactly as before: it speaks only while
    // its cloud is revealed.
    vec3 tinted = mix(hot, aTint, mix(0.04, 0.52, uFilterActive * aMatch));
    // Cluster: a nearly white star, a shade warm at the core and cool at the
    // rim. Category colour stays a whisper: a rainbow cluster would turn the
    // density gradient into a legend.
    vec3 clusterColor = mix(vec3(1.0, 0.72, 0.50), vec3(0.86, 0.92, 1.0), clusterRad);
    vec3 mixedColor = mix(tinted, mix(clusterColor, aTint, 0.08), cluster);
    vColor = mix(mixedColor, vec3(1.0, 0.97, 0.92), selected * 0.45);

    // The sprite's projected tangent, taken a hair off-centre so the elongation
    // follows the disk's shear direction.
    vec4 mvT = modelViewMatrix * vec4(position + tangent * 0.05, 1.0);
    vec4 clipT = projectionMatrix * mvT;
    vec2 s0 = gl_Position.xy / max(gl_Position.w, 1e-4);
    vec2 s1 = clipT.xy / max(clipT.w, 1e-4);
    vAngle = atan(s1.y - s0.y, s1.x - s0.x);
    vSeed = aSeed;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec2 uRes;
  uniform vec2 uHolePx;
  uniform float uHoleRadiusPx;
  uniform float uClusterAmount;
  uniform float uDim;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSelected;
  varying vec2 vNdc;
  varying float vSeed;
  varying float vAngle;
  varying float vCluster;
  varying float vHeat;
  varying float vFav;

  void main() {
    if (vAlpha <= 0.004) discard;
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p) * 2.0;
    if (d > 1.4) discard;

    // Elongate along the projected tangent in the disk: a band fragment, not a
    // dot. In the cluster the same sprite is a round star.
    float c = cos(vAngle);
    float s = sin(vAngle);
    vec2 q = vec2(p.x * c + p.y * s, -p.x * s + p.y * c);
    float along = q.x * 2.0;
    float across = q.y * 2.0 * 2.15;
    float eDisk = sqrt(along * along + across * across);
    // A slightly ragged edge keeps the sprites from looking like stamps.
    eDisk *= 1.0 + 0.10 * sin(vSeed * 31.0 + along * 6.0);
    float eStar = d * (1.0 + 0.05 * sin(vSeed * 23.0));
    float e = mix(eDisk, eStar, vCluster);
    if (e > 1.0) discard;

    vec2 screen = vec2((vNdc.x * 0.5 + 0.5) * uRes.x, (0.5 - vNdc.y * 0.5) * uRes.y);
    float holeDist = length(screen - uHolePx) / max(uHoleRadiusPx, 1.0);
    // The shadow's keep-out is a disk-mode rule; it must not carve a black dome
    // out of the cluster's core.
    float mask = mix(smoothstep(0.98, 1.3, holeDist), 1.0, uClusterAmount);

    float halo = pow(1.0 - e, 1.7);
    float core = pow(1.0 - e, 4.2);
    // A cluster star is tighter: most of its light sits in a small core, so
    // neighbouring sprites stay separate instead of stacking into a white disc.
    float starHalo = pow(1.0 - eStar, 2.4);
    float starCore = pow(1.0 - eStar, 7.0);
    float profile = mix(halo * 0.50 + core * 0.34, starHalo * 0.40 + starCore * 0.60, vCluster);
    vec3 color = vColor * (0.88 + 0.42 * core + vSelected * 0.15);
    float alpha = profile * vAlpha * mask * uDim;
    if (alpha <= 0.003) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

const MARKER_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const MARKER_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float d = length(p) * 2.0;
    float ring = smoothstep(0.05, 0.0, abs(d - 0.44)) * 0.85;
    float halo = pow(max(0.0, 1.0 - d), 3.0) * 0.22;
    float gap = smoothstep(0.1, 0.2, d);
    float alpha = (ring + halo) * uAlpha * gap;
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/** Fraction of a node's brightness the layer gives up at far LOD. */
export function lodVisibility(seed, tier, lod) {
  const keep = 1 + (0.3 - 1) * clamp01(lod);
  const t = clamp01((seed - keep) / 0.16);
  const drop = 1 - t * t * (3 - 2 * t);
  return tier > 0.5 ? 1 : drop;
}

export function createStationsLayer(stations, options) {
  const opts = options || {};
  const count = stations.length;
  const seed = opts.seed || 1;

  // Per-station state, in cylindrical coordinates (the disk's own frame).
  const baseR = new Float32Array(count);
  const baseA = new Float32Array(count);
  const baseY = new Float32Array(count);
  const curR = new Float32Array(count);
  const curA = new Float32Array(count);
  const curY = new Float32Array(count);
  const tgtR = new Float32Array(count);
  const tgtA = new Float32Array(count);
  const tgtY = new Float32Array(count);
  const matchCur = new Float32Array(count);
  const matchTgt = new Float32Array(count);
  const hold = new Float32Array(count);
  const speed = new Float32Array(count);
  const worldX = new Float32Array(count);
  const worldY = new Float32Array(count);
  const worldZ = new Float32Array(count);
  const nodeSize = new Float32Array(count);
  const stationCategories = new Array(count);
  const stationClouds = new Array(count);
  const presentation = new Float32Array(count);

  // Cluster state: a second destination per station, never a second object.
  const clusterX = new Float32Array(count);
  const clusterY = new Float32Array(count);
  const clusterZ = new Float32Array(count);
  const clusterBlend = new Float32Array(count);
  const clusterGoal = new Float32Array(count);
  const clusterHold = new Float32Array(count);
  const clusterMembers = new Uint8Array(count);
  const clusterSwirl = new Float32Array(count);
  let clusterRadius = 3;
  let knotScale = 0.03;

  // Current blend towards the cloud state. Declared before the build loop
  // because the initial buffer fill reads it (as a factor of zero).
  let filterActive = 0;
  let filterTarget = 0;

  let particleTotal = 0;
  const perStation = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const n = stations[i].isFeatured ? FEATURED_PARTICLES : DISK_PARTICLES;
    perStation[i] = n;
    particleTotal += n;
  }

  const positions = new Float32Array(particleTotal * 3);
  const tints = new Float32Array(particleTotal * 3);
  const sizes = new Float32Array(particleTotal);
  const bases = new Float32Array(particleTotal);
  const seeds = new Float32Array(particleTotal);
  const tiers = new Float32Array(particleTotal);
  const matches = new Float32Array(particleTotal);
  const stationIds = new Float32Array(particleTotal);
  const presences = new Float32Array(particleTotal);
  const clusterMix = new Float32Array(particleTotal);
  const memberFlags = new Float32Array(particleTotal);
  const veilFlags = new Float32Array(particleTotal);
  // Favourite, per sprite: one buffer so a store change is one upload, not a
  // material rebuild.
  const favouriteFlags = new Float32Array(particleTotal);
  /** Local offset per particle: tangent, radial, vertical. */
  const offsets = new Float32Array(particleTotal * 3);

  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const station = stations[i];
    const layout = station.metadata.layout || orbitOf(station.position);
    baseR[i] = layout.radius;
    baseA[i] = layout.angle;
    baseY[i] = layout.height;
    curR[i] = layout.radius;
    curA[i] = layout.angle;
    curY[i] = layout.height;
    tgtR[i] = layout.radius;
    tgtA[i] = layout.angle;
    tgtY[i] = layout.height;
    matchCur[i] = 1;
    matchTgt[i] = 1;
    presentation[i] = station.metadata.presence || 1;
    speed[i] = 0.82 + (hash32(seed, i, 'speed') % 1000) / 1000 * 0.55;
    // A stable swirl direction and amplitude: the path into the cluster is a
    // spiral, and each station turns a slightly different amount, which reads
    // as matter unwinding rather than every point sliding on a radius.
    clusterSwirl[i] =
      (((hash32(seed, i, 'swirl') % 1000) / 1000) * 0.9 + 0.35) *
      (hash32(seed, i, 'sdir') % 2 === 0 ? 1 : -1);
    stationCategories[i] = station.categories || [];
    stationClouds[i] = station.metadata.clouds || [];

    const featured = station.isFeatured === true;
    const rgb = categoryRgb(station.categories[0]);
    const baseSize = featured ? 0.118 : 0.068;
    const tangSigma = featured ? 0.032 : 0.075;
    const radSigma = featured ? 0.018 : 0.045;
    const vertSigma = featured ? 0.014 : 0.03;
    const rng = mulberry32(hash32(seed, i, 'sprite'));
    nodeSize[i] = baseSize;

    for (let k = 0; k < perStation[i]; k += 1) {
      // Particle 0 is the station's veil: a large, very dim sprite that bleeds
      // into its neighbours so a ring of stations reads as one luminous band
      // instead of a grain field. Particles 1..n are the visible structure.
      const veil = k === 0;
      offsets[cursor * 3] = veil ? 0 : centered(rng) * tangSigma;
      offsets[cursor * 3 + 1] = veil ? 0 : centered(rng) * radSigma;
      offsets[cursor * 3 + 2] = veil ? 0 : centered(rng) * vertSigma;
      const jitter = 0.75 + rng() * 0.5;
      sizes[cursor] = veil ? baseSize * (featured ? 3.8 : 5.4) : baseSize * jitter;
      // The cluster sprite has its own base size; the veil must not become a
      // 5× disc in the core.
      bases[cursor] = veil ? baseSize * 0.9 : baseSize * (featured ? 1.05 : 0.82) * jitter;
      tints[cursor * 3] = rgb[0];
      tints[cursor * 3 + 1] = rgb[1];
      tints[cursor * 3 + 2] = rgb[2];
      seeds[cursor] = (hash32(seed, i, k, 'seed') % 10000) / 10000;
      tiers[cursor] = featured ? 1 : 0;
      matches[cursor] = 1;
      stationIds[cursor] = i;
      veilFlags[cursor] = veil ? 1 : 0;
      presences[cursor] = veil
        ? presentation[i] * 0.19
        : presentation[i] * (0.85 + rng() * 0.3);
      writeParticle(cursor, i, 0);
      cursor += 1;
    }
  }
  writeStationAnchors(0, count);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aTint', new BufferAttribute(tints, 3));
  geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
  geometry.setAttribute('aBase', new BufferAttribute(bases, 1));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  geometry.setAttribute('aTier', new BufferAttribute(tiers, 1));
  geometry.setAttribute('aMatch', new BufferAttribute(matches, 1));
  geometry.setAttribute('aStation', new BufferAttribute(stationIds, 1));
  geometry.setAttribute('aPresence', new BufferAttribute(presences, 1));
  geometry.setAttribute('aCluster', new BufferAttribute(clusterMix, 1));
  geometry.setAttribute('aMember', new BufferAttribute(memberFlags, 1));
  geometry.setAttribute('aVeil', new BufferAttribute(veilFlags, 1));
  geometry.setAttribute('aFav', new BufferAttribute(favouriteFlags, 1));
  // The field is animated within a known band; culling per frame would only
  // cost a bounding-sphere recompute for one draw call.
  geometry.boundingSphere = null;

  const uniforms = {
    uPixelRatio: { value: opts.pixelRatio || 1 },
    uScale: { value: 1000 },
    uLod: { value: 0 },
    uTime: { value: 0 },
    uSelected: { value: -1 },
    uFilterActive: { value: 0 },
    uInner: { value: DISK_INNER },
    uOuter: { value: DISK_OUTER },
    uBandInner: { value: STATION_RADIUS.inner },
    uBandOuter: { value: STATION_RADIUS.outer },
    uRes: { value: [1, 1] },
    uHolePx: { value: [0, 0] },
    uHoleRadiusPx: { value: 1 },
    uClusterAmount: { value: 0 },
    uClusterRadius: { value: clusterRadius },
    uDim: { value: 1 },
    // Phase 5: 1 hides every catalogue sprite. The data behind them is untouched;
    // this is a visibility gate, not a data change.
    uHoleOnly: { value: 0 },
    uPlaying: { value: -1 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  });
  material.name = 'bhrl.stations';

  const points = new Points(geometry, material);
  points.name = 'bhrl.stations';
  points.frustumCulled = false;
  points.renderOrder = 4;

  const markerGeometry = new PlaneGeometry(1, 1);
  const markerMaterial = new ShaderMaterial({
    uniforms: {
      uColor: { value: [1.0, 0.72, 0.46] },
      uAlpha: { value: 0.0 },
    },
    vertexShader: MARKER_VERTEX,
    fragmentShader: MARKER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
  });
  markerMaterial.name = 'bhrl.station-marker';
  const marker = new Mesh(markerGeometry, markerMaterial);
  marker.name = 'bhrl.station-marker';
  marker.visible = false;
  marker.renderOrder = 5;
  marker.frustumCulled = false;

  let selectedIndex = -1;
  // Playback is a second, independent fact: a station can be selected without
  // being live (a search jump) and live without being selected (a click on the
  // disk selects it as well, but the panel may clear the selection later).
  let playingIndex = -1;
  let playingPaused = false;
  let lastMarkerOwner = -1;
  let lastMarkerLive = null;
  let markerClock = 0;
  let filterSet = null;
  let animating = false;
  let lod = 0;
  let time = 0;
  let disposed = false;
  let dirtyBuffers = false;
  // Bumped by flush(): anchors move on a filter reveal and during a transition
  // without the camera moving at all, so a screen-space cache cannot key on the
  // camera alone.
  let layoutVersion = 0;
  let clusterAmount = 0;
  const markerColor = [1.0, 0.72, 0.46];
  let holeOnly = 0;
  const filterClouds = [];
  let filteredCount = 0;
  const scratch = new Vector3();

  /** Smoothstep without allocating. */
  function smoothstep01(value) {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
  }

  /**
   * Write one micro-sprite's world position at the current disk/cluster blend.
   *
   * The disk half is the existing cylindrical anchor plus local offsets. The
   * cluster half is the seeded destination. The path between them is a swirl
   * around the origin that peaks mid-transition and is zero at both ends, so
   * the movement is continuous in speed as well as position — and reversing it
   * mid-flight simply runs the same curve backwards.
   */
  function writeParticle(particle, stationIndex, expand) {
    const r = curR[stationIndex];
    const a = curA[stationIndex];
    const diskScale = 1 + 0.55 * matchCur[stationIndex] * filterActive * expand;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const ax = offsets[particle * 3];
    const ar = offsets[particle * 3 + 1];
    const ay = offsets[particle * 3 + 2];

    const diskX = cos * r + (-sin * ax + cos * ar) * diskScale;
    const diskY = curY[stationIndex] + ay * (1 + 0.4 * matchCur[stationIndex] * filterActive);
    const diskZ = sin * r + (cos * ax + sin * ar) * diskScale;

    const blend = smoothstep01(clusterBlend[stationIndex]);
    if (blend <= 0.0001) {
      positions[particle * 3] = diskX;
      positions[particle * 3 + 1] = diskY;
      positions[particle * 3 + 2] = diskZ;
      return;
    }

    const turn = clusterSwirl[stationIndex] * Math.sin(Math.PI * blend);
    const cs = Math.cos(turn);
    const sn = Math.sin(turn);
    const spunX = diskX * cs - diskZ * sn;
    const spunZ = diskX * sn + diskZ * cs;

    // Keep a little local structure at the destination. A station is one star,
    // but its sprites are spread into a knot a few pixels wide: that is what
    // turns a sparse category into a grainy cluster instead of a single dot per
    // station, and it keeps the knot from flickering as the camera turns.
    const offLen = Math.sqrt(ax * ax + ar * ar + ay * ay);
    const knot = offLen > 1e-5 ? knotScale * (0.4 + 0.6 * seeds[particle]) : 0;
    const nx = offLen > 1e-5 ? (-sin * ax + cos * ar) / offLen : 0;
    const ny = offLen > 1e-5 ? ay / offLen : 0;
    const nz = offLen > 1e-5 ? (cos * ax + sin * ar) / offLen : 0;
    const clusterXW = clusterX[stationIndex] + nx * knot;
    const clusterYW = clusterY[stationIndex] + ny * knot;
    const clusterZW = clusterZ[stationIndex] + nz * knot;

    positions[particle * 3] = spunX + (clusterXW - spunX) * blend;
    positions[particle * 3 + 1] = diskY + (clusterYW - diskY) * blend;
    positions[particle * 3 + 2] = spunZ + (clusterZW - spunZ) * blend;
  }

  /** Station centre (no sprite offset), used for picking, labels and marker. */
  function writeStationAnchors(from, to) {
    for (let i = from; i < to; i += 1) {
      const a = curA[i];
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const diskX = cos * curR[i];
      const diskZ = sin * curR[i];
      const blend = smoothstep01(clusterBlend[i]);
      if (blend <= 0.0001) {
        worldX[i] = diskX;
        worldY[i] = curY[i];
        worldZ[i] = diskZ;
        continue;
      }
      const turn = clusterSwirl[i] * Math.sin(Math.PI * blend);
      const cs = Math.cos(turn);
      const sn = Math.sin(turn);
      const spunX = diskX * cs - diskZ * sn;
      const spunZ = diskX * sn + diskZ * cs;
      worldX[i] = spunX + (clusterX[i] - spunX) * blend;
      worldY[i] = curY[i] + (clusterY[i] - curY[i]) * blend;
      worldZ[i] = spunZ + (clusterZ[i] - spunZ) * blend;
    }
  }

  /** Upload the particle positions and the per-particle blend attributes. */
  function flush() {
    let particle = 0;
    for (let i = 0; i < count; i += 1) {
      const n = perStation[i];
      for (let k = 0; k < n; k += 1) writeParticle(particle + k, i, 1);
      particle += n;
    }
    geometry.attributes.position.needsUpdate = true;
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      const n = perStation[i];
      for (let k = 0; k < n; k += 1) {
        matches[p + k] = matchCur[i];
        clusterMix[p + k] = clusterBlend[i];
        memberFlags[p + k] = clusterMembers[i];
      }
      p += n;
    }
    geometry.attributes.aMatch.needsUpdate = true;
    geometry.attributes.aCluster.needsUpdate = true;
    geometry.attributes.aMember.needsUpdate = true;
    writeStationAnchors(0, count);
    dirtyBuffers = false;
    layoutVersion += 1;
    syncMarker();
  }

  function placeMarker(index) {
    marker.position.set(worldX[index], worldY[index], worldZ[index]);
  }

  /**
   * Which station the ring belongs to.
   *
   * In the disk the ring is the transport indicator and nothing else: it marks
   * the station that is actually playing, so "selected but silent" never draws
   * one. A cluster is a browse space where a click means "show me this one", so
   * there the ring keeps following the selection, exactly as it always has.
   */
  function markerOwner() {
    if (clusterAmount > 0.55) return selectedIndex;
    return playingIndex;
  }

  /** Reposition, recolour and show/hide the one marker mesh. */
  function syncMarker() {
    const owner = markerOwner();
    if (owner < 0 || owner >= count || !stations[owner] || holeOnly > 0.5) {
      marker.visible = false;
      markerMaterial.uniforms.uAlpha.value = 0;
      lastMarkerOwner = -1;
      lastMarkerLive = null;
      return;
    }
    // The owner already answers "whose ring is this" per space, so live is just
    // "is that owner also playing". Asking clusterAmount here as well made the
    // ring disagree with update(), which breathes for the owner unconditionally.
    const live = owner === playingIndex;
    // Colour is recomputed only when the ring changes hands: `setClusterAmount`
    // runs every transition frame and must stay allocation free.
    if (owner !== lastMarkerOwner || live !== lastMarkerLive) {
      if (live) {
        // White hot: the live station is the hottest thing on the disk.
        markerColor[0] = 1.0;
        markerColor[1] = 0.88;
        markerColor[2] = 0.70;
      } else {
        // A selected-but-silent station keeps the category tint it always had.
        const rgb = categoryRgb(stations[owner].categories[0]);
        markerColor[0] = 1.0;
        markerColor[1] = Math.min(1, 0.58 + rgb[1] * 0.35);
        markerColor[2] = Math.min(1, 0.38 + rgb[2] * 0.4);
      }
      markerMaterial.uniforms.uColor.value = markerColor;
      lastMarkerOwner = owner;
      lastMarkerLive = live;
    }
    placeMarker(owner);
    marker.visible = true;
    // The breathing alpha is written every frame by update(); this is only the
    // still value a paused or non-live ring settles at.
    markerMaterial.uniforms.uAlpha.value = live && !playingPaused ? 0.86 : live ? 0.34 : 0.9;
  }

  /** Recompute the cloud centroids a label layer can name. */
  function rebuildCloudCentroids() {
    filterClouds.length = 0;
    filteredCount = 0;
    if (!filterSet) return;
    const buckets = new Map();
    for (let i = 0; i < count; i += 1) {
      const target = selectedCloudTarget(i);
      if (!target) continue;
      filteredCount += 1;
      let bucket = buckets.get(target.cloudId);
      if (!bucket) {
        bucket = { id: target.cloudId, categoryId: target.categoryId, count: 0, x: 0, y: 0, z: 0 };
        buckets.set(target.cloudId, bucket);
      }
      bucket.count += 1;
      bucket.x += Math.cos(target.angle) * target.radius;
      bucket.y += target.height;
      bucket.z += Math.sin(target.angle) * target.radius;
    }
    for (const bucket of buckets.values()) {
      filterClouds.push({
        id: bucket.id,
        categoryId: bucket.categoryId,
        count: bucket.count,
        position: { x: bucket.x / bucket.count, y: bucket.y / bucket.count, z: bucket.z / bucket.count },
      });
    }
    filterClouds.sort((a, b) => b.count - a.count);
  }

  function selectedCloudTarget(index) {
    if (!filterSet) return null;
    const clouds = stationClouds[index];
    if (!clouds || clouds.length === 0) return null;
    const categories = stationCategories[index];
    for (const id of categories) {
      if (!filterSet.has(id)) continue;
      for (const cloud of clouds) {
        if (cloud.categoryId === id) return cloud;
      }
    }
    return null;
  }

  return {
    object: points,
    marker,
    count,
    particleCount: particleTotal,

    setPixelRatio(ratio) {
      uniforms.uPixelRatio.value = Math.max(1, Number(ratio) || 1);
    },

    setViewport(width, height, fovDegrees) {
      const h = Math.max(1, height);
      uniforms.uRes.value[0] = Math.max(1, width);
      uniforms.uRes.value[1] = h;
      const fov = ((Number(fovDegrees) || 42) * Math.PI) / 180;
      uniforms.uScale.value = (h * 0.5) / Math.tan(fov / 2);
    },

    setLod(value) {
      lod = clamp01(value);
      uniforms.uLod.value = lod;
    },

    setHole(px, py, radiusPx) {
      uniforms.uHolePx.value[0] = px;
      uniforms.uHolePx.value[1] = py;
      uniforms.uHoleRadiusPx.value = Math.max(1, radiusPx);
    },

    setSelectedIndex(index) {
      selectedIndex = typeof index === 'number' ? index : -1;
      uniforms.uSelected.value = selectedIndex;
      syncMarker();
    },

    /**
     * Bind the transport to the field.
     *
     * The ring is the one ring on the disk, and it belongs to playback: a
     * station that is selected but silent draws no ring at all. Pausing keeps
     * the ring and stops the breathing, so "the one I paused" stays findable.
     */
    setPlayingIndex(index, paused) {
      const next = Number.isInteger(index) && index >= 0 && index < count ? index : -1;
      const nextPaused = paused === true;
      if (next === playingIndex && nextPaused === playingPaused) return;
      playingIndex = next;
      playingPaused = nextPaused;
      uniforms.uPlaying.value = playingIndex;
      syncMarker();
    },

    /**
     * Recolour the favourites. `isFavourite` is asked once per station and the
     * answer is widened to that station's sprites: one upload per change, no
     * material rebuild, no second geometry.
     */
    setFavourites(isFavourite) {
      if (typeof isFavourite !== 'function') return;
      let p = 0;
      for (let i = 0; i < count; i += 1) {
        const flag = isFavourite(stations[i]) ? 1 : 0;
        const n = perStation[i];
        for (let k = 0; k < n; k += 1) favouriteFlags[p + k] = flag;
        p += n;
      }
      geometry.attributes.aFav.needsUpdate = true;
    },

    /**
     * Start (or reverse) the cloud reveal. Stations that match a selected
     * category ease toward their cloud target; everything else eases back to
     * its base place. No layout is rewritten, no buffer is reallocated.
     */
    setFilter(categoryIds) {
      const ids = Array.isArray(categoryIds) ? categoryIds.filter(Boolean) : [];
      filterSet = ids.length > 0 ? new Set(ids) : null;
      filterTarget = filterSet ? 1 : 0;
      for (let i = 0; i < count; i += 1) {
        const cloud = selectedCloudTarget(i);
        hold[i] = (stations[i].metadata.filterDelay || 0) * (filterSet ? 1 : 0.7);
        if (cloud) {
          tgtR[i] = cloud.radius;
          tgtA[i] = cloud.angle;
          tgtY[i] = cloud.height;
          matchTgt[i] = 1;
        } else {
          tgtR[i] = baseR[i];
          tgtA[i] = baseA[i];
          tgtY[i] = baseY[i];
          matchTgt[i] = filterSet ? 0 : 1;
        }
      }
      rebuildCloudCentroids();
      animating = true;
      dirtyBuffers = true;
    },

    /**
     * Install (or clear) a category cluster. `layout` comes straight from
     * src/cluster/layout.js: world positions + membership + weights. Setting it
     * to null sends every station back to its disk slot on the same curve.
     */
    setCluster(layout) {
      if (layout && layout.positions && layout.members) {
        clusterRadius = layout.radius || 3;
        knotScale = clusterRadius * 0.02;
        uniforms.uClusterRadius.value = clusterRadius;
        for (let i = 0; i < count; i += 1) {
          const member = layout.members[i] === 1;
          clusterMembers[i] = member ? 1 : 0;
          if (member) {
            clusterX[i] = layout.positions[i * 3];
            clusterY[i] = layout.positions[i * 3 + 1];
            clusterZ[i] = layout.positions[i * 3 + 2];
          }
          clusterGoal[i] = member ? 1 : 0;
          clusterHold[i] = member
            ? (hash32(seed, i, 'clusterDelay') % 1000) / 1000 * 0.34
            : 0;
        }
      } else {
        for (let i = 0; i < count; i += 1) {
          clusterGoal[i] = 0;
          clusterHold[i] = (hash32(seed, i, 'clusterExit') % 1000) / 1000 * 0.08;
        }
      }
      animating = true;
      dirtyBuffers = true;
    },

    /**
     * Catalogue brightness as a whole, 0..1. The black-hole view dims it so
     * the stations read as matter inside the disk; the cluster restores it.
     */
    setDim(value) {
      uniforms.uDim.value = Math.min(1, Math.max(0, Number(value)));
    },

    /**
     * Phase 5: show the hole on its own. `value` 1 suppresses every catalogue
     * sprite and the selection marker; 0 restores them. Positions, ids, the
     * search set and the cluster layout all keep running underneath.
     */
    setHoleOnly(value) {
      holeOnly = clamp01(Number(value) || 0);
      uniforms.uHoleOnly.value = holeOnly;
      syncMarker();
    },

    /** Global transition amount 0..1: hole mask, non-member fade, star shape. */
    setClusterAmount(value) {
      clusterAmount = clamp01(value);
      uniforms.uClusterAmount.value = clusterAmount;
      // The ring changes owner between the disk and a cluster, so a transition
      // has to hand it over. syncMarker() is allocation free on a no-op.
      syncMarker();
    },

    get clusterProgress() {
      return clusterAmount;
    },

    /** Clouds currently revealed, with their centroids, for the label layer. */
    filterInfo() {
      return {
        active: filterTarget > 0.5,
        strength: filterActive,
        matched: filteredCount,
        clouds: filterClouds,
      };
    },

    get filterState() {
      return {
        ids: filterSet ? Array.from(filterSet) : [],
        active: filterTarget > 0.5,
        strength: filterActive,
        matched: filteredCount,
      };
    },

    get isAnimating() {
      return animating;
    },

    /**
     * Advance the morph. Returns true while anything is still moving, so a
     * reduced-motion stage can keep drawing until the clouds have settled.
     */
    update(dt, camera, heightCss) {
      const step = typeof dt === 'number' && Number.isFinite(dt) ? Math.max(0, Math.min(0.05, dt)) : 0;
      if (step > 0) {
        time += step;
        uniforms.uTime.value = time;
        filterActive += (filterTarget - filterActive) * (1 - Math.exp(-step * 4.2));
        if (Math.abs(filterTarget - filterActive) < 0.002) filterActive = filterTarget;
        uniforms.uFilterActive.value = filterActive;
        // The reveal strength is part of the geometry (the micro-cluster spreads
        // as it condenses), so keep stepping and re-uploading until it settles.
        const fadeMoving = Math.abs(filterTarget - filterActive) > 0.002;

        let moving = false;
        for (let i = 0; i < count; i += 1) {
          // Disk cloud target.
          if (hold[i] > 0) {
            hold[i] = Math.max(0, hold[i] - step);
            moving = true;
          } else {
            const k = 1 - Math.exp(-step * 2.5 * speed[i]);
            const dr = tgtR[i] - curR[i];
            const da = wrapAngle(tgtA[i] - curA[i]);
            const dy = tgtY[i] - curY[i];
            if (Math.abs(dr) > 0.002 || Math.abs(da) > 0.002 || Math.abs(dy) > 0.002) {
              curR[i] += dr * k;
              curA[i] = wrapAngle(curA[i] + da * k);
              curY[i] += dy * k;
              moving = true;
            } else {
              curR[i] = tgtR[i];
              curA[i] = tgtA[i];
              curY[i] = tgtY[i];
            }
            const dm = matchTgt[i] - matchCur[i];
            if (Math.abs(dm) > 0.002) {
              matchCur[i] += dm * Math.min(1, k * 1.2);
              moving = true;
            } else {
              matchCur[i] = matchTgt[i];
            }
          }

          // Cluster target, on its own stagger.
          if (clusterHold[i] > 0) {
            clusterHold[i] = Math.max(0, clusterHold[i] - step);
            moving = true;
          } else {
            const dc = clusterGoal[i] - clusterBlend[i];
            if (Math.abs(dc) > 0.002) {
              const ck = 1 - Math.exp(-step * CLUSTER_RATE * speed[i]);
              clusterBlend[i] += dc * ck;
              moving = true;
            } else {
              clusterBlend[i] = clusterGoal[i];
            }
          }
        }
        if (moving || fadeMoving) dirtyBuffers = true;
        animating = moving || fadeMoving;
        if (dirtyBuffers) flush();
      }

      if (marker.visible) {
        const dist = Math.max(0.1, camera.position.distanceTo(marker.position));
        const fov = ((camera.fov || 42) * Math.PI) / 180;
        const worldPerPx = (2 * dist * Math.tan(fov / 2)) / Math.max(1, heightCss);
        // A cluster star is smaller on screen than a disk knot, so its reticle
        // follows: otherwise the ring swallows a whole filament.
        const sizePx = 34 - 8 * clusterAmount;
        marker.scale.set(worldPerPx * sizePx, worldPerPx * sizePx, 1);
        marker.quaternion.copy(camera.quaternion);
        // The live ring breathes. Pausing freezes it at a dim, steady alpha so
        // "the one I paused" is still findable without pulsing at the eye.
        if (playingIndex >= 0 && markerOwner() === playingIndex) {
          markerClock += dt;
          markerMaterial.uniforms.uAlpha.value = playingPaused
            ? 0.34
            : 0.50 + 0.34 * (0.5 + 0.5 * Math.sin(markerClock * 2.4));
        }
      }
      return animating;
    },

    /** True when this station is currently part of the interactive structure. */
    interactive(index) {
      if (index < 0 || index >= count) return false;
      // Hidden means hidden: while the black-hole view owns the frame the
      // sprites are suppressed, so they must not answer a hit test either.
      if (holeOnly > 0.5) return false;
      if (clusterAmount > 0.55) {
        // Only the chosen category lives in the cluster, and only once it has
        // actually arrived: a dot still in transit must not steal the click.
        return clusterMembers[index] === 1 && clusterBlend[index] > 0.55;
      }
      // While a filter is active the receded matter is background: it may still
      // glow, but it must not steal a click from the revealed cloud.
      return 1 - filterActive * (1 - matchCur[index]) > 0.25;
    },

    /** How strongly a station may carry a text label right now. */
    labelVisibility(index) {
      if (index < 0 || index >= count) return 0;
      if (holeOnly > 0.5) return 0;
      if (clusterAmount > 0.55) {
        return clusterMembers[index] === 1 ? clamp01(clusterBlend[index]) : 0;
      }
      return 1 - filterActive * (1 - matchCur[index]);
    },

    /** Current world position, without allocating. */
    positionInto(index, target) {
      if (index < 0 || index >= count) return target;
      return target.set(worldX[index], worldY[index], worldZ[index]);
    },

    positionAt(index) {
      if (index < 0 || index >= count) return null;
      return { x: worldX[index], y: worldY[index], z: worldZ[index] };
    },

    /** Bumped whenever the anchors move; a screen-space cache keys on it. */
    layoutVersion() {
      return layoutVersion;
    },

    /** Point diameter in CSS pixels, mirroring the vertex shader. */
    screenSizeAt(index, camera, heightCss) {
      if (index < 0 || index >= count) return 0;
      scratch.set(worldX[index], worldY[index], worldZ[index]);
      const dist = Math.max(0.001, camera.position.distanceTo(scratch));
      const near = 1 - smoothstep(5.5, 13.5, dist);
      const lodSize = 1.22 + (0.6 - 1.22) * lod;
      const grow = 1 + 1.0 * matchCur[index] * filterActive;
      const featured = stations[index] && stations[index].isFeatured ? 1 : 0;
      const size = nodeSize[index] * lodSize * grow * (1 + 0.45 * featured) * (1 + 0.5 * near);
      const diskPx = Math.max(1, (size * uniforms.uScale.value) / dist);
      if (clusterAmount <= 0.001) return diskPx;
      const clusterRad = Math.min(1, Math.hypot(worldX[index], worldY[index], worldZ[index]) / Math.max(0.001, clusterRadius));
      const coreWeight = Math.pow(1 - clusterRad, 1.35);
      const clusterPx = Math.max(
        1,
        ((nodeSize[index] * (featured ? 1.05 : 0.82) * (0.72 + 0.53 * coreWeight) * uniforms.uScale.value) / dist),
      );
      return diskPx + (clusterPx - diskPx) * clusterAmount;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      geometry.dispose();
      material.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
      points.removeFromParent();
      marker.removeFromParent();
    },
  };
}

/** World-space silhouette radius, exported for the picker's keep-out test. */
// The apparent shadow radius on screen is not a constant: it depends on the
// camera distance. Nothing imports this; it is kept only as the physical scale.
export const HOLE_RADIUS = CRITICAL_IMPACT_PARAMETER;

function orbitOf(position) {
  if (!position) return { radius: 1, angle: 0, height: 0 };
  const radius = Math.hypot(position.x, position.z);
  return { radius, angle: Math.atan2(position.z, position.x), height: position.y || 0 };
}

function wrapAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
