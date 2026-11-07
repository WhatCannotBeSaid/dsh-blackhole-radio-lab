import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStationField } from '../src/scene/station-field.js';
import { STATION_RADIUS } from '../src/radio/distribution.js';
import { clusterRadius } from '../src/cluster/layout.js';

// A deterministic ring of stations. No randomness, so the two fields below
// differ only in how many stations carry each position.
function ring(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const radius = STATION_RADIUS.inner + (STATION_RADIUS.outer - STATION_RADIUS.inner) * ((i % 37) / 36);
    const angle = (i / count) * Math.PI * 2 * 7;
    out.push({
      id: String(i),
      position: { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius },
      metadata: { layout: { radius, angle, height: 0 } },
    });
  }
  return out;
}

const meanDensity = (field) => {
  let sum = 0;
  let covered = 0;
  for (let cell = 0; cell < field.pixels.length / 4; cell += 1) {
    if (!field.pixels[cell * 4 + 3]) continue;
    covered += 1;
    sum += field.pixels[cell * 4] / 255;
  }
  return covered ? sum / covered : 0;
};

test('disc brightness follows catalogue size', () => {
  const base = ring(1000);
  const scaled = [...base, ...base, ...base];
  const ratio = meanDensity(buildStationField(scaled, {})) / meanDensity(buildStationField(base, {}));
  // Tripled stations, but the saturating curve damps it: expect roughly 2.1.
  assert.ok(ratio > 1.8, `more stations must mean a brighter disc, got ratio ${ratio.toFixed(2)}`);
});

test('cluster knots keep growing with membership', () => {
  // The old 2.2 ceiling flattened everything above ~2.5k members, so a tripled
  // catalogue produced an identical sky. Guard that the ceiling stays loose.
  assert.ok(clusterRadius(2500) < clusterRadius(7500), 'knot radius must still grow from 2.5k to 7.5k members');
});
