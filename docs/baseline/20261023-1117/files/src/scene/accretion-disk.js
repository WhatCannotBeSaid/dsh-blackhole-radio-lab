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
  WebGLRenderTarget,
  GLSL3,
} from 'three';
import { RS, DISK_INNER, DISK_OUTER, ISCO_RADIUS } from './dimensions.js';
import { buildFragmentShader, VERTEX_SHADER, IMAGING_CONSTANTS } from './geodesic.glsl.js';
import { createRayTables } from './ray-tables.js';

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

  function getInfo() {
    return {
      ...tables.info,
      inner: DISK_INNER,
      outer: DISK_OUTER,
      isco: ISCO_RADIUS,
      probeMode: uniforms.uProbeMode.value,
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
    const width = Math.max(1, Math.floor(opts.width || 1));
    const height = Math.max(1, Math.floor(opts.height || 1));
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

      uniforms.uViewport.value.set(width, height);
      uniforms.uProbeMode.value = mode;
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
      object.visible = prevVisible;
      target.dispose();
    }

    const out = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
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
    getInfo,
    probe,
    dispose,
    info: tables.info,
  };
}

export default createAccretionDisk;
