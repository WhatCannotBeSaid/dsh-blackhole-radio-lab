/**
 * Unified black-hole imaging: one fragment shader, one pass.
 *
 * This replaces the old billboard-and-two-materials construction. There is no
 * disc mesh, no shadow sphere, and no analytic photon-ring term any more: a
 * single camera-facing quad traces one null geodesic per pixel through the
 * precomputed Schwarzschild deflection tables, and everything visible in the
 * image is a consequence of that trace.
 *
 *   shadow      light that fell in; the trace returns "captured" and the
 *               background term is skipped, so the hole is black because
 *               nothing comes back, not because a sphere covers it
 *   disc        the crossings the ray reports on the disc plane, shaded with a
 *               thin-disc temperature profile, blackbody colour, and the
 *               Doppler factor computed from the ray itself
 *   bent arc    the same disc, through the crossings that the geometry wraps
 *               over the top of the hole; no extra arc geometry exists
 *   background  a light environment sampled along the deflected direction
 *
 * Coordinates. The trace works in Schwarzschild units where the horizon is at
 * r = 1, which is what the shipped tables were generated in (Rs = 1, c = 1).
 * The scene works in "one shadow radius" units. The two are related by
 *
 *   (x, y, z)_shader = (x, -z, y)_world / RS
 *
 * a proper rotation (determinant +1, so nothing is mirrored) that sends the
 * world disc normal +Y to the +Z that the shader's frame construction assumes.
 * It also carries the camera basis across, so the projection is exact.
 */

import {
  DataTexture,
  DoubleSide,
  LinearFilter,
  Mesh,
  NearestFilter,
  PerspectiveCamera,
  NoBlending,
  PlaneGeometry,
  RawShaderMaterial,
  RGFormat,
  FloatType,
  ClampToEdgeWrapping,
  FloatType as RTFloatType,
  LinearSRGBColorSpace,
  NoToneMapping,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  GLSL3,
} from 'three';
import { RS, DISK_INNER, DISK_OUTER, ISCO_RADIUS } from './dimensions.js';
import { buildFragmentShader, VERTEX_SHADER, IMAGING_CONSTANTS } from './geodesic.glsl.js';
import { createRayTables } from './ray-tables.js';
import { RADIO_GAIN } from './radio-fixtures.js';

/** Number of radio fixture slots compiled into the shader (RADIO_MAX). */
export const RADIO_SLOTS = 4;

const FRAGMENT_SHADER = buildFragmentShader();

/** Exposed for the validation harness and the report; no longer used to draw. */
export const DISK_IMAGING = Object.freeze({
  mass: IMAGING_CONSTANTS.M,
  criticalImpactParameter: IMAGING_CONSTANTS.B_CRIT,
  isco: ISCO_RADIUS,
  inner: DISK_INNER,
  outer: DISK_OUTER,
  peakRadius: (49 / 36) * DISK_INNER,
  peakTemperature: IMAGING_CONSTANTS.T_PEAK,
  gain: IMAGING_CONSTANTS.DISC_GAIN,
  timeScale: IMAGING_CONSTANTS.TIME_SCALE,
  exposure: IMAGING_CONSTANTS.EXPOSURE,
});

/** Rotate a world-space vector into the shader's Schwarzschild frame. */
function toShader(x, y, z, out) {
  out[0] = x / RS;
  out[1] = -z / RS;
  out[2] = y / RS;
  return out;
}

export function createAccretionDisk(options = {}) {
  const { renderer } = options;

  const tables = createRayTables(renderer);
  const drawBuffer = new Vector2();

  const uniforms = {
    uDeflectionTable: { value: tables.deflection },
    uInverseRadiusTable: { value: tables.inverseRadius },
    uHardwareFilter: { value: tables.hardwareFilter },
    uCamPos: { value: [0, 0, 0] },
    uCamRight: { value: [1, 0, 0] },
    uCamUp: { value: [0, 1, 0] },
    uCamForward: { value: [0, 0, -1] },
    uViewport: { value: new Vector2(1, 1) },
    uTanHalfFov: { value: Math.tan((42 * Math.PI) / 360) },
    uTime: { value: 0 },
    uOpacity: { value: 1 },
    uExposure: { value: IMAGING_CONSTANTS.EXPOSURE },
    uProbeMode: { value: 0 },
    uProbeRect: { value: new Vector4(0, 0, 0, 0) },
    // Phase-2 radio fixtures. Default: no source, no mask, so the compiled shader
    // takes exactly the same path it took before the fixtures existed.
    uRadioCount: { value: 0 },
    uRadioMask: { value: 0 },
    uRadioGeom: { value: Array.from({ length: RADIO_SLOTS }, () => new Vector4(0, 0, 0, 0)) },
    uRadioColor: { value: Array.from({ length: RADIO_SLOTS }, () => new Vector3(0, 0, 0)) },
    uRadioGain: { value: RADIO_GAIN },
  };

  const material = new RawShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    glslVersion: GLSL3,
    // The pass writes the whole image, background included, so it does not
    // blend with anything and does not participate in depth at all.
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    side: DoubleSide,
  });
  material.name = 'bhrl.imaging';

  // A 2x2 quad is enough: the vertex shader emits clip-space coordinates
  // directly, so the geometry only has to exist.
  const geometry = new PlaneGeometry(2, 2, 1, 1);
  const object = new Mesh(geometry, material);
  object.name = 'bh-imaging';
  object.frustumCulled = false;
  // Drawn before anything that still uses the depth buffer (the station layer in
  // cluster mode), so those passes composite on top of the finished image.
  object.renderOrder = -10;

  let opacity = 1;
  let disposed = false;

  /** Radio fixtures currently uploaded, and which slots are enabled. */
  let radioCount = 0;
  let radioMask = 0;

  // Probe-only scaffolding. The quad writes clip space directly, so any camera
  // produces the same full-screen result and none of its state matters.
  const probeScene = new Scene();
  const probeCamera = new PerspectiveCamera();

  const camPos = [0, 0, 0];
  const camRight = [0, 0, 0];
  const camUp = [0, 0, 0];
  const camFwd = [0, 0, 0];
  const worldPos = { x: 0, y: 0, z: 0 };

  function update(time, camera) {
    if (disposed) return;

    // Camera basis in world space, then the same rotation applied to it, so the
    // shader's frame is the camera's frame and the projection is exact.
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    toShader(e[0], e[1], e[2], camRight);
    toShader(e[4], e[5], e[6], camUp);
    // three.js cameras look down -Z in their own frame.
    toShader(-e[8], -e[9], -e[10], camFwd);

    // The hole sits at the world origin in this scene; read it off the camera's
    // world position rather than assuming, so a future move stays correct.
    worldPos.x = camera.position.x;
    worldPos.y = camera.position.y;
    worldPos.z = camera.position.z;
    toShader(worldPos.x, worldPos.y, worldPos.z, camPos);

    uniforms.uCamPos.value = camPos;
    uniforms.uCamRight.value = camRight;
    uniforms.uCamUp.value = camUp;
    uniforms.uCamForward.value = camFwd;
    uniforms.uTanHalfFov.value = Math.tan((camera.fov * Math.PI) / 360);
    uniforms.uTime.value = time;
    uniforms.uOpacity.value = opacity;

    if (renderer) {
      renderer.getDrawingBufferSize(drawBuffer);
      uniforms.uViewport.value.set(drawBuffer.x, drawBuffer.y);
    }
  }

  /** Explicit viewport override, for tests and offscreen probes. */
  function setViewport(width, height) {
    uniforms.uViewport.value.set(width, height);
  }

  function setOpacity(value) {
    opacity = Math.min(1, Math.max(0, Number(value) || 0));
    uniforms.uOpacity.value = opacity;
    object.visible = opacity > 0.004;
  }

  /**
   * Kept so the transition code keeps working. The photon ring is no longer
   * drawn as a separate feature, so there is nothing to scale; the call is a
   * no-op by design and that is the intended behaviour, not an oversight.
   */
  function setRingIntensity() {}

  /** Numerical probe mode, used by the in-browser validation page. */
  function setProbeMode(mode) {
    uniforms.uProbeMode.value = Math.max(0, Math.floor(Number(mode) || 0));
  }

  /**
   * Upload the radio fixtures.
   *
   * @param {Array<{x:number,y:number,radius:number,gpuId:number,color:number[]}>} sources
   *   shader-frame centres on the disc plane, patch radius, integer id, linear rgb
   * @param {number} [mask] bit i enables slot i; defaults to every uploaded slot
   */
  function setRadio(sources, mask) {
    const list = Array.isArray(sources) ? sources.slice(0, RADIO_SLOTS) : [];
    radioCount = list.length;
    for (let i = 0; i < RADIO_SLOTS; i += 1) {
      const geom = uniforms.uRadioGeom.value[i];
      const color = uniforms.uRadioColor.value[i];
      const source = list[i];
      if (!source) {
        geom.set(0, 0, 0, 0);
        color.set(0, 0, 0);
        continue;
      }
      geom.set(
        Number(source.x) || 0,
        Number(source.y) || 0,
        Math.max(0, Number(source.radius) || 0),
        Number(source.gpuId) || 0,
      );
      const rgb = Array.isArray(source.color) ? source.color : [0, 0, 0];
      color.set(Number(rgb[0]) || 0, Number(rgb[1]) || 0, Number(rgb[2]) || 0);
    }
    const full = radioCount > 0 ? (1 << radioCount) - 1 : 0;
    radioMask = typeof mask === 'number' ? mask & full : full;
    uniforms.uRadioCount.value = radioCount;
    uniforms.uRadioMask.value = radioMask;
  }

  /** Which slots are currently enabled, and what was uploaded. */
  function getRadio() {
    return {
      count: radioCount,
      mask: radioMask,
      sources: uniforms.uRadioGeom.value.slice(0, radioCount).map((geom, index) => ({
        x: geom.x,
        y: geom.y,
        radius: geom.z,
        gpuId: geom.w,
        color: uniforms.uRadioColor.value[index].toArray(),
      })),
    };
  }

  function getInfo() {
    return {
      ...tables.info,
      inner: DISK_INNER,
      outer: DISK_OUTER,
      isco: ISCO_RADIUS,
      probeMode: uniforms.uProbeMode.value,
      radio: getRadio(),
      radioGain: uniforms.uRadioGain.value,
    };
  }

  /**
   * Render one probe frame into an offscreen float target and read the packed
   * values back.
   *
   * The JS validator in tools/validate-imaging.mjs mirrors the lookup chain, so
   * on its own it can only prove the mirror is self-consistent. This runs the
   * shader that actually draws the panel, through the same renderer, and hands
   * the numbers to that validator, so the two implementations are compared
   * against each other rather than against themselves.
   *
   * `probe` overrides the camera the shader sees, so a test can place the eye at
   * an exact radius and direction instead of driving the orbit controls. `eye`,
   * `forward`, `right` and `up` are in shader units (horizon = 1), which is the
   * world position divided by RS.
   *
   * @returns {{width:number, height:number, data:Float32Array}} unpacked floats,
   *   row 0 at the bottom (readRenderTargetPixels order).
   */
  function probe(probeOptions) {
    const opts = probeOptions || {};
    if (disposed || !renderer) return null;
    // A region reads an exact sub-rectangle of the frame at full pixel density,
    // which is what a click test and a centroid refinement need. It assumes
    // uViewport already holds the full drawing-buffer size.
    const region =
      opts.region && Number(opts.region.width) > 0 && Number(opts.region.height) > 0
        ? {
            x: Math.max(0, Math.floor(opts.region.x || 0)),
            y: Math.max(0, Math.floor(opts.region.y || 0)),
            width: Math.max(1, Math.floor(opts.region.width)),
            height: Math.max(1, Math.floor(opts.region.height)),
          }
        : null;
    const width = region ? region.width : Math.max(1, Math.floor(opts.width || 1));
    const height = region ? region.height : Math.max(1, Math.floor(opts.height || 1));
    const mode = Math.max(0, Math.floor(opts.mode || 0));
    if (mode <= 0) return null;

    const prevTarget = renderer.getRenderTarget();
    const prevMode = uniforms.uProbeMode.value;
    const prevOpacity = uniforms.uOpacity.value;
    const prevViewport = uniforms.uViewport.value.clone();
    const prevCam = uniforms.uCamPos.value;
    const prevRight = uniforms.uCamRight.value;
    const prevUp = uniforms.uCamUp.value;
    const prevFwd = uniforms.uCamForward.value;
    const prevTan = uniforms.uTanHalfFov.value;
    const prevTime = uniforms.uTime.value;
    const prevVisible = object.visible;
    const prevRadioMask = uniforms.uRadioMask.value;
    const prevRect = uniforms.uProbeRect.value.clone();
    const prevBlending = material.blending;
    const prevColorSpace = renderer.outputColorSpace;
    const prevToneMapping = renderer.toneMapping;

    const target = new WebGLRenderTarget(width, height, {
      // probe mode emits packFloat(), whose four channels are the exact bytes of
      // the value. A byte target round-trips them unchanged; a float target would
      // be read back as gl.FLOAT and reinterpret those bytes as a number.
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    const packed = new Uint8Array(width * height * 4);

    try {
      // Linear, unfiltered output: the packed bytes must survive untouched.
      renderer.outputColorSpace = LinearSRGBColorSpace;
      renderer.toneMapping = NoToneMapping;
      material.blending = NoBlending;

      // A full-screen quad in a 1xN target: the fragment shader derives its
      // direction from gl_FragCoord, so the eye direction is what the caller
      // asks for, not what the orbit camera happens to be at.
      if (opts.eye) {
        const eye = opts.eye;
        const forward = opts.forward || { x: 0, y: 0, z: 1 };
        const right = opts.right || { x: 1, y: 0, z: 0 };
        const up = opts.up || { x: 0, y: 1, z: 0 };
        const norm = (v) => {
          const len = Math.hypot(v.x, v.y, v.z) || 1;
          return [v.x / len, v.y / len, v.z / len];
        };
        // A position, not a direction: length(uCamPos) IS the observer radius.
        uniforms.uCamPos.value = [Number(eye.x) || 0, Number(eye.y) || 0, Number(eye.z) || 0];
        uniforms.uCamForward.value = norm(forward);
        uniforms.uCamRight.value = norm(right);
        uniforms.uCamUp.value = norm(up);
      }

      if (region) {
        uniforms.uProbeRect.value.set(region.x, region.y, region.width, region.height);
      } else {
        uniforms.uViewport.value.set(width, height);
      }
      uniforms.uProbeMode.value = mode;
      // Per-source isolation: a probe can read one fixture without re-uploading.
      if (typeof opts.radioMask === 'number') uniforms.uRadioMask.value = opts.radioMask;
      uniforms.uOpacity.value = 1;
      // Deterministic state for reproducibility: the texture field depends on the
      // retarded time, so a probe at a wall-clock time is not repeatable. Both are
      // overridable so the harness can pin the exact instant and projection.
      if (typeof opts.time === 'number') uniforms.uTime.value = opts.time;
      if (typeof opts.tanHalfFov === 'number') uniforms.uTanHalfFov.value = opts.tanHalfFov;
      object.visible = true;

      // Render the imaging quad alone: the probe asks what THIS shader computes,
      // so no other object in the stage may contribute.
      const parent = object.parent;
      probeScene.add(object);
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(probeScene, probeCamera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, packed);
      if (parent) parent.add(object);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.outputColorSpace = prevColorSpace;
      renderer.toneMapping = prevToneMapping;
      material.blending = prevBlending;
      uniforms.uProbeMode.value = prevMode;
      uniforms.uOpacity.value = prevOpacity;
      uniforms.uViewport.value.copy(prevViewport);
      uniforms.uCamPos.value = prevCam;
      uniforms.uCamRight.value = prevRight;
      uniforms.uCamUp.value = prevUp;
      uniforms.uCamForward.value = prevFwd;
      uniforms.uTanHalfFov.value = prevTan;
      uniforms.uTime.value = prevTime;
      uniforms.uRadioMask.value = prevRadioMask;
      uniforms.uProbeRect.value.copy(prevRect);
      object.visible = prevVisible;
      target.dispose();
    }

    const pixels = width * height;
    const out = new Float32Array(pixels);
    if (opts.unpack === 'fast') {
      // Same decode as the loop below, without a DataView per pixel: reassemble
      // the four bytes packFloat wrote (most significant first) and read the bit
      // pattern back as a float32. Used by the full-frame id scans.
      const scratch = new ArrayBuffer(4);
      const bytes = new Uint8Array(scratch);
      const floats = new Float32Array(scratch);
      for (let i = 0; i < pixels; i += 1) {
        const o = i * 4;
        bytes[0] = packed[o + 3];
        bytes[1] = packed[o + 2];
        bytes[2] = packed[o + 1];
        bytes[3] = packed[o];
        out[i] = floats[0];
      }
      return { width, height, data: out };
    }
    for (let i = 0; i < pixels; i++) {
      const r = packed[i * 4] / 255;
      const g = packed[i * 4 + 1] / 255;
      const b = packed[i * 4 + 2] / 255;
      const a = packed[i * 4 + 3] / 255;
      const buf = new ArrayBuffer(4);
      const view = new DataView(buf);
      view.setUint8(0, Math.round(r * 255));
      view.setUint8(1, Math.round(g * 255));
      view.setUint8(2, Math.round(b * 255));
      view.setUint8(3, Math.round(a * 255));
      out[i] = view.getFloat32(0, false);
    }
    return { width, height, data: out };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    geometry.dispose();
    material.dispose();
    tables.dispose();
  }

  return {
    object,
    update,
    setViewport,
    setOpacity,
    setRingIntensity,
    setProbeMode,
    setRadio,
    getRadio,
    getInfo,
    probe,
    dispose,
    /** Exposed so a verification harness can ask gl.isTexture() after dispose. */
    tables,
    info: tables.info,
  };
}

export default createAccretionDisk;
