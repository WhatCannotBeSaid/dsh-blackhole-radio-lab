/** Local listening evidence, never a catalogue filter or a manual-play gate. */
const TTL_MS = 7 * 86400000;
const COOLDOWNS = [600000, 3600000, 21600000, 86400000];

export function createStationHealth(options = {}) {
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const records = new Map();
  const fresh = (record) => record && now() - Math.max(record.successAt, record.failedAt) < TTL_MS;
  const get = (id) => {
    const record = records.get(String(id));
    if (fresh(record)) return record;
    records.delete(String(id));
    return null;
  };
  return {
    load(rows) {
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row.id !== 'string' || !row.id || records.has(row.id)) continue;
        if (!['successAt', 'failedAt', 'failures', 'cooldownUntil'].every((key) => Number.isFinite(row[key]) && row[key] >= 0)) continue;
        if (!Number.isInteger(row.failures) || row.failures > 4 || Math.max(row.successAt, row.failedAt) > now()) continue;
        if (row.cooldownUntil > row.failedAt + COOLDOWNS[3]) continue;
        if (fresh(row)) records.set(row.id, { ...row });
      }
    },
    save() {
      return Array.from(records.values()).filter(fresh).map((row) => ({ ...row }));
    },
    success(id) {
      records.set(String(id), { id: String(id), successAt: now(), failedAt: 0, failures: 0, cooldownUntil: 0 });
    },
    failure(id) {
      const failures = Math.min(4, (get(id)?.failures || 0) + 1);
      const failedAt = now();
      records.set(String(id), { id: String(id), successAt: 0, failedAt, failures, cooldownUntil: failedAt + COOLDOWNS[failures - 1] });
    },
    pick(stations, excluded = new Set()) {
      const recent = [], unverified = [];
      for (const station of stations) {
        const id = String(station.id);
        if (excluded.has(id)) continue;
        const record = get(id);
        if (record && record.cooldownUntil > now()) continue;
        (record && record.successAt > 0 ? recent : unverified).push(station);
      }
      const bag = recent.length ? recent : unverified;
      return bag.length ? bag[Math.floor(random() * bag.length)] : null;
    },
  };
}
