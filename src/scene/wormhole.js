/**
 * The wormhole transition overlay.
 *
 * One screen-space pass that draws a single black circle at any radius, plus the
 * light that lives on its edge. Nothing here traces a geodesic or touches the
 * imaging pass: the circle is a mask with a soft edge, so the same code draws
 *
 *   entry   the shadow's own outline, growing until it covers the frame;
 *   exit    full coverage, shrinking until it lands back on the shadow.
 *
 * Because the circle is painted over the finished frame, the handover needs no
 * cooperation from the other parts: when its radius equals the real shadow the
 * two agree pixel for pixel, which is where the transition starts and ends.
 *
 * The light on the edge is the transition's only "effect". A thin warm annulus
 * (`uRim`) tracks the circle exactly, and radial rays (`uStreak`) fan outward
 * from its centre, so the frame reads as matter falling in and being smeared
 * rather than as a wipe or a flash. Both are drawn premultiplied: the black is
 * a mask, the light is added on top of whatever the pass sits over.
 */

import { Mesh, NormalBlending, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform vec2 uCenter;
uniform float uAspect;
uniform float uRadius;
uniform float uEdge;
uniform float uAlpha;
uniform float uStreak;
uniform float uRim;
uniform float uTime;

void main() {
  // Height-relative coordinates: x is scaled by the aspect so the circle stays
  // a circle in any window shape, and y is already 0..1.
  vec2 p = (vUv - uCenter) * vec2(uAspect, 1.0);
  float d = length(p);
  float soft = max(uEdge, 0.0015);

  // The mask. 1 inside, 0 outside, one soft band in between.
  float disc = 1.0 - smoothstep(uRadius - soft, uRadius + soft, d);
  float alpha = clamp(disc * uAlpha, 0.0, 1.0);

  // The rim: a warm annulus centred on the edge itself.
  float band = (d - uRadius) / (soft * 1.6);
  float rim = exp(-band * band) * uRim;

  // The smear: a warm glow that tightens onto the edge, with slow lobes rather
  // than thin spokes. Evenly spaced needles read as a machined wheel; gas being
  // dragged into a horizon reads as broad, slightly unequal lobes that crawl.
  float ang = atan(p.y, p.x);
  float warp = 1.8 * sin(ang * 3.0 + uTime * 0.4) + 0.9 * sin(ang * 7.0 - uTime * 0.7);
  float lobes = pow(max(sin(ang * 5.0 + warp * 0.35 + uTime * 0.5), 0.0), 2.0);
  float fine = 0.55 + 0.45 * sin(ang * 13.0 + warp + uTime * 0.9);
  float inner = smoothstep(uRadius * 0.72, uRadius * 0.99, d);
  float outer = 1.0 - smoothstep(uRadius * 0.995, uRadius * 1.10, d);
  float streaks = lobes * fine * inner * outer * uStreak;

  vec3 warm = vec3(1.0, 0.66, 0.34);
  vec3 emissive = warm * (rim * 0.6 + streaks * 0.42);

  // Premultiplied: rgb is light to add, a is how much of the frame to replace
  // with black. Multiplied out by the blend function, not by the shader.
  gl_FragColor = vec4(emissive, alpha);
}
`;

export function createWormhole() {
  const uniforms = {
    uCenter: { value: new Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uRadius: { value: 0.1 },
    uEdge: { value: 0.012 },
    uAlpha: { value: 0 },
    uStreak: { value: 0 },
    uRim: { value: 0 },
    uTime: { value: 0 },
  };

  const material = new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    premultipliedAlpha: true,
    blending: NormalBlending,
    depthTest: false,
    depthWrite: false,
  });
  material.name = 'bhrl.wormhole';

  const geometry = new PlaneGeometry(2, 2, 1, 1);
  const object = new Mesh(geometry, material);
  object.name = 'bh-wormhole';
  object.frustumCulled = false;
  // After the imaging pass (-10), the starfield (-1) and the stations: this is
  // the last thing painted, so it can cover any of them.
  object.renderOrder = 20;
  object.visible = false;

  let alpha = 0;
  let streak = 0;

  /**
   * @param frame.center - the circle's centre in uv space (0..1, y up).
   * @param frame.radius - the circle's radius, in viewport heights.
   * @param frame.alpha - 0 hides the mask; 1 is opaque black.
   * @param frame.streak - 0..1 radial light inside the annulus.
   * @param frame.rim - 0..1 light on the edge itself.
   */
  function setPhase(frame) {
    if (!frame) return;
    const center = frame.center || { x: 0.5, y: 0.5 };
    uniforms.uCenter.value.set(center.x, center.y);
    uniforms.uRadius.value = Math.max(0, Number(frame.radius) || 0);
    uniforms.uAlpha.value = clamp01(frame.alpha);
    uniforms.uStreak.value = clamp01(frame.streak);
    uniforms.uRim.value = clamp01(frame.rim);
    if (Number.isFinite(frame.edge)) uniforms.uEdge.value = Math.max(0.0015, frame.edge);
    alpha = uniforms.uAlpha.value;
    streak = uniforms.uStreak.value;
    object.visible = alpha > 0.002 || streak > 0.002 || uniforms.uRim.value > 0.002;
  }

  function setViewport(width, height) {
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    uniforms.uAspect.value = w / h;
  }

  function update(dt) {
    if (!object.visible) return false;
    uniforms.uTime.value += Math.max(0, Math.min(0.1, Number(dt) || 0));
    return true;
  }

  function reset() {
    uniforms.uAlpha.value = 0;
    uniforms.uStreak.value = 0;
    uniforms.uRim.value = 0;
    alpha = 0;
    streak = 0;
    object.visible = false;
  }

  return {
    object,
    setPhase,
    setViewport,
    update,
    reset,
    get active() {
      return object.visible;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
