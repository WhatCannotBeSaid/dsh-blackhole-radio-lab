/**
 * Decode the precomputed null-geodesic tables into GPU textures.
 *
 * The shipped bytes (src/scene/ray-tables.data.js) are uint16 per channel,
 * normalised per channel by the generator, then base64'd so they travel inside
 * the plugin's own chunk. That keeps the payload at ~1.4 MB of script instead of
 * 2.1 MB of binary, avoids a second HTTP route, and still resolves far more
 * precision than the table itself has (measured max abs error 1.1e-4 on the
 * angle channel, 1.14e-3 on the time channel; see the numerical report).
 *
 * PRECISION ON THE GPU.
 * The tables are meant to be read with bilinear filtering. Bilinear filtering of
 * a 16-bit value split across two 8-bit channels is wrong, and RG16F (half
 * float) only has 11 mantissa bits -- at a deflection magnitude of ~149 that is
 * an absolute error near 0.07, which would dwarf the table's own error. So the
 * decode target is RG32F:
 *
 *   - if OES_texture_float_linear is present, the texture is filtered in
 *     hardware (LinearFilter) and the shader does one fetch per lookup;
 *   - otherwise the texture is RG32F + NearestFilter and the shader does its own
 *     bilinear interpolation (four fetches). Same values, slower.
 *
 * RG32F sampling (as opposed to rendering into it) is core WebGL2, so the
 * fallback needs no extension at all. The two paths are cross-checked against
 * each other and against the CPU reference.
 */

import { DataTexture, FloatType, LinearFilter, NearestFilter, RGFormat, ClampToEdgeWrapping } from 'three';
import { RAY_TABLES, RAY_TABLES_REVISION } from './ray-tables.data.js';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Lookup table from char code to 6-bit value, built once. */
const B64 = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64.length; i += 1) table[BASE64.charCodeAt(i)] = i;
  return table;
})();

/**
 * Decode base64 into bytes without Buffer (this runs in the browser).
 * @param {string} text
 * @returns {Uint8Array}
 */
function decodeBase64(text) {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(byteLength);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const v = B64[clean.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (acc >> bits) & 0xff;
      o += 1;
    }
  }
  return o === byteLength ? out : out.subarray(0, o);
}

/**
 * Turn one uint16 table into an RG32F DataTexture.
 * @param {{width:number,height:number,scale:number[],data:string}} spec
 * @param {boolean} hardwareFilter - true when float textures filter in hardware.
 */
function makeTableTexture(spec, hardwareFilter) {
  const bytes = decodeBase64(spec.data);
  const expected = spec.width * spec.height * 2 * 2;
  if (bytes.byteLength !== expected) {
    throw new Error(
      `ray-tables: ${spec.width}x${spec.height} needs ${expected} bytes, decoded ${bytes.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = spec.width * spec.height;
  const pixels = new Float32Array(count * 2);
  const sx = spec.scale[0];
  const sy = spec.scale[1];
  for (let i = 0; i < count; i += 1) {
    pixels[i * 2] = (view.getUint16(i * 4, true) / 65535) * sx;
    pixels[i * 2 + 1] = (view.getUint16(i * 4 + 2, true) / 65535) * sy;
  }
  const texture = new DataTexture(
    pixels,
    spec.width,
    spec.height,
    RGFormat,
    FloatType,
  );
  texture.magFilter = hardwareFilter ? LinearFilter : NearestFilter;
  texture.minFilter = hardwareFilter ? LinearFilter : NearestFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  texture.name = `bhrl.ray-table.${spec.width}x${spec.height}`;
  texture.userData = { decodedBytes: pixels.byteLength, quantisedBytes: bytes.byteLength };
  return texture;
}

/**
 * Detect whether 32-bit float textures can be linearly filtered.
 * @param {*} renderer - three.js WebGLRenderer
 */
function detectFloatLinear(renderer) {
  const gl = renderer && typeof renderer.getContext === 'function' ? renderer.getContext() : null;
  if (!gl) return false;
  try {
    return Boolean(gl.getExtension('OES_texture_float_linear'));
  } catch (error) {
    return false;
  }
}

/**
 * Build both table textures plus the capability record the shader needs.
 *
 * @param {*} renderer - three.js WebGLRenderer, used for capability detection.
 * @returns {{deflection: *, inverseRadius: *, hardwareFilter: boolean, info: object}}
 */
export function createRayTables(renderer) {
  const hardwareFilter = detectFloatLinear(renderer);
  const deflection = makeTableTexture(RAY_TABLES.deflection, hardwareFilter);
  const inverseRadius = makeTableTexture(RAY_TABLES.inverse_radius, hardwareFilter);
  return {
    deflection,
    inverseRadius,
    hardwareFilter,
    info: {
      revision: RAY_TABLES_REVISION,
      hardwareFilter,
      /** 0 when the shader must interpolate by hand. */
      filterMode: hardwareFilter ? 'hardware-bilinear' : 'shader-bilinear',
      deflection: {
        width: RAY_TABLES.deflection.width,
        height: RAY_TABLES.deflection.height,
        scale: RAY_TABLES.deflection.scale.slice(),
        maxAbsError: RAY_TABLES.deflection.maxAbsError.slice(),
        channels: RAY_TABLES.deflection.channels.slice(),
        coordinates: RAY_TABLES.deflection.coordinates.slice(),
      },
      inverseRadius: {
        width: RAY_TABLES.inverse_radius.width,
        height: RAY_TABLES.inverse_radius.height,
        scale: RAY_TABLES.inverse_radius.scale.slice(),
        maxAbsError: RAY_TABLES.inverse_radius.maxAbsError.slice(),
        channels: RAY_TABLES.inverse_radius.channels.slice(),
        coordinates: RAY_TABLES.inverse_radius.coordinates.slice(),
      },
    },
  };
}

/** The upstream dimensions, needed as GLSL constants. */
export const TABLE_SIZES = Object.freeze({
  deflection: Object.freeze({
    width: RAY_TABLES.deflection.width,
    height: RAY_TABLES.deflection.height,
  }),
  inverseRadius: Object.freeze({
    width: RAY_TABLES.inverse_radius.width,
    height: RAY_TABLES.inverse_radius.height,
  }),
});
