/** Visibility-aware serial polling. Teardown also cancels in-flight work. */
export function pollMetadata({ url, onResult, intervalMs, document: doc = globalThis.document, fetch: request = globalThis.fetch, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  let alive = true;
  let timer = null;
  let controller = null;
  let generation = 0;
  function suspend() {
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
    if (controller) controller.abort();
    controller = null;
  }
  async function ask() {
    if (!alive || doc?.hidden) return;
    const token = ++generation;
    controller = new AbortController();
    try {
      const response = await request(url, { cache: 'no-store', signal: controller.signal });
      const body = response.ok ? await response.json() : null;
      if (alive && token === generation) onResult(body);
    } catch {
      if (alive && token === generation) onResult(null);
    } finally {
      if (alive && token === generation) {
        controller = null;
        timer = schedule(ask, intervalMs);
      }
    }
  }
  const visibility = () => { suspend(); if (!doc?.hidden) ask(); };
  doc?.addEventListener('visibilitychange', visibility);
  ask();
  return () => { alive = false; suspend(); doc?.removeEventListener('visibilitychange', visibility); };
}
