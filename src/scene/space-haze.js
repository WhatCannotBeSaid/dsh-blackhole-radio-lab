/**
 * The sky the whole frame lives in.
 *
 * The hole's passage renders a full-sky diffuse behind its lensed image:
 * `backgroundDiffuse` in geodesic.glsl.js draws the faint blue floor, the broad
 * nebula patches and the galactic band that every direction shows. That pass is
 * part of the imaging quad, so it only exists while the hole does — the cluster
 * and nebula forms have no such sky, and the same space used to end in the flat
 * #030408 clear colour. Crossing between them read as changing room rather than
 * changing shape.
 *
 * This layer draws that same sky as ordinary geometry underneath everything
 * else. The hole's quad still paints its own lensed copy on top (it is opaque),
 * so nothing about the hole changes; the other forms let this one through. One
 * function, one set of colours, so the background is continuous in every form.
 *
 * Colours are deliberately identical to the imaging pass: same `backgroundDiffuse`,
 * same ACES curve, same sRGB transfer, same exposure. A pixel behind the cluster
 * lands on the same value a pixel behind the lensed sky would have.
 */

import { DoubleSide, Mesh, PlaneGeometry, NormalBlending, RawShaderMaterial, Vector2 } from 'three';
import { GLSL3 } from 'three';
import { IMAGING_CONSTANTS } from './geodesic.glsl.js';

const VERTEX_SHADER = `precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const FRAGMENT_SHADER = `precision highp float;

uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uViewport;
uniform float uTanHalfFov;
uniform float uExposure;
uniform float uOpacity;

out vec4 fragColor;

// ---------------------------------------------------------------------------
// The same value noise and fbm the imaging pass uses. Copied rather than
// imported because the sky has to be the SAME field: a second, similar-looking
// noise would drift against the lensed copy at the hand-over.
// ---------------------------------------------------------------------------
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 fr = fract(p);
  vec3 u = fr * fr * (3.0 - 2.0 * fr);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 4; k++) {
    sum += amp * valueNoise(p);
    p = p * 2.03 + vec3(11.3, 7.7, 3.1);
    amp *= 0.5;
  }
  return sum / 0.9375;
}

// ---------------------------------------------------------------------------
// The sky, exactly as the imaging pass draws it: ambient + veil + galactic
// band, straight from backgroundDiffuse. The band belongs here because the
// camera no longer swings on the crossing: both forms look at the same
// direction of the same sky, so the band lands where the hole's lensed copy
// already put it.
// ---------------------------------------------------------------------------
vec3 backgroundDiffuse(vec3 dir) {
  vec3 bandNormal = normalize(vec3(0.34, 0.86, -0.38));
  float band = exp(-pow(dot(dir, bandNormal) / 0.42, 2.0));
  float mottle = fbm3(dir * 3.4);
  float mottle2 = fbm3(dir * 9.0 + vec3(2.2, 8.8, 4.4));
  vec3 bandColor = vec3(0.045, 0.056, 0.090) * band * (0.55 + 0.70 * mottle)
                 + vec3(0.024, 0.021, 0.033) * band * mottle2 * 0.6;
  vec3 ambient = vec3(0.0075, 0.0088, 0.0145) * (0.62 + 0.85 * mottle);
  float nebula = fbm3(dir * 1.35 + vec3(-5.3, 2.7, 8.1));
  float veil = smoothstep(0.26, 0.88, 0.72 * nebula + 0.28 * mottle);
  vec3 veilColor = vec3(0.0190, 0.0180, 0.0280) * veil * (0.45 + 0.55 * mottle2);
  return ambient + veilColor + bandColor;
}

// ACES filmic + sRGB transfer, matching three.js r186 and the imaging pass.
vec3 acesFilmic(vec3 color) {
  const mat3 inputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 outputMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color *= uExposure / 0.6;
  color = inputMat * color;
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  color = outputMat * (a / b);
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92,
             vec3(lessThanEqual(c, vec3(0.0031308))));
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
  float aspect = uViewport.x / uViewport.y;
  vec3 dir = normalize(
    uCamForward +
    uCamRight * (ndc.x * uTanHalfFov * aspect) +
    uCamUp * (ndc.y * uTanHalfFov));
  vec3 color = linearToSrgb(acesFilmic(backgroundDiffuse(dir)));
  fragColor = vec4(color, uOpacity);
}
`;

/**
 * Build the shared sky layer.
 * @param options - `{ renderer }`, used only to read the drawing-buffer size.
 */
export function createSpaceHaze(options = {}) {
  const { renderer } = options;

  const uniforms = {
    uCamRight: { value: [1, 0, 0] },
    uCamUp: { value: [0, 1, 0] },
    uCamForward: { value: [0, 0, -1] },
    uViewport: { value: new Vector2(1, 1) },
    uTanHalfFov: { value: Math.tan((42 * Math.PI) / 360) },
    uExposure: { value: IMAGING_CONSTANTS.EXPOSURE },
    uOpacity: { value: 1 },
  };

  const material = new RawShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    glslVersion: GLSL3,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: NormalBlending,
    side: DoubleSide,
  });
  material.name = 'bhrl.space-haze';

  // The quad exists only so the pass has vertices: the vertex shader writes
  // clip space directly, exactly like the imaging pass.
  const geometry = new PlaneGeometry(2, 2, 1, 1);
  const drawBuffer = new Vector2();
  const camRight = [0, 0, 0];
  const camUp = [0, 0, 0];
  const camFwd = [0, 0, 0];

  const object = new Mesh(geometry, material);
  object.renderOrder = -20;
  object.frustumCulled = false;
  object.name = 'bhrl.space-haze';

  const toShader = (x, y, z, out) => {
    // Same (x, -z, y) frame as the hole pass; normalize() removes the RS scale.
    out[0] = Number(x) || 0;
    out[1] = -(Number(z) || 0);
    out[2] = Number(y) || 0;
    return out;
  };

  function update(time, camera, frame) {
    if (!camera) return;
    if (!frame) camera.updateMatrixWorld();
    const e = frame ? frame.elements : camera.matrixWorld.elements;
    toShader(e[0], e[1], e[2], camRight);
    toShader(e[4], e[5], e[6], camUp);
    toShader(-e[8], -e[9], -e[10], camFwd);
    uniforms.uCamRight.value = camRight;
    uniforms.uCamUp.value = camUp;
    uniforms.uCamForward.value = camFwd;
    uniforms.uTanHalfFov.value = frame ? frame.tanHalfFov : Math.tan((camera.fov * Math.PI) / 360);
    if (renderer) {
      if (!frame) renderer.getDrawingBufferSize(drawBuffer);
      const size = frame ? frame.viewport : drawBuffer;
      uniforms.uViewport.value.set(size.x, size.y);
    }
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
  }

  return { object, update, dispose };
}
