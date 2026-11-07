import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
let entry;
const context = vm.createContext({ window: { __ModuleLoader__: { load(value) { entry = value; } } }, console });
vm.runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context);
assert.equal(typeof entry.id, 'string');
const react = { createElement() {}, createContext() { return {}; }, memo(value) { return value; }, forwardRef(value) { return value; } };
const requireStub = (id) => id === 'react' ? react : {};
requireStub.async = async () => ({});
const plugin = entry.factory(requireStub);
assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject']);
let chunk;
vm.runInNewContext(readFileSync(new URL('../client.radio.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { chunk = value; } } }, console, setTimeout, clearTimeout, AbortController });
const exports = chunk.factory(requireStub);
for (const name of ['createPlaybackCore', 'createRadioStore', 'bindMediaSession', 'pollMetadata', 'createHostWatch', 'createStationHealth']) assert.equal(typeof exports[name], 'function', name);
const jobs = new Map(); let sequence = 0; let attempts = 0;
const core = exports.createPlaybackCore({
  createAudio: () => ({ play() { attempts++; return Promise.resolve(); }, pause() {}, addEventListener() {} }),
  setTimeout(fn) { jobs.set(++sequence, fn); return sequence; }, clearTimeout(id) { jobs.delete(id); },
});
core.play('built-check', 'https://example.test/stream');
for (let n = 0; jobs.size && n < 20; n++) { const [id, fn] = jobs.entries().next().value; jobs.delete(id); fn(); }
assert.equal(attempts, 3);
assert.equal(core.getState().status, 'error');
assert.equal(core.getState().error, 'startup-timeout');
core.dispose();
const failedRow = { stationuuid: 'failed-check', name: 'Failed check FM', url_resolved: 'https://example.test/stream', lastcheckok: 0 };
const repository = exports.createRepositoryFromRows([failedRow]);
assert.equal(repository.search('Failed check FM')[0]?.id, failedRow.stationuuid);
const snapshot = JSON.parse(readFileSync(new URL('../data/catalog.v1.json', import.meta.url), 'utf8'));
assert.equal(snapshot.selectionPolicy, 'no-health-filter');
const shipped = exports.createRepositoryFromRows(snapshot.stations, { limit: snapshot.stations.length });
assert.equal(shipped.search('Gotanno FM 89.2')[0]?.id, 'fdffc27f-a096-4be8-b3bf-2c51a943a1d1');
console.log('PASS entry evaluation and inject/apply; built chunk retains failed checks and finds shipped Gotanno FM 89.2');
