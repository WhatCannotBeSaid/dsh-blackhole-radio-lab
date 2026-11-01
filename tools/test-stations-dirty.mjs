// Offline CPU checks of category upload intent, not a GPU/performance benchmark.
// Run: node tools/test-stations-dirty.mjs [--baseline <pre-change stations-layer.js>]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PerspectiveCamera } from 'three';
import { createStationsLayer } from '../src/nodes/stations-layer.js';

const stations = Array.from({ length: 24 }, (_, i) => ({
  id: `dirty-${i}`, isFeatured: i % 5 === 0,
  categories: [i % 2 ? 'rock' : 'jazz'],
  metadata: {
    layout: { radius: 2 + i * 0.03, angle: i * 0.23, height: i * 0.01 },
    filterDelay: 0,
    clouds: [{ cloudId: 'jazz-cloud', categoryId: 'jazz', radius: 3 + i * 0.02, angle: i * 0.31, height: 0.2 }],
  },
}));
const positions = Float32Array.from({ length: stations.length * 3 }, (_, i) => i * 0.013);
const members = Uint8Array.from(stations, (_, i) => i % 2);
const layout = { positions, members, radius: 3 };
const camera = new PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(0, 1, 8); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
const layer = createStationsLayer(stations, { seed: 7 });
const attributes = layer.object.geometry.attributes;
const frame = (dt = 1 / 60) => layer.update(dt, camera, 900);
const versions = () => Object.fromEntries(Object.entries(attributes).map(([k, a]) => [k, a.version]));
function uploaded(label, action, expected) {
  const before = versions();
  action();
  const actual = Object.keys(attributes).filter((k) => attributes[k].version > before[k]).sort();
  assert.deepEqual(actual, [...expected].sort(), label);
}
function settle() {
  for (let i = 0; i < 1200; i++) { frame(); if (!layer.isAnimating) return; }
  assert.fail('morph never settled');
}
try {
  uploaded('initial idle', () => frame(), []);
  uploaded('charge changes positions only', () => { layer.setCharge(0.8); frame(); }, ['position']);
  uploaded('continuing charge', () => frame(), ['position']);
  settle();
  uploaded('settled charge', () => frame(), []);
  uploaded('charge cancellation', () => { layer.setCharge(0); frame(); }, ['position']);
  settle();
  uploaded('filter changes matches and dependent positions', () => { layer.setFilter(['jazz']); frame(); }, ['position', 'aMatch']);
  settle();
  uploaded('filter clear', () => { layer.setFilter([]); frame(); }, ['position', 'aMatch']);
  settle();
  layer.setCluster(layout); frame();
  assert.equal(attributes.aMember.version, 1, 'membership must upload on install');
  const installedMembers = attributes.aMember.version;
  settle();
  assert.equal(attributes.aMember.version, installedMembers, 'cluster easing re-uploaded static membership');
  uploaded('flow changes blend and positions only', () => { layer.setFlow(0.4); frame(); }, ['position', 'aCluster']);
  const flowLayout = layer.layoutVersion();
  uploaded('constant flow does not upload unchanged data', () => frame(), []);
  assert.ok(layer.isAnimating, 'timeline scheduling changed');
  assert.ok(layer.layoutVersion() > flowLayout, 'pick-cache refresh timing changed');
  uploaded('reverse flow', () => { layer.setFlow(0.2); frame(); }, ['position', 'aCluster']);
  uploaded('layout replacement at constant blend', () => {
    layer.setCluster({ ...layout, radius: 4, positions: Float32Array.from(positions, (v) => v + 0.2) }); frame();
  }, ['position']);
  uploaded('filter during held flow', () => { layer.setFilter(['jazz']); frame(); }, ['position', 'aMatch']);
  settleFilterDuringFlow();
  uploaded('zero dt preserves pending setter', () => { layer.setCharge(0.5); frame(0); }, []);
  assert.equal(layer.isAnimating, true);
  uploaded('next positive dt applies pending charge', () => frame(), ['position']);
  layer.setFlow(-1); settle();
  // The legacy final snap is not flushed until this next requested refresh.
  uploaded('cluster exit flushes pending snap but preserves members', () => { layer.setCluster(null); frame(); }, ['position', 'aCluster']);
  settle();
  assert.equal(attributes.aMember.version, installedMembers, 'null cluster unexpectedly cleared membership');
  layer.setCluster({ ...layout, members: new Uint8Array(stations.length) }); layer.setFlow(0); frame();
  assert.ok(attributes.aMember.array.every((v) => v === 0), 'empty membership stayed on GPU');
  uploaded('empty members at constant flow', () => frame(), []);
  uploaded('uniform/marker changes do not upload geometry', () => {
    layer.setSelectedIndex(0); layer.setPlayingIndex(0, false); layer.setHoverIndex(1);
    layer.setClusterAmount(1); layer.setBurst(0.5); frame();
  }, []);
  uploaded('favourites retain separate upload', () => layer.setFavourites((s) => s.id === 'dirty-0'), ['aFav']);
  console.log('PASS category uploads: charge, filter, cluster, membership, constant/reverse flow, layout replacement, zero dt, marker and favourites. No per-station upload ranges.');
} finally { layer.dispose(); }
function settleFilterDuringFlow() { for (let i = 0; i < 450; i++) frame(); }

const baselineIndex = process.argv.indexOf('--baseline');
if (baselineIndex >= 0) {
  const path = process.argv[baselineIndex + 1];
  assert.ok(path, '--baseline needs a pre-change source path');
  const sourceUrl = new URL('../src/nodes/stations-layer.js', import.meta.url);
  const source = readFileSync(path, 'utf8').replace(/from '([^']+)'/g, (_, spec) =>
    `from '${spec === 'three' ? import.meta.resolve('three') : new URL(spec, sourceUrl).href}'`);
  const { createStationsLayer: before } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const layers = [before(stations, { seed: 7 }), createStationsLayer(stations, { seed: 7 })];
  let frames = 0;
  const both = (fn) => layers.forEach(fn);
  const snapshot = (l) => ({
    attributes: Object.fromEntries(Object.entries(l.object.geometry.attributes).map(([k, a]) => [k, Array.from(a.array)])),
    uniforms: Object.fromEntries(Object.entries(l.object.material.uniforms).map(([k, u]) => [k, u.value])),
    anchors: stations.map((_, i) => l.positionAt(i)), interactive: stations.map((_, i) => l.interactive(i)),
    sizes: stations.map((_, i) => l.screenSizeAt(i, camera, 900)),
    filter: l.filterState, animating: l.isAnimating, layoutVersion: l.layoutVersion(),
    marker: { visible: l.marker.visible, position: l.marker.position.toArray(), scale: l.marker.scale.toArray(),
      quaternion: l.marker.quaternion.toArray(), uniforms: l.marker.material.uniforms },
  });
  function step(n) {
    const deltas = [0, 1 / 60, 1 / 30, 1 / 120, 0.08, -0.01];
    for (let i = 0; i < n; i++) {
      both((l) => l.update(deltas[frames % deltas.length], camera, 900));
      assert.deepEqual(snapshot(layers[1]), snapshot(layers[0]), `baseline mismatch at frame ${frames}`);
      frames++;
    }
  }
  try {
    step(10); both((l) => l.setPlayingIndex(0, false));
    both((l) => l.setFilter(['jazz'])); step(40);
    both((l) => l.setFilter([])); step(800);
    both((l) => l.setFilter(['rock'])); step(800);
    both((l) => l.setCluster(layout)); step(800);
    both((l) => l.setClusterAmount(1)); both((l) => l.setSelectedIndex(1)); step(10);
    both((l) => l.setCharge(0.8)); step(40); both((l) => l.setCharge(0)); step(800);
    both((l) => l.setFlow(0.4)); step(20); both((l) => l.setFlow(0.7)); step(20);
    both((l) => l.setCluster({ ...layout, radius: 4, positions: Float32Array.from(positions, (v) => v + 0.3) })); step(20);
    both((l) => l.setCluster({ ...layout, members: Uint8Array.from(members, (v) => 1 - v) })); step(20);
    both((l) => l.setFilter(['jazz'])); step(600);
    both((l) => l.setFlow(-1)); step(800);
    both((l) => l.setCluster(null)); step(800);
    both((l) => l.setClusterAmount(0)); both((l) => l.setFilter([])); step(800);
    both((l) => l.setCharge(0.5)); step(800);
    both((l) => l.setPlayingIndex(0, true)); both((l) => l.setHoleOnly(1)); step(10);
    both((l) => l.setHoleOnly(0)); both((l) => l.setFavourites((s) => s.id === 'dirty-1')); step(10);
    console.log(`PASS ${frames} baseline frames: all attribute values, uniforms, anchors, interaction, sizes, marker, animation and layout-version states equal. GPU/browser acceptance NOT exercised.`);
  } finally { both((l) => l.dispose()); }
}
