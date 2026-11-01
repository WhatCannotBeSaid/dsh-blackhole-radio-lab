// Offline CPU regression only: no browser, renderer, playback or timing claims.
// Run: node tools/test-stations-idle.mjs
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { createStationsLayer } from '../src/nodes/stations-layer.js';

const stations = Array.from({ length: 24 }, (_, i) => ({
  id: `idle-${i}`,
  categories: [i % 2 ? 'rock' : 'jazz'],
  metadata: {
    layout: { radius: 2 + i * 0.03, angle: i * 0.23, height: 0 },
    filterDelay: i * 0.004,
    clouds: [{
      cloudId: i % 2 ? 'rock-cloud' : 'jazz-cloud',
      categoryId: i % 2 ? 'rock' : 'jazz',
      radius: 3 + i * 0.02, angle: i * 0.31, height: 0.2,
    }],
  },
}));
const camera = new PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(0, 1, 8);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const layer = createStationsLayer(stations, { seed: 7 });
const uniforms = layer.object.material.uniforms;
const geometry = layer.object.geometry;
const frame = (dt = 1 / 60) => layer.update(dt, camera, 900);

function settle() {
  for (let i = 0; i < 1200; i++) {
    frame();
    if (!layer.isAnimating) return;
  }
  assert.fail('morph never settled');
}

// Observe math calls rather than wall-clock speed: a settled update must not
// evaluate the per-station exponential. Always restore the shared Math boundary.
function exponentialCalls() {
  const exp = Math.exp;
  let calls = 0;
  Math.exp = (value) => { calls++; return exp(value); };
  try { frame(); } finally { Math.exp = exp; }
  return calls;
}

function buffers() {
  return Object.fromEntries(Object.entries(geometry.attributes).map(([key, attr]) => [key, Array.from(attr.array)]));
}

function asleep(label) {
  const before = buffers();
  const anchors = stations.map((_, i) => layer.positionAt(i));
  const version = layer.layoutVersion();
  const time = uniforms.uTime.value;
  assert.ok(exponentialCalls() < stations.length, `${label}: still walking settled stations`);
  for (let i = 0; i < 8; i++) frame();
  assert.equal(layer.isAnimating, false, `${label}: idle morph woke itself`);
  assert.equal(layer.layoutVersion(), version, `${label}: idle layout was re-uploaded`);
  assert.deepEqual(buffers(), before, `${label}: idle particle data changed`);
  assert.deepEqual(stations.map((_, i) => layer.positionAt(i)), anchors, `${label}: idle picking anchors changed`);
  assert.ok(uniforms.uTime.value > time, `${label}: shader clock stopped`);
}

function wakes(label, change) {
  const version = layer.layoutVersion();
  change();
  assert.equal(layer.isAnimating, true, `${label}: setter failed to wake morph`);
  // Staggered stations can still be in hold, so only the ready subset eases.
  assert.ok(exponentialCalls() > 1, `${label}: next frame skipped station update`);
  assert.ok(layer.layoutVersion() > version, `${label}: next frame missed buffer/anchor flush`);
}

try {
  asleep('initial black hole');
  wakes('filter reveal', () => layer.setFilter(['jazz']));
  settle();
  assert.equal(layer.filterState.strength, 1);
  assert.equal(layer.filterState.matched, 12);
  assert.equal(layer.interactive(1), false);
  asleep('filtered disk');
  wakes('filter clear', () => layer.setFilter([]));
  settle();
  assert.equal(layer.filterState.strength, 0);
  assert.equal(layer.interactive(1), true);
  asleep('restored disk');

  const positions = new Float32Array(stations.length * 3);
  const members = new Uint8Array(stations.length).fill(1);
  for (let i = 0; i < stations.length; i++) positions.set([i * 0.02, i * 0.01, -i * 0.03], i * 3);
  wakes('cluster install', () => layer.setCluster({ positions, members, radius: 3 }));
  settle();
  layer.setClusterAmount(1);
  // The existing ease stops uploading within its 0.002 blend tolerance.
  assert.ok(geometry.attributes.aCluster.array.every((v) => Math.abs(v - 1) < 0.0021));
  asleep('nebula');
  wakes('cluster exit', () => layer.setCluster(null));
  settle();
  layer.setClusterAmount(0);
  assert.ok(geometry.attributes.aCluster.array.every((v) => Math.abs(v) < 0.0021));
  asleep('cluster returned');

  wakes('hold charge', () => layer.setCharge(0.8));
  settle();
  asleep('held charge settled');
  wakes('hold cancellation', () => layer.setCharge(0));
  settle();
  asleep('cancelled charge');

  wakes('timeline ownership', () => {
    layer.setCluster({ positions, members, radius: 3 });
    layer.setFlow(0.4);
  });
  assert.ok(geometry.attributes.aCluster.array.every((v) => Math.abs(v - 0.4) < 1e-7));
  const flowVersion = layer.layoutVersion();
  frame();
  assert.ok(layer.layoutVersion() > flowVersion, 'active timeline must retain original stepping');
  layer.setFlow(0.7);
  frame();
  assert.ok(geometry.attributes.aCluster.array.every((v) => Math.abs(v - 0.7) < 1e-7));
  layer.setFlow(-1);
  settle();
  layer.setClusterAmount(1);
  asleep('timeline released');

  layer.setSelectedIndex(0);
  layer.setPlayingIndex(0, false);
  frame();
  const alpha = layer.marker.material.uniforms.uAlpha.value;
  const scale = layer.marker.scale.x;
  const version = layer.layoutVersion();
  camera.position.z += 2;
  camera.fov = 50;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  frame();
  assert.notEqual(layer.marker.scale.x, scale, 'idle marker stopped following camera size');
  assert.ok(layer.marker.quaternion.equals(camera.quaternion), 'idle marker stopped facing camera');
  assert.notEqual(layer.marker.material.uniforms.uAlpha.value, alpha, 'idle live ring stopped breathing');
  assert.equal(layer.layoutVersion(), version, 'camera/marker change woke geometry');
  layer.setPlayingIndex(0, true);
  frame();
  assert.equal(layer.marker.material.uniforms.uAlpha.value, 0.34, 'paused ring alpha changed');
  layer.setFavourites((station) => station.id === 'idle-0');
  layer.setHoverIndex(1);
  frame();
  assert.equal(uniforms.uHover.value, 1);
  assert.equal(geometry.attributes.aFav.array[0], 1);
  asleep('marker, hover and favourite updates');
  console.log('PASS station idle: no settled catalogue walk; filter/cluster/charge/flow wake-up; unchanged idle buffers/anchors; shader clock, camera-facing ring, breathing, pause, hover and favourites continue. GPU/browser acceptance NOT exercised.');
} finally {
  layer.dispose();
}
