/**
 * The wormhole crossing.
 *
 * One full-screen pass that raymarches the inside of a tube whose radius
 * pinches at the throat and opens again at the far mouth, with the camera
 * accelerating down its axis. The wall is shaded procedurally — warm rim,
 * drifting dust filaments, a light source at the far mouth — so the depth is
 * real geometry, not a radial wipe: streaks slide past the camera, the throat
 * closes in, and the exit is a growing point of light that eventually sweeps
 * past the frame edges and hands the picture back to whatever is behind it.
 *
 * The seam with the real scene is handled by two alpha cuts, both driven from
 * outside:
 *
 * - `mouth` grows from the black hole's shadow to past the screen corners, so
 *   the tunnel is revealed exactly inside the hole and never as a rectangle.
 * - `exitR` opens a hole in the middle of the tube. Inside that hole alpha is
 *   zero, which is what lets the destination scene show through while the bright
 *   ring rushes outward over it. No render target, no cross-fade of the wrong
 *   picture.
 *
 * Everything is a scalar set per frame; all timing lives in stage.js.
 */

import { Mesh, NormalBlending, PlaneGeometry, ShaderMaterial } from 'three';

/** Screen-space normal, so the tube is shaded rather than merely tinted. */
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

  uniform vec2 uResolution;
  uniform vec2 uCenter;
  uniform float uShadow;
  uniform float uMouth;
  uniform float uAlpha;
  uniform float uStreak;
  uniform float uRim;
  uniform float uProgress;
  uniform float uThroat;
  uniform float uExitR;
  uniform float uExitGlow;
  uniform float uExitAlpha;
  uniform float uTime;

  const float PI = 3.14159265;
  const float STEPS = 44.0;
  // Length of the tube in world units, and where the camera sits along it.
  const float TUBE_LEN = 2.6;
  const float MOUTH_R = 0.62;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // The tube radius at a distance along the axis. The pinch is the throat:
  // deepest at the middle of the crossing, gone at both mouths.
  float tubeRadius(float along) {
    float t = clamp(along, 0.0, 1.0);
    float pinch = sin(t * PI);
    return mix(1.0, 1.0 - uThroat, pinch * pinch);
  }

  void main() {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 rel = vec2((vUv.x - uCenter.x) * aspect, vUv.y - uCenter.y);
    float dist = length(rel);

    // Where the tunnel is allowed to exist on screen.
    float soft = max(0.012, uMouth * 0.16);
    float mouthMask = 1.0 - smoothstep(uMouth - soft, uMouth + soft, dist);

    if (mouthMask <= 0.001 && uExitAlpha <= 0.001) discard;

    // Camera looks down -z and travels from the near mouth toward the far one,
    // so the visible slice of tube slides past it.
    float cameraZ = uProgress * TUBE_LEN;
    vec3 dir = normalize(vec3(rel * 1.9, -1.0));
    vec3 origin = vec3(0.0, 0.0, cameraZ);

    // The profile is tied to world z, not to the camera, or the tube would
    // travel with it and the crossing would have no parallax at all.
    // March: the ray starts inside the tube (the mouth is open) and the first
    // sample that leaves it is the wall.
    float span = (TUBE_LEN + 1.4) / max(-dir.z, 0.2);
    float stepLen = span / STEPS;
    float hit = -1.0;
    float glow = 0.0;
    float dust = 0.0;

    for (float i = 0.0; i < STEPS; i += 1.0) {
      float t = (i + 0.5) * stepLen;
      vec3 pos = origin + dir * t;
      float along = clamp(-pos.z / TUBE_LEN, 0.0, 1.0);
      float radius = MOUTH_R * tubeRadius(along);
      float radial = length(pos.xy);

      if (radial > radius) {
        hit = t;
        break;
      }

      // Volumetric haze inside the tube: cheap value noise drifting backward so
      // the interior reads as moving dust rather than a painted gradient.
      float flow = -pos.z * 4.0 - uTime * 1.6;
      float motes = noise(vec2(atan(pos.y, pos.x) * 2.2, flow * 1.7));
      dust += motes * 0.016 * smoothstep(0.0, 0.3, along);
      glow += 0.014 * smoothstep(0.05, 1.0, along);
    }

    vec3 warm = vec3(1.0, 0.66, 0.34);
    vec3 colour = vec3(0.0);

    if (hit > 0.0) {
      // Wall shading: radial normal, warmed where the wall is edge-on to the
      // camera, which is what gives a tube its sense of roundness.
      vec3 pos = origin + dir * hit;
      float along = clamp(-pos.z / TUBE_LEN, 0.0, 1.0);
      float angle = atan(pos.y, pos.x);
      vec2 radialDir = normalize(pos.xy + vec2(1e-5));
      // Slope of the profile so the throat's inward taper catches light too.
      float taper = (tubeRadius(along + 0.02) - tubeRadius(along - 0.02)) * 6.0;
      vec3 normal = normalize(vec3(radialDir, taper));
      float facing = clamp(dot(-dir, normal), 0.0, 1.0);
      float edge = pow(1.0 - facing, 2.4);

      // Filaments along the wall, stretched by the crossing speed.
      float lanes = noise(vec2(angle * 3.0 + uTime * 0.05, pos.z * 3.4 + uTime * 1.9));
      float fine = noise(vec2(angle * 11.0, pos.z * 7.0 + uTime * 3.1));
      float streaks = pow(lanes, 3.0) * 0.7 + pow(fine, 4.0) * 0.5;

      // Depth falloff: the near mouth is brightest, the throat dims.
      float depth = 1.0 - smoothstep(0.0, 1.0, along);
      colour = warm * (0.02 + edge * 0.34 * uRim) * (0.40 + depth * 0.60);
      colour += warm * streaks * uStreak * 0.20 * (0.25 + depth);
      colour += warm * glow * 1.9;
    }

    colour += warm * dust * uStreak;

    // Converging filaments at the mouth.
    //
    // A ray that never meets the wall marbled nothing: it leaves a flat disc of
    // haze, which reads as paint. Real dust in a throat lines up along the
    // fall, so the last term is angular — spokes that pinched toward the centre
    // and fade out before they reach it, brightest just inside the rim.
    {
      float ang = atan(rel.y, rel.x);
      float rim = smoothstep(0.04, uMouth * 0.55, dist) * (1.0 - smoothstep(uMouth * 0.62, uMouth * 0.98, dist));
      float spokes = noise(vec2(ang * 13.0, dist * 5.0 - uTime * 1.1));
      spokes *= noise(vec2(ang * 27.0 + 3.1, dist * 2.4 + uTime * 0.4));
      spokes = pow(clamp(spokes, 0.0, 1.0), 1.5);
      colour += warm * spokes * rim * 0.9 * uStreak;
    }

    // The far mouth: a point of light that grows until it is the whole picture.
    float axisDist = length(rel);
    float exitSafe = max(uExitR, 0.001);
    // A filled disc, not a hole: looking down the tube the far mouth is the
    // one thing that is always lit, so the crossing has somewhere to head.
    // A ring reads as an event, not as distance. Its radius stops growing at
    // 0.55: past that the light becomes a wall, and a wall is a flashbulb.
    float coreR = min(exitSafe, 0.55);
    float exitCore = 1.0 - smoothstep(coreR * 0.22, coreR, axisDist);
    exitCore *= (0.30 + 0.70 * (1.0 - smoothstep(0.0, coreR, axisDist))) * uExitGlow;
    // Warm and dim: the far mouth is a light, not a flashbulb. The landing is
    // carried by the ring sweeping past the lens, plus the veil dissolving.
    colour += vec3(1.0, 0.86, 0.70) * exitCore * 0.85;

    // The ring that sweeps past the camera at the exit. Thin, because a wide
    // band of white is a wash whatever its brightness.
    float ringWidth = clamp(exitSafe * 0.12, 0.02, 0.07);
    float ring = exp(-pow((axisDist - exitSafe) / ringWidth, 2.0)) * uExitAlpha;
    colour += vec3(1.0, 0.93, 0.84) * ring * 0.8;

    // Alpha: the tunnel covers only its mouth, minus the hole the exit has
    // already opened in it.
    float exitHole = smoothstep(exitSafe * 0.72, exitSafe * 1.06, dist) * uExitAlpha;
    float alpha = mouthMask * uAlpha * (1.0 - exitHole);
    // The ring itself is opaque even where the hole has opened.
    alpha = max(alpha, clamp(ring, 0.0, 1.0) * uAlpha);

    if (alpha <= 0.002) discard;

    vec3 premultiplied = colour * alpha;
    gl_FragColor = vec4(premultiplied, alpha);
  }
`;

/**
 * @param options - { reducedMotion? }
 */
export function createWormhole(options = {}) {
  const uniforms = {
    uResolution: { value: [1, 1] },
    uCenter: { value: [0.5, 0.5] },
    uShadow: { value: 0.1 },
    uMouth: { value: 0 },
    uAlpha: { value: 0 },
    uStreak: { value: 0 },
    uRim: { value: 0 },
    uProgress: { value: 0 },
    uThroat: { value: 0.55 },
    uExitR: { value: 0 },
    uExitGlow: { value: 0 },
    uExitAlpha: { value: 0 },
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
    fog: false,
  });

  const object = new Mesh(new PlaneGeometry(2, 2, 1, 1), material);
  object.frustumCulled = false;
  object.renderOrder = 20;
  object.visible = false;
  object.name = 'wormhole';

  let alive = true;
  let phase = null;

  return {
    object,

    setViewport(width, height) {
      uniforms.uResolution.value[0] = Math.max(1, width);
      uniforms.uResolution.value[1] = Math.max(1, height);
    },

    /**
     * @param frame - {
     *   center: {x, y} in uv space, y up;
     *   shadow: black hole radius as a fraction of viewport height;
     *   mouth: tunnel mouth radius, same unit;
     *   alpha, streak, rim: 0..1;
     *   progress: 0..1 along the axes;
     *   throat: pinch depth;
     *   exitR, exitGlow, exitAlpha: 0..1;
     * }
     */
    setPhase(frame) {
      if (!alive) return;
      phase = frame;
      const c = frame.center || { x: 0.5, y: 0.5 };
      uniforms.uCenter.value[0] = c.x;
      uniforms.uCenter.value[1] = c.y;
      uniforms.uShadow.value = frame.shadow || 0;
      uniforms.uMouth.value = Math.max(0, frame.mouth || 0);
      uniforms.uAlpha.value = frame.alpha || 0;
      uniforms.uStreak.value = frame.streak || 0;
      uniforms.uRim.value = frame.rim || 0;
      uniforms.uProgress.value = frame.progress || 0;
      uniforms.uThroat.value = frame.throat == null ? 0.55 : frame.throat;
      uniforms.uExitR.value = frame.exitR || 0;
      uniforms.uExitGlow.value = frame.exitGlow || 0;
      uniforms.uExitAlpha.value = frame.exitAlpha || 0;

      const peak = Math.max(
        uniforms.uAlpha.value,
        uniforms.uExitAlpha.value,
        uniforms.uExitGlow.value * 0.5,
        uniforms.uStreak.value * 0.6,
      );
      object.visible = peak > 0.002;
    },

    update(dt) {
      if (!alive) return;
      uniforms.uTime.value += Math.min(0.1, Math.max(0, dt || 0));
    },

    reset() {
      if (!alive) return;
      phase = null;
      object.visible = false;
      uniforms.uMouth.value = 0;
      uniforms.uAlpha.value = 0;
      uniforms.uStreak.value = 0;
      uniforms.uRim.value = 0;
      uniforms.uExitR.value = 0;
      uniforms.uExitGlow.value = 0;
      uniforms.uExitAlpha.value = 0;
      uniforms.uProgress.value = 0;
    },

    get active() {
      return object.visible;
    },

    get phase() {
      return phase;
    },

    dispose() {
      if (!alive) return;
      alive = false;
      object.visible = false;
      object.parent?.remove(object);
      object.geometry.dispose();
      material.dispose();
    },
  };
}

export default createWormhole;
