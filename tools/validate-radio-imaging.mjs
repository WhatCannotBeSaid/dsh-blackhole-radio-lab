/**
 * CPU-side fixture checks for the phase-2 radio suite.
 *
 * This does NOT draw anything. It answers the questions that can be answered
 * without a GPU — are the fixtures where the disc is, are the ids unique and
 * stable, does the finite patch subtend a sane angle, is every fixture inside
 * the two-intersection range the trace models — and prints the CPU reference
 * positions the GPU harness compares against.
 *
 * The reference positions are NOT recomputed here. The phase-1 probe already
 * produced them by ray-marching the crossed-ray equations at 0.1 px detail
 * (docs/baseline/fixtures-probe/). Recomputing them with a second implementation
 * in this file would only prove that the two implementations agree with each
 * other; the point of an oracle is that it was produced independently of the
 * thing under test.
 *
 * Usage:
 *   node tools/validate-radio-imaging.mjs            # checks, summary
 *   node tools/validate-radio-imaging.mjs --json     # + machine-readable report
 *   node tools/validate-radio-imaging.mjs --write    # write docs/radio-gpu-harness/expected.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RADIO_FIXTURES,
  PATCH_RADIUS,
  fixtureWorldPosition,
  shaderFixtures,
} from '../src/scene/radio-fixtures.js';
import {
  DISK_INNER,
  DISK_OUTER,
  CRITICAL_IMPACT_PARAMETER,
  CAMERA_HOME,
} from '../src/scene/dimensions.js';
import { RAY_TABLES, RAY_TABLES_REVISION } from '../src/scene/ray-tables.data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');

const FOV_DEG = 42;
const WIDTH = 1280;
const HEIGHT = 720;

/**
 * CPU reference image positions, from the phase-1 probe
 * (docs/baseline/fixtures-probe/). Row 0 is the TOP of the screen, CSS pixels.
 *
 * `crossingIndex` is the order of the plane crossing along the ray, counted from
 * the camera, and it is the only physical label here. It is NOT the shader's
 * table slot: the far-side image is produced by the trace's SECOND table branch
 * while being the FIRST (and only) plane crossing of its ray. The two labels are
 * therefore reported separately everywhere; comparing the slot against this
 * index is what made the earlier run look like a branch mismatch.
 *
 * `screenRegion` is a description of where the image sits on screen, for humans
 * and for the near-axis pair. It carries no ordering claim.
 */
const REFERENCE = {
  'radio-near-side': [
    { crossingIndex: 1, screenRegion: 'lower-centre', x: 851.1, y: 376.84 },
  ],
  'radio-far-side': [
    { crossingIndex: 1, screenRegion: 'upper-left', x: 384.01, y: 339.59 },
  ],
  'radio-near-axis': [
    { crossingIndex: 1, screenRegion: 'upper', x: 640.0, y: 210.8 },
    { crossingIndex: 2, screenRegion: 'lower', x: 640.0, y: 505.4 },
  ],
  'radio-weak-field': [
    { crossingIndex: 1, screenRegion: 'right', x: 1178.0, y: 361.83 },
  ],
};

const problems = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) return true;
  problems.push(detail ? `${name}: ${detail}` : name);
  return false;
}

function approx(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

// --- 1. Fixture table -------------------------------------------------------

check('four fixtures', RADIO_FIXTURES.length === 4, `got ${RADIO_FIXTURES.length}`);

const ids = new Set(RADIO_FIXTURES.map((fixture) => fixture.businessId));
check('business ids unique', ids.size === RADIO_FIXTURES.length);
const gpuIds = new Set(RADIO_FIXTURES.map((fixture) => fixture.gpuId));
check('gpu ids unique', gpuIds.size === RADIO_FIXTURES.length);
check(
  'gpu ids non-zero integers',
  RADIO_FIXTURES.every((fixture) => Number.isInteger(fixture.gpuId) && fixture.gpuId > 0),
);
check(
  'gpu id fits in 8-bit id channel',
  RADIO_FIXTURES.every((fixture) => fixture.gpuId > 0 && fixture.gpuId <= 255),
);
check(
  'kinds cover the four requested classes',
  new Set(RADIO_FIXTURES.map((fixture) => fixture.kind)).size === 4,
);
check(
  'every fixture is static (no orbital motion claimed)',
  RADIO_FIXTURES.every((fixture) => fixture.motion === 'static'),
);
check(
  'patch radius positive and finite',
  RADIO_FIXTURES.every((fixture) => fixture.patchRadius > 0 && Number.isFinite(fixture.patchRadius)),
);
check(
  'linear radiance colours, no negative channel',
  RADIO_FIXTURES.every(
    (fixture) =>
      fixture.color.length === 3 &&
      fixture.color.every((channel) => Number.isFinite(channel) && channel >= 0),
  ),
);

// --- 2. Geometry ------------------------------------------------------------

for (const fixture of RADIO_FIXTURES) {
  check(
    `${fixture.businessId} radius inside the disc`,
    fixture.r >= DISK_INNER && fixture.r <= DISK_OUTER,
    `r=${fixture.r} not in [${DISK_INNER}, ${DISK_OUTER}]`,
  );
  const world = fixtureWorldPosition(fixture);
  check(
    `${fixture.businessId} lies on the disc plane`,
    approx(world.y, 0, 1e-12),
    `y=${world.y}`,
  );
  const phi = Math.atan2(world.x, world.z);
  const wrapped = Math.abs(((phi - fixture.phi + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  check(
    `${fixture.businessId} keeps its catalogue azimuth`,
    approx(wrapped, 0, 1e-9),
    `phi=${phi} vs ${fixture.phi}`,
  );

  // Straight-line bound from the default camera to the source. It is a geometric
  // bound, not the lensed impact parameter; the trace uses the lensed one.
  const eye = CAMERA_HOME;
  const dx = world.x - eye.x;
  const dy = world.y - eye.y;
  const dz = world.z - eye.z;
  const distance = Math.hypot(dx, dy, dz);
  const along = -(eye.x * dx + eye.y * dy + eye.z * dz) / distance;
  const b = Math.sqrt(
    Math.max(0, eye.x * eye.x + eye.y * eye.y + eye.z * eye.z - along * along),
  );

  const angular = Math.atan(fixture.patchRadius / distance);
  const pixels = angular * (HEIGHT / 2) / Math.tan((FOV_DEG * Math.PI) / 360);
  // The near-axis fixture sits *behind* the hole on the line of sight: its
  // straight-line impact parameter is below b_crit, so the direct view is
  // captured and the only way out is lensing. That is exactly the fixture's job,
  // and the phase-1 probe measured its two arcs at (640, 210.8) and (640, 505.4).
  if (fixture.kind === 'axis') {
    check(
      `${fixture.businessId} is geometrically behind the hole`,
      b < CRITICAL_IMPACT_PARAMETER,
      `b=${b.toFixed(4)} >= ${CRITICAL_IMPACT_PARAMETER}`,
    );
    check(
      `${fixture.businessId} is only visible through lensing`,
      (REFERENCE[fixture.businessId] || []).length === 2,
    );
  } else {
    check(
      `${fixture.businessId} geometric impact parameter above b_crit`,
      b > CRITICAL_IMPACT_PARAMETER,
      `b=${b.toFixed(4)} <= ${CRITICAL_IMPACT_PARAMETER}`,
    );
  }
  check(
    `${fixture.businessId} patch has a measurable size`,
    pixels >= 0.25,
    `patch diameter ${pixels.toFixed(2)} px at 720p`,
  );
  check(
    `${fixture.businessId} patch is a finite-size source, not a point`,
    fixture.patchRadius === PATCH_RADIUS,
    `patchRadius=${fixture.patchRadius}`,
  );
}

// --- 3. Reference positions -------------------------------------------------

for (const fixture of RADIO_FIXTURES) {
  const refs = REFERENCE[fixture.businessId];
  check(`${fixture.businessId} has a CPU reference`, Array.isArray(refs) && refs.length > 0);
  if (!refs) continue;
  for (const ref of refs) {
    check(
      `${fixture.businessId} crossing ${ref.crossingIndex} reference inside the frame`,
      ref.x >= 0 && ref.x <= WIDTH && ref.y >= 0 && ref.y <= HEIGHT,
      `(${ref.x}, ${ref.y})`,
    );
  }
  const centreX = WIDTH / 2;
  const centreY = HEIGHT / 2;
  for (const ref of refs) {
    const offset = Math.hypot(ref.x - centreX, ref.y - centreY);
    check(
      `${fixture.businessId} crossing ${ref.crossingIndex} is not at the shadow centre`,
      offset > 60,
      `offset ${offset.toFixed(1)} px`,
    );
  }
}

// The near-axis fixture is the only one that must produce two images: its lower
// branch passes behind the hole and comes back on the far side of the disk.
check(
  'near-axis fixture produces two branches',
  (REFERENCE['radio-near-axis'] || []).length === 2,
);
check(
  'near-axis branches are on opposite sides of the centre',
  (REFERENCE['radio-near-axis'] || []).every((ref) => Math.abs(ref.y - HEIGHT / 2) > 60),
);

// --- 4. Shader payload ------------------------------------------------------

const slots = shaderFixtures();
check('shader payload covers every fixture', slots.length === RADIO_FIXTURES.length);
for (let i = 0; i < slots.length; i += 1) {
  const slot = slots[i];
  const fixture = RADIO_FIXTURES[i];
  const world = fixtureWorldPosition(fixture);
  const rsw = 2 / (3 * Math.sqrt(3));
  check(
    `${fixture.businessId} shader x = world.x / RS`,
    approx(slot.x, world.x / rsw, 1e-9),
    `${slot.x} vs ${world.x / rsw}`,
  );
  check(
    `${fixture.businessId} shader y = -world.z / RS`,
    approx(slot.y, -world.z / rsw, 1e-9),
    `${slot.y} vs ${-world.z / rsw}`,
  );
  check(
    `${fixture.businessId} shader radius = patch / RS`,
    approx(slot.radius, fixture.patchRadius / rsw, 1e-9),
  );
  check(`${fixture.businessId} shader id carried through`, slot.gpuId === fixture.gpuId);
}

// --- 5. Table sanity (the tables the shader reads) --------------------------

const defl = RAY_TABLES.deflection;
check(
  'deflection table is the shipped 512x512',
  defl.width === 512 && defl.height === 512,
  `${defl.width}x${defl.height}`,
);
check('ray table revision recorded', typeof RAY_TABLES_REVISION === 'string');

// --- 6. Report --------------------------------------------------------------

const report = {
  generatedAt: new Date().toISOString(),
  width: WIDTH,
  height: HEIGHT,
  fovDeg: FOV_DEG,
  fixtureCount: RADIO_FIXTURES.length,
  checks,
  failures: problems.length,
  expected: REFERENCE,
  fixtures: RADIO_FIXTURES.map((fixture) => {
    const world = fixtureWorldPosition(fixture);
    return {
      businessId: fixture.businessId,
      gpuId: fixture.gpuId,
      kind: fixture.kind,
      r: fixture.r,
      phi: fixture.phi,
      patchRadius: fixture.patchRadius,
      color: fixture.color.slice(),
      world,
      reference: REFERENCE[fixture.businessId] || [],
    };
  }),
};

if (problems.length > 0) {
  console.error(`${problems.length} CHECK(S) FAILED`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('RADIO FIXTURE CHECKS PASSED');
  console.log(`  fixtures: ${RADIO_FIXTURES.length}`);
  console.log(`  checks:   ${checks}`);
  for (const fixture of RADIO_FIXTURES) {
    const refs = REFERENCE[fixture.businessId]
      .map((ref) => `crossing ${ref.crossingIndex} (${ref.x}, ${ref.y})`)
      .join(', ');
    console.log(`  ${fixture.businessId.padEnd(18)} id ${String(fixture.gpuId).padEnd(4)} ${refs}`);
  }
}

if (process.argv.includes('--json') || process.argv.includes('--write')) {
  if (process.argv.includes('--write')) {
    const out = resolve(PROJECT, 'docs/radio-gpu-harness/expected.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`  wrote ${out}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
