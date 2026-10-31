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
import { colorRgbOf, modulateTint } from '../cluster/forms.js';
import { centered, hash32, mulberry32 } from '../radio/random.js';
import { DISK_INNER, DISK_OUTER, CRITICAL_IMPACT_PARAMETER, RS } from '../scene/dimensions.js';
import { STATION_RADIUS } from '../radio/distribution.js';
import { NOISE_GLSL } from '../scene/glsl.js';

const DISK_PARTICLES = 5;
const FEATURED_PARTICLES = 8;
const MAX_POINT_PX = 44;

/**
 * The colour one station wears in the constellation.
 *
 * Layer one is the genre's fixed main colour; layer two is the country's
 * brightness and the language's warm/cool push, both deterministic per station
 * so the same station keeps the same tint on every mount. Country and language
 * never rotate the hue: a member of the Jazz body still reads as Jazz.
 */
function stationTint(station, seed, index) {
  const meta = station && station.metadata;
  const genreId =
    (station && typeof station.genre === 'string' && station.genre) ||
    (station && Array.isArray(station.genres) && typeof station.genres[0] === 'string' && station.genres[0]) ||
    (meta && typeof meta.genre === 'string' && meta.genre) ||
    (station && Array.isArray(station.categories) && station.categories[0]) ||
    'other';
  const base = colorRgbOf(genreId);
  const country = (hash32(seed, index, 'tintCountry') % 1000) / 1000;
  const language = (hash32(seed, index, 'tintLanguage') % 1000) / 1000;
  return modulateTint(base, country, language);
}
/** How fast the cluster transition settles, per station-speed unit. */
const CLUSTER_RATE = 3.1;

/**
 * The winding that comes before the burst.
 *
 * The angle itself is the traced disc's, so there is no constant here: the
 * shader turns its stations by `uCharge * 2.2 / r`, and these sprites have to
 * ride the same curve or the two lattices shear apart on screen.
 */
const CHARGE_LIFT = 0.17;

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
  uniform float uBurst;
  // 1 while these points are the matter of the black hole's own disc rather
  // than the catalogue's stars. The traced image already draws that disc, so
  // the sprites have to wear its colour instead of their own heat palette:
  // otherwise the hold shows two populations of points in one picture.
  uniform float uDiskMatter;
  // 0..1, the hand-over from the traced disc's own texels to these sprites.
  // Raised while the hold fills, held at 1 through the burst, so the disc's
  // stations are one population that changes hands, never two in one frame.
  uniform float uTakeover;
  // 1 while the black-hole panel owns the frame: phase 5 hides the station
  // sprites so only the traced image is visible. The data model is untouched.
  uniform float uHoleOnly;
  // The station whose stream is live, or -1. One knob, read by the vertex pass
  // only: the heat source is the full brightening, the ring lives on the marker.
  uniform float uPlaying;
  // The station the pointer is over, or -1, plus whether anything is hovered at
  // all. A hover is a reading aid, not a selection: it lifts the sprite it names
  // and leaves every other one alone, and it is cleared the moment the pointer
  // leaves.
  uniform float uHover;
  uniform float uHoverActive;

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
    float clusterSize = aBase * mix(0.95, 1.45, coreWeight) * mix(1.0, 2.4, aVeil) * (1.0 + aTier * 0.5)
      * uPixelRatio * uScale / dist;
    sizePx = mix(sizePx, clusterSize, cluster);
    // Airborne matter is smeared by a motion it does not really have. A modest
    // swell is enough to read as speed, and it costs nothing: the energy below
    // is pulled back by the same factor so the burst does not clip to white.
    sizePx *= 1.0 + uBurst * 0.75;
    gl_PointSize = clamp(sizePx, 1.0, ${MAX_POINT_PX.toFixed(1)});

    gl_Position = projectionMatrix * mv;
    vNdc = gl_Position.xy / max(gl_Position.w, 0.0001);

    float selected = step(abs(aStation - uSelected), 0.5);
    vSelected = selected;

    // Hover belongs to one station at a time and lifts only that sprite. It used
    // to recede every berth except the hovered star's own, which read as the rest
    // of the sky going out: naming a star is not a filter, so nothing else
    // changes brightness for it.
    float hovered = step(abs(aStation - uHover), 0.5);
    float hoverBoost = mix(1.0, 1.30, uHoverActive * hovered);

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
      * mix(1.0, 1.85, cluster * aVeil)
      * mix(1.0, 0.74, uBurst);
    // Tiny sprites are filtered out gradually in the disk, but a cluster star
    // must remain a findable speck even at the far rim.
    float sizeFade = mix(
      smoothstep(0.7, 2.4, sizePx),
      smoothstep(0.55, 1.6, clusterSize),
      cluster
    );

    // Cluster sprites are small, so their per-pixel coverage is low; a modest
    // gain keeps single stars readable without turning the core into a disc.
    // A cluster star used to be given more than twice the disk's energy, which
    // is what made the page read as over-exposed the moment the transition
    // landed: the last frames of the crossing multiplied "dim restored" by
    // "gain doubled" in the same instant. One step above the disk is enough to
    // read as a lit object; the core keeps its shape because the fragment pass
    // below no longer saturates it.
    float clusterGain = mix(1.0, 1.32, cluster);
    // Heat spots are lit by the disk they sit in: the doppler gain and the
    // radial heat both scale the energy, so a spot on the approaching side
    // outshines one on the receding side instead of every node glowing alike.
    float diskLight = mix(doppler * (0.70 + 0.64 * heat), 1.0, cluster);
    float live = step(abs(aStation - uPlaying), 0.5);
    float liveGain = mix(1.0, 1.42, live);
    // Standing in for the traced disc's stations, these are the same weak
    // texels the shader was drawing, not catalogue stars: at full brightness
    // they out-shone the gas and read as a separate, denser disc on top of it.
    // uTakeover is the hand-over itself, so the two sets never overlap: the
    // shader's texels go out exactly as these come up.
    float standIn = mix(1.0, 0.42 * uTakeover, uDiskMatter);


    vAlpha = aPresence * matter * dim * boost * lodAlpha * diskFade
      * sizeFade * energy * memberFade * clusterGain * diskLight * liveGain * standIn
      * hoverBoost
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
    // Cluster: the genre's own colour, warmed at the core and cooled at the
    // rim. Country brightness and language temperature are already inside
    // aTint, so those two layers need no second pass here — this is a 10% shift
    // in temperature, not a different hue. Every body therefore keeps the fixed
    // colour it was given, which is the whole point of the thirteen-colour ring.
    vec3 clusterColor = aTint * mix(vec3(1.08, 1.00, 0.92), vec3(0.90, 0.97, 1.10), clusterRad);
    vec3 mixedColor = mix(tinted, clusterColor, cluster);
    // Under the hole these are not catalogue stars at all: they are the disc's
    // own matter, and the traced image behind them has already decided what
    // that looks like. Wearing its colour is what keeps the hold from reading
    // as a second disc appearing on top of the first, so this is the traced
    // disc's warm gold, not the blue-white the shader never shows.
    vec3 diskMatterColor = mix(vec3(1.0, 0.58, 0.24), vec3(1.0, 0.88, 0.66), heat);
    mixedColor = mix(mixedColor, diskMatterColor, uDiskMatter);

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
    // Kept under one on purpose: at 0.40 + 0.60 the cluster's own core summed
    // past 1.0 and every dense body had a white centre with no gradient left in
    // it. This is the second half of "slightly brighter than the hole".
    float profile = mix(halo * 0.50 + core * 0.34, starHalo * 0.34 + starCore * 0.42, vCluster);
    vec3 color = vColor * (0.86 + 0.30 * core + vSelected * 0.15);
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
  /**
   * Which face of the disc a station is thrown from. Fixed per station and
   * never recomputed: half the matter has to leave upward and half downward, or
   * the burst reads as one cone with a shadow under it instead of two lobes.
   */
  const stationSide = new Float32Array(count);
  let clusterRadius = 3;
  let knotScale = 0.03;
  const flightPosition = new Vector3();

  // Hold pressure, 0..1, and where it is heading. It drives the winding and the
  // swell only; the burst itself follows the cluster blend, so releasing the
  // hold can never strand the disc half burst.
  let charge = 0;
  let chargeTarget = 0;
  // 0..1 single-peak envelope of the burst, mirrored to the shader so the
  // sprites swell while they are thrown and settle as they land.
  let burst = 0;
  // Set while a hand-authored passage drives the blend: -1 hands the blend back
  // to the timed ease, 0..1 (and over) means the timeline owns it exactly.
  let flow = -1;

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
    stationSide[i] = hash32(seed, i, 'side') % 2 === 0 ? 1 : -1;
    stationCategories[i] = station.categories || [];
    stationClouds[i] = station.metadata.clouds || [];

    const featured = station.isFeatured === true;
    const rgb = stationTint(station, seed, i);
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
    // Single-peak envelope of the burst, 0 on the disc and on the cluster, 1 at
    // the top of the cone. Only the sprite size reads it.
    uBurst: { value: 0 },
    uDim: { value: 1 },
    // 1 while the sprites stand in for the disc's own matter, so they take the
    // traced disc's colour rather than the catalogue's heat palette.
    uDiskMatter: { value: 0 },
    uTakeover: { value: 0 },
    // Phase 5: 1 hides every catalogue sprite. The data behind them is untouched;
    // this is a visibility gate, not a data change.
    uHoleOnly: { value: 0 },
    uPlaying: { value: -1 },
    uHover: { value: -1 },
    uHoverActive: { value: 0 },
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

  // One allocation-free cubic path for sprites, hit targets, labels and markers.
  // Its departure tangent follows orbital motion; the destination tangent eases
  // into the category knot. Both endpoints are exact and reverse on the same path.
  function sampleFlight(x, y, z, tx, ty, tz, blend) {
    const radius = Math.max(0.001, Math.hypot(x, z));
    const tangentX = -z / radius;
    const tangentZ = x / radius;
    const reach = Math.min(2.2, radius * 0.65);
    const u = 1 - blend;
    const c1 = 3 * u * u * blend;
    const c2 = 3 * u * blend * blend;
    const end = blend * blend * blend;
    return flightPosition.set(
      u * u * u * x + c1 * (x + tangentX * reach) + c2 * (tx - tangentX * reach * 0.25) + end * tx,
      u * u * u * y + c1 * y + c2 * ty + end * ty,
      u * u * u * z + c1 * (z + tangentZ * reach) + c2 * (tz - tangentZ * reach * 0.25) + end * tz,
    );
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

    let diskX = cos * r + (-sin * ax + cos * ar) * diskScale;
    let diskY = curY[stationIndex] + ay * (1 + 0.4 * matchCur[stationIndex] * filterActive);
    let diskZ = sin * r + (cos * ax + sin * ar) * diskScale;

    // Hold pressure: the disc winds up under the hand and its two faces swell
    // apart. The angle is the traced disc's own, `uCharge * 2.2 / r` in Rs
    // units, so these sprites turn exactly where the shader's stations turn;
    // anything else would put two lattices on one disc.
    if (charge > 0.0005) {
      const wind = (charge * 2.2) / Math.max(r / RS, 1.0);
      const cw = Math.cos(wind);
      const sw = Math.sin(wind);
      const woundX = diskX * cw - diskZ * sw;
      const woundZ = diskX * sw + diskZ * cw;
      diskX = woundX;
      diskZ = woundZ;
      diskY += charge * CHARGE_LIFT * stationSide[stationIndex];
    }

    const blend = smoothstep01(clusterBlend[stationIndex]);
    if (blend <= 0.0001) {
      positions[particle * 3] = diskX;
      positions[particle * 3 + 1] = diskY;
      positions[particle * 3 + 2] = diskZ;
      return;
    }


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

    const point = sampleFlight(diskX, diskY, diskZ, clusterXW, clusterYW, clusterZW, blend);
    positions[particle * 3] = point.x;
    positions[particle * 3 + 1] = point.y;
    positions[particle * 3 + 2] = point.z;
  }

  /** Station centre (no sprite offset), used for picking, labels and marker. */
  function writeStationAnchors(from, to) {
    for (let i = from; i < to; i += 1) {
      const a = curA[i];
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const wind = charge > 0.0005 ? (charge * 2.2) / Math.max(curR[i] / RS, 1.0) : 0;
      const diskX = Math.cos(a + wind) * curR[i];
      const diskZ = Math.sin(a + wind) * curR[i];
      const diskY = curY[i] + (charge > 0.0005 ? charge * CHARGE_LIFT * stationSide[i] : 0);
      const blend = smoothstep01(clusterBlend[i]);
      const point = sampleFlight(diskX, diskY, diskZ, clusterX[i], clusterY[i], clusterZ[i], blend);
      worldX[i] = point.x;
      worldY[i] = point.y;
      worldZ[i] = point.z;
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
        // A selected-but-silent station keeps its genre tint.
        const rgb = stationTint(stations[owner], seed, owner);
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

    /**
     * One station under the pointer, or -1. Nothing here is remembered beyond
     * the two uniforms: the label, the cursor and the lift all read from the
     * same index the stage already keeps.
     */
    setHoverIndex(index) {
      const next = Number.isInteger(index) && index >= 0 && index < count ? index : -1;
      uniforms.uHover.value = next;
      uniforms.uHoverActive.value = next >= 0 ? 1 : 0;
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
     * Hold pressure, 0..1. Drives the winding and the face swell only: the
     * burst itself is a function of the cluster blend, so a released hold can
     * never strand the disc half burst — it just unwinds.
     */
    setCharge(value) {
      const next = clamp01(Number(value) || 0);
      if (next === chargeTarget) return;
      chargeTarget = next;
      animating = true;
      dirtyBuffers = true;
    },

    /**
     * Burst envelope, 0..1. Mirrored from the same curve the geometry rides so
     * the sprites swell while they are being thrown and tighten as they land.
     */
    setBurst(value) {
      const next = clamp01(Number(value) || 0);
      if (Math.abs(next - burst) < 0.0015) return;
      burst = next;
      uniforms.uBurst.value = burst;
    },

    /**
     * Hand the cluster blend to a timeline, or take it back with -1.
     *
     * The passage out of the hole is authored against wall-clock seconds, and
     * its two cones are built out of this blend. Letting the layer keep easing
     * the blend on its own clock would put the geometry a fixed fraction of a
     * second behind the dimmer and the swell that are describing it, which is
     * exactly the kind of drift that made the old crossing read as two effects
     * playing at once. While this is set, the timeline IS the clock.
     */
    setFlow(value) {
      const next = Number(value);
      const wanted = Number.isFinite(next) && next >= 0 ? clamp01(next) : -1;
      if (wanted === flow) return;
      flow = wanted;
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
     * How much these sprites are the disc's matter rather than the catalogue's
     * stars, 0..1. 1 borrows the traced disc's colour; the passage eases it
     * back to 0 as the matter leaves, so the burst ends up its own colour.
     */
    setDiskMatter(value) {
      uniforms.uDiskMatter.value = Math.min(1, Math.max(0, Number(value)));
    },

    /**
     * Hand-over from the traced disc's texels to these sprites, 0..1. At 0 the
     * shader owns the disc's stations and these sprites are invisible; at 1 the
     * sprites own them and the shader's texels are dark. It exists so the two
     * populations never share a frame, which is what made the hold read as a
     * second disc laid over the first.
     */
    setTakeover(value) {
      uniforms.uTakeover.value = Math.min(1, Math.max(0, Number(value)));
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

        // Hold pressure. Rises slower than it falls: the wind-up is the part the
        // eye should have time to read, the release is a snap back.
        const dc = chargeTarget - charge;
        if (Math.abs(dc) > 0.0006) {
          const rate = dc > 0 ? 9.5 : 15.0;
          charge += dc * (1 - Math.exp(-step * rate));
          moving = true;
        } else if (charge !== chargeTarget) {
          charge = chargeTarget;
          moving = true;
        }

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

          // Cluster target, on its own stagger — unless a hand-authored
          // passage owns the blend this frame, in which case the timeline is
          // the only clock and the stagger would only make the two disagree.
          if (flow >= 0) {
            clusterBlend[i] = clusterMembers[i] === 1 ? flow : 0;
            clusterHold[i] = 0;
            moving = true;
          } else if (clusterHold[i] > 0) {
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
