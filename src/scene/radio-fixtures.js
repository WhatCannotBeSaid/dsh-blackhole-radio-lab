/**
 * Phase-2 radio fixtures: four finite-size sources on the disc plane.
 *
 * These are NOT the station catalogue. The catalogue's 2,400 entries stay where
 * they are and keep their own projection; these four exist so the imaging pass
 * can be verified against a known source with a known business id, a known
 * radius and a known radiance. They are enabled only through an explicit test
 * switch (`?bhrlRadio=...` or `settings.radio`), and the default page never sees
 * them.
 *
 * MODELLING SCOPE. Every fixture is a flat disc of radius `patchRadius` lying in
 * the world plane y = 0, positioned by (r, phi) in world units where
 *
 *   x = r * sin(phi),  z = r * cos(phi)
 *
 * so phi is measured from +z towards +x, the same convention the camera rig and
 * the station layout use. Nothing here is a 3D source: a source off the disc
 * plane would need its own intersection solve and more than two images, which
 * this pipeline does not have.
 *
 * MOTION. All four are STATIC (no orbital velocity), which is why the shader uses
 * the static-observer shift g = sqrt(f_emit) / sqrt(f_cam) instead of the disc's
 * Keplerian formula. A source on a circular orbit would need the extra orbital
 * term; that is a phase-3 decision and is not silently approximated here.
 *
 * UNITS. The fixture record is in world units (b_crit = 1); `toShaderFixture`
 * converts to the trace's Schwarzschild frame with the same rotation the imaging
 * pass uses, (x, -z, y) / RS. Radius 0.04 world is 0.104 shader units, i.e.
 * slightly over two pixels across at the default camera.
 */

import { RS } from './dimensions.js';

/** Overall radiance of a fixture, relative to the disc's peak of about 0.28. */
export const RADIO_GAIN = 0.55;

/** Patch radius, world units. Matches the frozen phase-1 fixture spec. */
export const PATCH_RADIUS = 0.04;

/**
 * @typedef {object} RadioFixture
 * @property {string} businessId stable id returned by picking
 * @property {number} gpuId       integer written into the id channel (never 0)
 * @property {'near'|'far'|'axis'|'weak'} kind
 * @property {{zh: string, en: string}} label
 * @property {number} r          world radius of the patch centre
 * @property {number} phi        world azimuth, atan2(x, z)
 * @property {number} patchRadius world radius of the patch
 * @property {[number, number, number]} color linear radiance, gain excluded
 * @property {'static'} motion
 */

/** @type {ReadonlyArray<RadioFixture>} */
export const RADIO_FIXTURES = Object.freeze([
  Object.freeze({
    businessId: 'radio-near-side',
    gpuId: 101,
    kind: 'near',
    label: Object.freeze({ zh: '近侧源', en: 'Near side' }),
    r: 2.6,
    phi: 0.654698,
    patchRadius: PATCH_RADIUS,
    color: Object.freeze([1.0, 0.62, 0.28]),
    motion: 'static',
  }),
  Object.freeze({
    businessId: 'radio-far-side',
    gpuId: 102,
    kind: 'far',
    label: Object.freeze({ zh: '远侧源', en: 'Far side' }),
    r: 3.2,
    phi: 3.796291,
    patchRadius: PATCH_RADIUS,
    color: Object.freeze([0.30, 0.80, 1.0]),
    motion: 'static',
  }),
  Object.freeze({
    businessId: 'radio-near-axis',
    gpuId: 103,
    kind: 'axis',
    label: Object.freeze({ zh: '近轴源', en: 'Near axis' }),
    r: 1.6,
    phi: 3.246291,
    patchRadius: PATCH_RADIUS,
    color: Object.freeze([1.0, 0.30, 0.85]),
    motion: 'static',
  }),
  Object.freeze({
    businessId: 'radio-weak-field',
    gpuId: 104,
    kind: 'weak',
    label: Object.freeze({ zh: '弱场源', en: 'Weak field' }),
    r: 4.2,
    phi: 1.604698,
    patchRadius: PATCH_RADIUS,
    color: Object.freeze([0.45, 1.0, 0.45]),
    motion: 'static',
  }),
]);

/** World position of a fixture's patch centre (y is always 0). */
export function fixtureWorldPosition(fixture) {
  return {
    x: fixture.r * Math.sin(fixture.phi),
    y: 0,
    z: fixture.r * Math.cos(fixture.phi),
  };
}

/**
 * Convert a fixture into the record the shader consumes.
 *
 * The rotation is (x, -z, y) / RS, applied to the centre and to the radius. y is
 * zero for every fixture, so the shader-side centre is a 2-D point on z = 0.
 */
function toShaderFixture(fixture) {
  const world = fixtureWorldPosition(fixture);
  return {
    x: world.x / RS,
    y: -world.z / RS,
    radius: fixture.patchRadius / RS,
    gpuId: fixture.gpuId,
    color: fixture.color.slice(),
    businessId: fixture.businessId,
    kind: fixture.kind,
  };
}

/** Every fixture, already converted for the shader. */
export function shaderFixtures() {
  return RADIO_FIXTURES.map(toShaderFixture);
}

/**
 * Resolve the test switch into the fixture list it selects.
 *
 * Accepted spellings, case-insensitive and comma- or space-separated:
 *   ''            off (default)
 *   'all'         every fixture
 *   'near,far'    by kind
 *   'radio-far-side'  by business id
 *   '1' / 'true'  all, so a plain "enabled" flag still works
 *
 * @param {unknown} spec
 * @returns {RadioFixture[]}
 */
export function selectRadioFixtures(spec) {
  if (spec === undefined || spec === null || spec === false) return [];
  const text = String(spec).trim();
  if (text === '' || text === '0' || text === 'off' || text === 'false' || text === 'none') return [];
  const tokens = text
    .toLowerCase()
    .split(/[\s,;|]+/)
    .filter(Boolean);
  if (tokens.includes('all') || tokens.includes('1') || tokens.includes('true') || tokens.includes('on')) {
    return RADIO_FIXTURES.slice();
  }
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    for (const fixture of RADIO_FIXTURES) {
      if (seen.has(fixture.businessId)) continue;
      if (
        fixture.kind === token ||
        fixture.businessId === token ||
        fixture.businessId.replace(/^radio-/, '') === token ||
        String(fixture.gpuId) === token
      ) {
        seen.add(fixture.businessId);
        out.push(fixture);
      }
    }
  }
  return out;
}

/** Look a fixture up by the integer id the GPU wrote. */
export function fixtureByGpuId(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return RADIO_FIXTURES.find((fixture) => fixture.gpuId === n) || null;
}

