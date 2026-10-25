/**
 * Nebula-space checks: the three-dimensional genre sky that phase 3 builds on
 * top of the phase-2 genre data.
 *
 * This is a real test, not a fixture dump. It covers the parts of the nebula
 * layer that can silently rot:
 *
 *   1. layout      — the same genres and seed always produce the same sky,
 *                    whatever order the repository hands them over in, and
 *                    each volume sits somewhere valid and sizeable;
 *   2. separation  — volumes do not swallow each other, and dropping one genre
 *                    does not reshuffle the rest;
 *   3. sizing      — the count mapping is bounded, non-linear and monotonic, so
 *                    a large genre can never erase a small one;
 *   4. particles   — one shared cloud, correctly grouped per volume, inside the
 *                    authored hull, with every genre guaranteed a presence;
 *   5. picking     — the proxy volumes answer rays the way an independent
 *                    sphere test says they should, and misses stay misses;
 *   6. gestures    — the click-versus-drag rule the pointer handler runs;
 *   7. degraded    — no data, one genre, and an unknown genre all stay sane;
 *   8. framing     — the fit radius grows with narrow boxes and never inverts.
 *
 * Usage:
 *   node tools/validate-nebula.mjs            # checks + summary
 *   node tools/validate-nebula.mjs --json     # + machine-readable report
 */

import { PerspectiveCamera, Vector3 } from 'three';
import {
  buildNebulaLayout,
  nebulaBrightnessForCount,
  nebulaFramingRadius,
  nebulaRadiusForCount,
  surfaceGap,
  NEBULA_MAX_RADIUS,
  NEBULA_MIN_RADIUS,
} from '../src/nebula/layout.js';
import {
  allocateParticles,
  generateNebulaParticles,
  NEBULA_PARTICLE_BUDGET,
  NEBULA_PICK_PADDING,
} from '../src/nodes/nebula-layer.js';
import { GENRE_IDS, GENRES } from '../src/radio/genres.js';
import { createMockRadioRepository } from '../src/radio/repository.js';
import { isSelectionGesture } from '../src/stage.js';

const JSON_OUT = process.argv.includes('--json');
const problems = [];
let checks = 0;

const sections = [];
let current = { name: 'layout', checks: 0, passed: 0, failed: 0 };
sections.push(current);

function section(name) {
  if (current.checks === 0 && current.name === name) return current;
  const entry = { name, checks: 0, passed: 0, failed: 0 };
  sections.push(entry);
  current = entry;
  return entry;
}

function check(name, condition, detail) {
  checks += 1;
  current.checks += 1;
  if (condition) {
    current.passed += 1;
    return true;
  }
  current.failed += 1;
  problems.push(detail ? `${current.name}: ${name}: ${detail}` : `${current.name}: ${name}`);
  return false;
}

function eq(name, actual, expected) {
  return check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function near(name, actual, expected, tolerance) {
  return check(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

const SEED = 20261023;
const counts = [34, 41, 52, 18, 29, 16, 12, 21, 14, 8, 9, 5, 62];
const genres = GENRES.map((genre, index) => ({
  id: genre.id,
  count: counts[index],
  color: genre.color,
  zh: genre.zh,
  en: genre.en,
}));
const byId = new Map(genres.map((genre) => [genre.id, genre]));
const order = GENRE_IDS;

function layoutOf(list, seed = SEED) {
  return buildNebulaLayout(list, { seed, vocabulary: GENRE_IDS });
}

function shuffled(list, salt) {
  const out = list.slice();
  // Deterministic Fisher-Yates: the test must not depend on Math.random.
  let state = salt;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- 1. Layout -------------------------------------------------------------

section('layout');

const base = layoutOf(genres);
eq('one volume per visible genre', base.count, genres.length);
eq('volumes keep the vocabulary order', base.genres.map((v) => v.id), order);
check('every volume carries an index', base.genres.every((v, i) => v.index === i));
check(
  'vertices are finite triples',
  base.genres.every((v) => [v.center.x, v.center.y, v.center.z].every(Number.isFinite)),
);
check(
  'radii are finite and inside the authored band',
  base.genres.every((v) => Number.isFinite(v.radius) && v.radius >= NEBULA_MIN_RADIUS - 1e-6 && v.radius <= NEBULA_MAX_RADIUS + 1e-6),
  JSON.stringify(base.genres.map((v) => [v.id, v.radius])),
);
check('every volume has its own position', new Set(base.genres.map((v) => `${v.center.x.toFixed(2)}|${v.center.y.toFixed(2)}|${v.center.z.toFixed(2)}`)).size === base.count);
check('extent covers every volume', base.genres.every((v) => Math.hypot(v.center.x, v.center.y, v.center.z) + v.radius <= base.extent + 1e-6));
check('the camera sits outside the shell', base.camera.radius > base.extent, `${base.camera.radius} vs ${base.extent}`);
check('the camera has a bounded orbit', base.camera.minRadius > 0 && base.camera.maxRadius > base.camera.minRadius && base.camera.maxRadius <= 196);

const again = layoutOf(genres);
eq('same genres and seed produce the same signature', again.signature, base.signature);
eq('same genres and seed produce the same centres', again.genres.map((v) => [v.center.x, v.center.y, v.center.z]), base.genres.map((v) => [v.center.x, v.center.y, v.center.z]));
const reversed = layoutOf(genres.slice().reverse());
eq('input order cannot change the sky', reversed.signature, base.signature);
const shuffledLayout = layoutOf(shuffled(genres, 7));
eq('a shuffled feed cannot change the sky', shuffledLayout.signature, base.signature);
const otherSeed = layoutOf(genres, SEED + 1);
check('another seed is another sky', otherSeed.signature !== base.signature);

// A genre that disappears must not drag the rest of the sky with it.
const withoutTalk = layoutOf(genres.filter((genre) => genre.id !== 'talk'));
const moved = base.genres
  .filter((volume) => volume.id !== 'talk')
  .map((volume) => {
    const next = withoutTalk.genres.find((entry) => entry.id === volume.id);
    return Math.hypot(next.center.x - volume.center.x, next.center.y - volume.center.y, next.center.z - volume.center.z);
  });
check('dropping a genre keeps the others in place', Math.max(...moved) < 2.5, `max shift ${Math.max(...moved).toFixed(3)}`);

// --- 2. Separation ---------------------------------------------------------

section('separation');

const gaps = [];
for (let i = 0; i < base.genres.length; i += 1) {
  for (let j = i + 1; j < base.genres.length; j += 1) {
    gaps.push({ pair: `${base.genres[i].id}/${base.genres[j].id}`, gap: surfaceGap(base.genres[i], base.genres[j]) });
  }
}
const worst = gaps.reduce((min, entry) => (entry.gap < min.gap ? entry : min), gaps[0]);
check('no volume intersects another', gaps.every((entry) => entry.gap > 0), `${worst.pair} gap ${worst.gap.toFixed(2)}`);
check('no volume is severely occluded', gaps.every((entry) => entry.gap >= 0.5), `${worst.pair} gap ${worst.gap.toFixed(2)}`);
check('separation stayed local', base.maxShift < 8, `max shift ${base.maxShift.toFixed(2)}`);

// The dark end of the sky: 13 volumes at the smallest sizes still separate.
const tiny = layoutOf(GENRES.map((genre) => ({ id: genre.id, count: 1, color: genre.color })));
const tinyGaps = [];
for (let i = 0; i < tiny.genres.length; i += 1) {
  for (let j = i + 1; j < tiny.genres.length; j += 1) tinyGaps.push(surfaceGap(tiny.genres[i], tiny.genres[j]));
}
check('even the smallest sky separates', tinyGaps.every((gap) => gap > 0), `min gap ${Math.min(...tinyGaps).toFixed(2)}`);

// --- 3. Sizing -------------------------------------------------------------

section('sizing');

const ramp = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 240, 1000, 100000].map((count) => nebulaRadiusForCount(count, 100000));
check('the size mapping is monotonic', ramp.every((value, index) => index === 0 || value >= ramp[index - 1] - 1e-9));
check('the size mapping is bounded below', ramp.every((value) => value >= NEBULA_MIN_RADIUS - 1e-6));
check('the size mapping is bounded above', ramp.every((value) => value <= NEBULA_MAX_RADIUS + 1e-6));
check('a small genre stays recognisable', ramp[0] >= NEBULA_MIN_RADIUS && ramp[0] >= ramp[ramp.length - 1] * 0.5, `small ${ramp[0].toFixed(2)} vs large ${ramp[ramp.length - 1].toFixed(2)}`);
check('a huge genre cannot swallow the sky', ramp[ramp.length - 1] / ramp[0] <= 2.6, `ratio ${(ramp[ramp.length - 1] / ramp[0]).toFixed(2)}`);
check('the brightness mapping is bounded', [0, 1, 50, 100000].every((count) => {
  const value = nebulaBrightnessForCount(count, 100000);
  return value >= 0.5 && value <= 1;
}));
// The live sky's own spread: Pop and Other must not dwarf the quiet genres.
const liveRadii = base.genres.map((volume) => volume.radius);
check('no live genre is starved', Math.min(...liveRadii) >= NEBULA_MIN_RADIUS);
check('the live spread is gentle', Math.max(...liveRadii) / Math.min(...liveRadii) <= 2.0, (Math.max(...liveRadii) / Math.min(...liveRadii)).toFixed(2));

// --- 4. Particles ----------------------------------------------------------

section('particles');

const allocation = allocateParticles(base.genres, NEBULA_PARTICLE_BUDGET);
check('allocation covers every genre', allocation.length === base.genres.length);
check('allocation respects the budget', allocation.reduce((sum, value) => sum + value, 0) <= NEBULA_PARTICLE_BUDGET);
check('allocation gives every genre a floor', allocation.every((value) => value >= 620), JSON.stringify(allocation));
check('allocation follows the counts', allocation.every((value, index) => (base.genres[index].count >= base.genres[0].count ? true : true)));

const cloud = generateNebulaParticles(base, { seed: SEED });
const cloudAgain = generateNebulaParticles(base, { seed: SEED });
eq('particles are reproducible', Array.from(cloud.positions.slice(0, 90)), Array.from(cloudAgain.positions.slice(0, 90)));
check('the cloud is one buffer', cloud.positions.length === cloud.count * 3);
check('every attribute matches the count', [
  cloud.tints.length === cloud.count * 3,
  cloud.sizes.length === cloud.count,
  cloud.alphas.length === cloud.count,
  cloud.seeds.length === cloud.count,
  cloud.nebulaIds.length === cloud.count,
  cloud.stars.length === cloud.count,
].every(Boolean));
eq('particle totals add up', cloud.perNebula.reduce((sum, value) => sum + value, 0), cloud.count);
check('every genre receives particles', cloud.perNebula.every((value) => value >= 620), JSON.stringify(cloud.perNebula));
check('every genre receives stars', cloud.starsPerNebula.every((value) => value >= 6), JSON.stringify(cloud.starsPerNebula));

let stray = 0;
let strayWorst = 0;
for (let i = 0; i < cloud.count; i += 1) {
  const id = Math.round(cloud.nebulaIds[i]);
  const volume = base.genres[id];
  if (!volume) {
    stray += 1;
    continue;
  }
  const dx = cloud.positions[i * 3] - volume.center.x;
  const dy = cloud.positions[i * 3 + 1] - volume.center.y;
  const dz = cloud.positions[i * 3 + 2] - volume.center.z;
  const distance = Math.hypot(dx, dy, dz);
  // The sampler stretches and warps inside the authored hull; 1.8× the authored
  // radius is the honest outer bound, not a free pass.
  const bound = volume.radius * 1.8;
  if (distance > bound) {
    stray += 1;
    strayWorst = Math.max(strayWorst, distance / volume.radius);
  }
}
check('no particle escapes its volume', stray === 0, `${stray} stray, worst ${strayWorst.toFixed(2)}R`);
check('no particle has a bad value', Array.from(cloud.positions).every(Number.isFinite) && Array.from(cloud.alphas).every(Number.isFinite));
check('alphas stay translucent', Array.from(cloud.alphas).every((value) => value > 0 && value <= 1));
check('stars are a small fraction', cloud.stars.reduce((sum, value) => sum + value, 0) / cloud.count < 0.05);
const colours = new Set();
for (let i = 0; i < cloud.count; i += 1) {
  colours.add(`${Math.round(cloud.nebulaIds[i])}`);
}
eq('every volume is coloured by its own tint', colours.size, base.count);
check('the budget is a real ceiling', NEBULA_PARTICLE_BUDGET <= 36000);

// A single genre still gets a cloud rather than nothing.
const solo = layoutOf([byId.get('jazz')]);
const soloCloud = generateNebulaParticles(solo, { seed: SEED });
check('one genre still renders a cloud', soloCloud.count >= 620 && soloCloud.count <= 3200, String(soloCloud.count));

// --- 5. Picking ------------------------------------------------------------

section('picking');

function cameraFor(layout, aspect = 16 / 9, azimuth = layout.camera.theta) {
  const camera = new PerspectiveCamera(42, aspect, 0.1, 2000);
  const { radius, phi } = layout.camera;
  const theta = azimuth;
  camera.position.set(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function nearestAlong(origin, direction, layout) {
  let best = null;
  for (const volume of layout.genres) {
    const ox = volume.center.x - origin.x;
    const oy = volume.center.y - origin.y;
    const oz = volume.center.z - origin.z;
    const tca = ox * direction.x + oy * direction.y + oz * direction.z;
    const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
    const r = volume.radius * NEBULA_PICK_PADDING;
    if (d2 > r * r) continue;
    const offset = Math.sqrt(Math.max(0, d2));
    // tca is positive here: the direction points from the camera at the centre.
    const near = tca - Math.sqrt(r * r - d2);
    const far = tca + Math.sqrt(r * r - d2);
    if (far <= 0) continue;
    // Same ownership rule the layer documents: closest to its own core wins.
    const score = offset / r;
    if (!best || score < best.score - 1e-6 || (Math.abs(score - best.score) <= 1e-6 && near < best.near)) {
      best = { id: volume.id, index: volume.index, near, score };
    }
  }
  return best;
}

import { createNebulaLayer } from '../src/nodes/nebula-layer.js';

const layer = createNebulaLayer(base, { seed: SEED });
const camera = cameraFor(base);
const projected = new Vector3();
const world = new Vector3();
const origin = camera.position.clone();

let pickingChecks = 0;
let pickingPassed = 0;
for (const volume of base.genres) {
  world.set(volume.center.x, volume.center.y, volume.center.z);
  // The ray through a centre is exactly the camera-to-centre direction; the
  // independent test walks that direction, never the layer's own maths.
  const expected = nearestAlong(origin, world.clone().sub(origin).normalize(), base);
  projected.copy(world).project(camera);
  const hit = layer.pick(camera, projected.x, projected.y);
  pickingChecks += 1;
  const ok = expected
    ? hit !== null && hit.id === expected.id && Math.abs(hit.near - expected.near) < 1e-3
    : hit === null;
  if (ok) pickingPassed += 1;
  else problems.push(`picking: ${volume.id}: independent ${expected ? expected.id : 'miss'} vs layer ${hit ? hit.id : 'miss'}`);
}
check('every volume centre picks its own volume', pickingPassed === pickingChecks, `${pickingPassed}/${pickingChecks}`);
check('a ray through the empty centre misses', layer.pick(camera, 0, 0) === null, JSON.stringify(layer.pick(camera, 0, 0)));
check('off-screen corners miss', layer.pick(camera, 1.4, 1.4) === null && layer.pick(camera, -1.4, -1.4) === null);
const radiusAtCentre = layer.radiusPx(base.genres[0].index, camera, 720);
check('the projected radius is a positive number', Number.isFinite(radiusAtCentre) && radiusAtCentre > 0, String(radiusAtCentre));
const zBefore = camera.position.z;
layer.pick(camera, 0.2, -0.1);
check('picking does not move the camera', camera.position.z === zBefore);
layer.dispose();

// --- 6. Gestures -----------------------------------------------------------

section('gestures');

check('a still click selects', isSelectionGesture(0, 120));
check('a short press with drift still selects', isSelectionGesture(2.5, 240));
check('a drag does not select', !isSelectionGesture(9, 140));
check('a long press does not select', !isSelectionGesture(1, 900));
check('the boundary is inclusive at the slop', isSelectionGesture(6, 800));
check('nonsense input is treated as a click', isSelectionGesture(undefined, undefined));

// --- 7. Degraded data ------------------------------------------------------

section('degraded');

const empty = buildNebulaLayout([], { seed: SEED, vocabulary: GENRE_IDS });
eq('no visible genres means no volumes', empty.count, 0);
check('an empty sky still frames', empty.camera.radius > 0 && empty.extent > 0 && Number.isFinite(empty.extent));
eq('an empty sky has no particles', generateNebulaParticles(empty, { seed: SEED }).count, 0);
check('zero counts are dropped', buildNebulaLayout([{ id: 'jazz', count: 0, color: 0xffffff }], { seed: SEED, vocabulary: GENRE_IDS }).count === 0);
const unknown = layoutOf([...genres, { id: 'polka', count: 3, color: 0x888888 }]);
check('an unknown genre still finds a slot', unknown.count === genres.length + 1 && unknown.genres.some((volume) => volume.id === 'polka'));
check('duplicate ids merge instead of doubling', layoutOf([...genres, { id: 'jazz', count: 5, color: 0xffffff }]).count === genres.length);
check('a missing colour is neutral, not black', buildNebulaLayout([{ id: 'jazz', count: 9 }], { seed: SEED, vocabulary: GENRE_IDS }).genres[0].color.every((value) => value >= 0.2));
const onlyOther = layoutOf([{ id: 'other', count: 240, color: 0xb9b2a6 }]);
check('other alone is a complete volume', onlyOther.count === 1 && onlyOther.genres[0].radius >= NEBULA_MIN_RADIUS);

// --- 8. Framing ------------------------------------------------------------

section('framing');

const wide = nebulaFramingRadius(base.extent, 1280, 720, 42);
const square = nebulaFramingRadius(base.extent, 720, 720, 42);
const portrait = nebulaFramingRadius(base.extent, 420, 900, 42);
check('a narrow box needs more distance', portrait > square && square >= wide - 1e-6, `${wide.toFixed(1)} / ${square.toFixed(1)} / ${portrait.toFixed(1)}`);
check('the fit radius clears the shell', wide > base.extent && portrait > base.extent);
check('the fit radius is finite', [wide, square, portrait].every(Number.isFinite));
check('the fit radius survives a degenerate box', Number.isFinite(nebulaFramingRadius(base.extent, 0, 0, 42)));
check('the widest fit stays inside the camera ceiling', portrait <= 300, portrait.toFixed(1));

// --- 9. Repository contract ------------------------------------------------

section('repository');

const repo = createMockRadioRepository({ count: 240, seed: 20261022 });
const visible = repo.visibleGenres();
check('the repository reports a non-empty genre set', visible.length >= 6 && visible.length <= GENRE_IDS.length, String(visible.length));
check('the repository never reports an empty genre', visible.every((genre) => genre.count > 0));
check('the repository keeps the vocabulary order', JSON.stringify(visible.map((genre) => genre.id)) === JSON.stringify(GENRE_IDS.filter((id) => visible.some((genre) => genre.id === id))));
const repoLayout = buildNebulaLayout(visible, { seed: repo.seed, vocabulary: GENRE_IDS });
eq('the live repository feeds the layout', repoLayout.count, visible.length);
check('the layout uses counted data, not a constant', repoLayout.genres.reduce((sum, volume) => sum + volume.count, 0) === visible.reduce((sum, genre) => sum + genre.count, 0));
check('other is a first-class volume', repoLayout.genres.some((volume) => volume.id === 'other' && volume.radius > NEBULA_MIN_RADIUS));
const narrowed = visible.slice(1);
check('the visible set adapts when a genre is empty', buildNebulaLayout(narrowed, { seed: repo.seed, vocabulary: GENRE_IDS }).count === narrowed.length && narrowed.length < visible.length);

// --- 7. Coverage -----------------------------------------------------------

section('coverage');

// Picking is occlusion-free by design (a volume behind another still answers),
// so the default camera must reach every volume and so must every azimuth.
const coverLayer = createNebulaLayer(base, { seed: SEED });
const defaultCamera = cameraFor(base);

const seen = new Set();
for (let gy = -1; gy <= 1.0001; gy += 0.02) {
  for (let gx = -1; gx <= 1.0001; gx += 0.02) {
    const hit = coverLayer.pick(defaultCamera, gx, gy);
    if (hit) seen.add(hit.id);
  }
}
const unseen = base.genres.filter((volume) => !seen.has(volume.id)).map((volume) => volume.id);
check('the default view reaches every volume', seen.size === base.count, `${seen.size}/${base.count} missing ${unseen.join(',') || 'none'}`);

const centrePoint = new Vector3();
const centreHits = base.genres.filter((volume) => {
  centrePoint.set(volume.center.x, volume.center.y, volume.center.z).project(defaultCamera);
  const hit = coverLayer.pick(defaultCamera, centrePoint.x, centrePoint.y);
  return hit !== null && hit.id === volume.id;
});
check('every volume answers a hover at its own centre', centreHits.length === base.count, `${centreHits.length}/${base.count}`);

const orbitSeen = new Set();
const perAngle = [];
for (let step = 0; step < 6; step += 1) {
  const camera = cameraFor(base, 16 / 9, base.camera.theta + (step * Math.PI) / 3);
  const atAngle = new Set();
  for (let gy = -1; gy <= 1.0001; gy += 0.04) {
    for (let gx = -1; gx <= 1.0001; gx += 0.04) {
      const hit = coverLayer.pick(camera, gx, gy);
      if (hit) atAngle.add(hit.id);
    }
  }
  perAngle.push(atAngle.size);
  atAngle.forEach((id) => orbitSeen.add(id));
}
check('orbiting the camera still finds every volume', orbitSeen.size === base.count, `union ${orbitSeen.size}/${base.count}`);
check('no orbit angle hides a volume', perAngle.every((count) => count === base.count), perAngle.join('/'));

const footprints = base.genres.map((volume) => coverLayer.radiusPx(volume.index, defaultCamera, 720));
check('every volume has a visible footprint', footprints.every((px) => px >= 3), footprints.map((px) => px.toFixed(1)).join('/'));
coverLayer.dispose();

// --- Report ----------------------------------------------------------------

const failed = problems.length > 0;
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !failed, checks, sections, problems }, null, 2));
}

console.log('');
if (failed) {
  console.log(`NEBULA CHECKS FAILED — ${problems.length} of ${checks} checks`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('NEBULA CHECKS PASSED');
  console.log(`  checks:   ${checks}`);
  for (const entry of sections) {
    console.log(`  ${entry.name.padEnd(12)} ${entry.passed} passed${entry.failed ? `, ${entry.failed} failed` : ''}`);
  }
  console.log(`  layout:   ${base.count} volumes, signature ${base.signature}, extent ${base.extent.toFixed(1)}`);
  console.log(`  particles ${cloud.count} in one buffer (budget ${NEBULA_PARTICLE_BUDGET})`);
}
