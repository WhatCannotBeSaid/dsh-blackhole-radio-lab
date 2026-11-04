/**
 * A passage made from the actual imaged disc, not a second station population.
 * Every instance is one occupied source-image cell, with its captured colour and
 * the station identity read by the SAME geodesic shader. No source cell is left
 * behind: moving the instance is the removal operation.
 */
import {
  BufferAttribute, DataTexture, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, NearestFilter, NormalBlending, RawShaderMaterial, RGBAFormat,
  UnsignedByteType, Vector2, Vector3,
} from 'three';

export const DISC_TRANSFER_LANDING = 0.88;
export function discTransferHandoff(progress) {
  const t = Math.max(0, Math.min(1, (progress - DISC_TRANSFER_LANDING) / (1 - DISC_TRANSFER_LANDING)));
  return t * t * (3 - 2 * t);
}

// Undo the timeline's ease once, for both the live particles and traced image.
export function discReturnProgress(progress) {
  if (progress <= 0) return 1;
  if (progress >= 1) return 0;
  return 0.5 + Math.sin(Math.asin(1 - 2 * progress) / 3);
}

// Local interleaving, not an angular wipe: no branch cut through the light band.
// The shadow reaches its final scale at .72, before the first arrival at .74.
export function discReturnPhase(u, v) {
  return 0.74 + 0.14 * (0.5 + 0.25 * Math.sin(u * 173) + 0.25 * Math.sin(v * 157));
}
export const DISC_RETURN_GLSL = `
float discReturnPhase(vec2 uv) {
  return 0.74 + 0.14 * (0.5 + 0.25 * sin(uv.x * 173.0) + 0.25 * sin(uv.y * 157.0));
}
`;

const VERTEX = `
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform float uProgress;
uniform vec2 uViewport;
uniform vec2 uCellPx;
uniform vec3 uOrigin;
uniform vec3 uRight;
uniform vec3 uUp;
attribute vec3 position;
attribute vec3 aSource;
attribute vec3 aTarget;
attribute vec3 aAnchor;
attribute vec3 aScatter;
attribute vec2 aUv;
attribute float aDelay;
attribute float aSpin;
varying vec2 vUv;
varying vec2 vLocal;
varying float vPoint;
void main() {
  float p = clamp(uProgress, 0.0, 1.0);
  float travel = clamp((p - aDelay) / (1.0 - aDelay), 0.0, 1.0);
  float flight = smoothstep(0.0, 1.0, travel);
  // Once the passage advances, ALL cells are dots, including delayed ones.
  // Only an unstarted press keeps the intact image; no tiles may fly or turn.
  float point = p > 0.0 ? 1.0 : 0.0;
  vec3 radial = aSource - uOrigin;
  float sx = dot(radial, uRight);
  float sy = dot(radial, uUp);
  // One rotation per station: every cell of the same station sweeps the same
  // arc, so the field turns as groups instead of each cell spinning alone.
  float turn = aSpin * sin(3.14159265359 * p);
  vec3 source = uOrigin + uRight * (sx * cos(turn) - sy * sin(turn))
    + uUp * (sx * sin(turn) + sy * cos(turn));
  // The station's own knot on the disc is the rendezvous its cells pass
  // through, so the passage reads as a stream rather than debris.
  vec3 anchorRadial = aAnchor - uOrigin;
  float ax = dot(anchorRadial, uRight);
  float ay = dot(anchorRadial, uUp);
  vec3 anchor = uOrigin + uRight * (ax * cos(turn) - ay * sin(turn))
    + uUp * (ax * sin(turn) + ay * cos(turn));
  vec3 tangent = (-sy * uRight + sx * uUp) / max(0.001, length(vec2(sx, sy)));
  vec3 toAnchor = anchor - source;
  float reach = min(2.2, length(toAnchor) * 0.55);
  vec3 control1 = source + toAnchor * 0.42 + tangent * reach * 0.4;
  vec3 control2 = anchor + (aTarget - anchor) * 0.5;
  float q = 1.0 - flight;
  vec3 world = q*q*q*source + 3.0*q*q*flight*control1
    + 3.0*q*flight*flight*control2 + flight*flight*flight*aTarget;
  // Break the captured pixel grid into a volume, even before delayed cells fly.
  // Progress alone drives it: cancellation retraces it and both endpoints match.
  float spread = smoothstep(0.0, 0.06, p) * (1.0 - smoothstep(0.55, 1.0, p));
  world += aScatter * spread;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  vec2 size = mix(uCellPx, vec2(2.2), point);
  clip.xy += position.xy * size * 2.0 / uViewport * clip.w;
  gl_Position = clip;
  vUv = aUv;
  vLocal = position.xy;
  vPoint = point;
}
`;
const FRAGMENT = `
precision highp float;
uniform sampler2D uImage;
uniform float uOpacity;
varying vec2 vUv;
varying vec2 vLocal;
varying float vPoint;
void main() {
  // These are already display-space bytes from the real imaging pass. Do not
  // apply another palette, exposure curve, halo or procedural density to them.
  vec3 colour = texture2D(uImage, vUv).rgb;
  // During the passage even cells waiting to depart are round points.
  // Only progress zero fills the original image, before any motion begins.
  float d = length(vLocal) * 2.0;
  float disc = 1.0 - smoothstep(0.55, 1.0, d);
  float alpha = uOpacity * mix(1.0, disc, vPoint);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(colour, alpha);
}
`;

/** Pure construction seam, also used by the source-identity regression test. */
export function buildDiscFragments(snapshot, layout) {
  const { width, height, pixels, ids, camera } = snapshot;
  const total = width * height;
  const stationCount = layout.members.length;
  const owner = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  let tail = 0;
  // Empty gas between station footprints inherits the nearest actually observed
  // station. It is transported as well; no procedural floor remains as a disc.
  for (let i = 0; i < total; i++) {
    const id = Math.round(ids[i]);
    if (pixels[i * 4 + 3] && Number.isFinite(ids[i]) && id >= 0 && id < stationCount && layout.members[id]) {
      owner[i] = id;
      queue[tail++] = i;
    }
  }
  if (!tail) throw new Error('Disc transfer: the imaged disc has no station attribution');
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    const x = i % width;
    // Keep the same breadth-first tie order without a closure per image cell.
    if (x > 0 && owner[i - 1] < 0) { owner[i - 1] = owner[i]; queue[tail++] = i - 1; }
    if (x + 1 < width && owner[i + 1] < 0) { owner[i + 1] = owner[i]; queue[tail++] = i + 1; }
    if (i >= width && owner[i - width] < 0) { owner[i - width] = owner[i]; queue[tail++] = i - width; }
    if (i + width < total && owner[i + width] < 0) { owner[i + width] = owner[i]; queue[tail++] = i + width; }
  }
  let count = 0;
  for (let i = 0; i < total; i++) if (pixels[i * 4 + 3]) count++;
  const source = new Float32Array(count * 3);
  const target = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const delay = new Float32Array(count);
  const station = new Int32Array(count);
  const anchorSum = new Float64Array(stationCount * 3);
  const anchorCount = new Float64Array(stationCount);
  camera.updateMatrixWorld();
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const forward = new Vector3().setFromMatrixColumn(camera.matrixWorld, 2).negate();
  const distance = Math.max(0.1, camera.position.length());
  const origin = camera.position.clone().addScaledVector(forward, distance);
  const halfHeight = Math.tan(camera.fov * Math.PI / 360) * distance;
  const halfWidth = halfHeight * camera.aspect;
  // Relative to the captured field, not its pixel resolution or current camera.
  const scatterRadius = halfHeight * 0.08;
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (!pixels[i * 4 + 3]) continue;
    const u = ((i % width) + 0.5) / width;
    const v = (Math.floor(i / width) + 0.5) / height;
    const x = (u * 2 - 1) * halfWidth;
    const y = (v * 2 - 1) * halfHeight;
    const id = owner[i];
    for (let k = 0; k < 3; k++) {
      const axis = ['x', 'y', 'z'][k];
      source[n * 3 + k] = origin[axis] + right[axis] * x + up[axis] * y;
      // A source cell keeps a tiny, deterministic place within its station knot.
      // This is not a new random star: it is the same cell of the captured image.
      const noise = Math.sin((i + 1) * (k + 1) * 2.39996323);
      const hash = noise * 43758.5453;
      scatter[n * 3 + k] = (hash - Math.floor(hash) - 0.5) * 2 * scatterRadius;
      target[n * 3 + k] = layout.positions[id * 3 + k] + noise * 0.018;
      anchorSum[id * 3 + k] += source[n * 3 + k];
    }
    anchorCount[id]++;
    uv[n * 2] = u; uv[n * 2 + 1] = v;
    // The outside leaves first. The remaining original cells form an eroding
    // inner disc rather than all pixels fading out together. The per-station
    // phase keeps whole stations from starting at the same instant.
    delay[n] = 0.27 * (1 - Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.52))
      + 0.05 * ((id * 0.6180339887) % 1);
    station[n] = id;
    n++;
  }
  // Every cell of a station shares that station's source centroid, so the
  // passage funnels through one knot per station instead of scattering.
  const anchor = new Float32Array(count * 3);
  const spin = new Float32Array(count);
  for (let id = 0; id < stationCount; id++) {
    if (anchorCount[id] > 0) {
      for (let k = 0; k < 3; k++) anchorSum[id * 3 + k] /= anchorCount[id];
    }
  }
  for (let i = 0; i < count; i++) {
    const id = station[i];
    for (let k = 0; k < 3; k++) anchor[i * 3 + k] = anchorSum[id * 3 + k];
    // Same station, same sweep. Deterministic, so replays stay identical.
    spin[i] = 0.55 + 0.35 * Math.sin(id * 1.6180339887);
  }
  return { count, source, target, scatter, anchor, spin, uv, delay, station, origin, right, up };
}

export function createDiscTransfer(renderer) {
  let mesh = null;
  let image = null;
  let active = false;
  let progress = 0;
  let sourceCamera = null;
  let capture = null;
  const viewport = new Vector2();
  // Stable carrier attached once to the scene, not rebuilt by each progress tick.
  const object = new Mesh(new InstancedBufferGeometry(), new RawShaderMaterial());
  object.visible = false;
  object.frustumCulled = false;
  object.renderOrder = 2;
  object.name = 'bhrl.disc-transfer';

  function prepare(snapshot, layout) {
    const data = buildDiscFragments(snapshot, layout);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aSource', new InstancedBufferAttribute(data.source, 3));
    geometry.setAttribute('aTarget', new InstancedBufferAttribute(data.target, 3));
    geometry.setAttribute('aAnchor', new InstancedBufferAttribute(data.anchor, 3));
    geometry.setAttribute('aScatter', new InstancedBufferAttribute(data.scatter, 3));
    geometry.setAttribute('aUv', new InstancedBufferAttribute(data.uv, 2));
    geometry.setAttribute('aDelay', new InstancedBufferAttribute(data.delay, 1));
    geometry.setAttribute('aSpin', new InstancedBufferAttribute(data.spin, 1));
    geometry.instanceCount = data.count;
    const nextImage = new DataTexture(snapshot.pixels, snapshot.width, snapshot.height, RGBAFormat, UnsignedByteType);
    nextImage.minFilter = NearestFilter;
    nextImage.magFilter = NearestFilter;
    nextImage.generateMipmaps = false;
    nextImage.needsUpdate = true;
    renderer.getDrawingBufferSize(viewport);
    const material = new RawShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: {
        uProgress: { value: 0 }, uImage: { value: nextImage }, uOpacity: { value: 1 },
        uViewport: { value: viewport.clone() },
        uCellPx: { value: new Vector2(viewport.x / snapshot.width, viewport.y / snapshot.height) },
        uOrigin: { value: data.origin }, uRight: { value: data.right }, uUp: { value: data.up },
      },
      transparent: true, depthTest: false, depthWrite: false,
      blending: NormalBlending, toneMapped: false,
    });
    object.geometry.dispose(); object.material.dispose();
    if (image) image.dispose();
    object.geometry = geometry; object.material = material;
    image = nextImage;
    mesh = data;
    sourceCamera = snapshot.camera;
    capture = { width: snapshot.width, height: snapshot.height };
  }
  function begin(snapshot, layout) {
    prepare(snapshot, layout);
    active = true;
    setProgress(0);
  }
  function setProgress(value) {
    progress = Math.min(1, Math.max(0, Number(value) || 0));
    if (!mesh) return;
    // Finish geometry first. Only then may the resting star material take over.
    object.material.uniforms.uProgress.value = Math.min(1, progress / DISC_TRANSFER_LANDING);
    object.material.uniforms.uOpacity.value = 1 - discTransferHandoff(progress);
    renderer.getDrawingBufferSize(viewport);
    object.material.uniforms.uViewport.value.copy(viewport);
    object.material.uniforms.uCellPx.value.set(viewport.x / capture.width, viewport.y / capture.height);
    // The ordinary cluster is allowed back only at the exact landed endpoint.
    object.visible = active && progress < 1;
  }
  function end() { active = false; object.visible = false; }
  function dispose() {
    object.geometry.dispose(); object.material.dispose();
    if (image) image.dispose();
    mesh = null; image = null;
  }
  return {
    object, begin, setProgress, end, dispose,
    get active() { return active; },
    get info() { return { active, progress, fragments: mesh ? mesh.count : 0, capture, sourceCamera: Boolean(sourceCamera) }; },
  };
}
