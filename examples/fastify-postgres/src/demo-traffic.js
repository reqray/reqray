/**
 * The demo drives itself.
 *
 * An empty panel demonstrates nothing, and asking a reader to curl fourteen
 * routes before they can see anything is asking too much. So the demo calls
 * its own routes on a loop: one pass covers every surface the panel has — an
 * N+1 and its fixed twin, sequential and parallel external calls, a masked
 * login, a slow report over budget, a cached profile read one time too many,
 * a pair of flaky requests to compare and an exception to group — and the
 * loop keeps the timeline moving, so the scrubber has something to scrub and
 * the live feed something to feed on.
 *
 * Switched off with `DEMO_TRAFFIC=off`, and off by itself under the
 * benchmark, where self-inflicted load would be noise in the measurement.
 */

/** Pause between calls. A pass is ~30 s, which keeps the timeline alive. */
const DEFAULT_INTERVAL_MS = 1500;

/**
 * One pass over everything the demo can show.
 *
 * The order tells a story rather than grouping by feature: the slow and the
 * broken are spread through the pass, so the list never looks like a wall of
 * one colour, and the pairs that exist to be compared — N+1 against eager,
 * sequential against parallel — sit next to each other.
 */
export function trafficPlan() {
  return [
    { label: 'one query', path: '/api/order' },
    { label: 'N+1', path: '/api/orders' },
    { label: 'no N+1', path: '/api/orders/eager' },
    // Two passes over the profile: the first fills the cache, the second is
    // the warm read. Both read one key twice, which is the point.
    { label: 'cache, cold', path: '/api/profile/1' },
    { label: 'cache, warm', path: '/api/profile/1' },
    { label: 'sequential HTTP', path: '/api/prices' },
    {
      label: 'login',
      path: '/api/login',
      method: 'POST',
      // Both sides carry secrets: the panel must show them masked.
      body: { login: 'ada@example.com', password: 'hunter2' },
    },
    { label: 'search', path: '/api/search?q=walnut' },
    { label: 'parallel HTTP', path: '/api/prices/parallel' },
    { label: 'duplicate call', path: '/api/invoice/1' },
    // The flaky route alternates between the eager and the N+1 path, so two
    // calls in a row give the Compare screen a matched pair.
    { label: 'flaky A', path: '/api/orders/flaky', test: 'orders.spec.ts:31 > lists orders' },
    { label: 'flaky B', path: '/api/orders/flaky', test: 'orders.spec.ts:31 > lists orders' },
    {
      label: 'checkout',
      path: '/api/checkout',
      method: 'POST',
      body: { orderId: 3, cardNumber: '4111 1111 1111 1111' },
      test: 'checkout.spec.ts:64 > charges the card once',
    },
    // The same charge twice, so the panel has the pair to compare: the first
    // holds a connection across the payment provider, the second gives it
    // back first. They take the same time and only one of them is a problem.
    {
      label: 'pay, holding',
      path: '/api/pay',
      method: 'POST',
      body: { orderId: 2 },
      test: 'checkout.spec.ts:71 > charges the card',
    },
    {
      label: 'pay, released',
      path: '/api/pay/after',
      method: 'POST',
      body: { orderId: 2 },
      test: 'checkout.spec.ts:71 > charges the card',
    },
    { label: 'slow report', path: '/api/report' },
    // Five reports at once on a pool of four: the last one waits for a
    // connection, and its bar looks exactly like a slow query.
    { label: 'pool queue', path: '/api/reports/burst' },
    { label: 'unpaginated export', path: '/api/export' },
    {
      label: 'register',
      path: '/api/register',
      method: 'POST',
      body: { email: 'lin@example.com', password: 'correct horse battery staple' },
    },
    { label: 'exception', path: '/api/boom', test: 'checkout.spec.ts:88 > rejects an empty cart' },
  ];
}

/** Sends one entry of the plan. A failure is data too, never a crash. */
async function send(base, entry) {
  const headers = {};
  if (entry.body) headers['content-type'] = 'application/json';
  // Header values are latin1 on the wire, and a test name is free text.
  if (entry.test) headers['x-reqray-test'] = encodeURIComponent(entry.test);

  try {
    const response = await fetch(`${base}${entry.path}`, {
      method: entry.method ?? 'GET',
      headers,
      ...(entry.body ? { body: JSON.stringify(entry.body) } : {}),
    });
    // The body has to be drained or the connection is held open.
    await response.arrayBuffer();
  } catch {
    // The app is shutting down, or a route is unhappy. Either way the next
    // tick will try the next entry — the demo must not die of its own traffic.
  }
}

/**
 * Starts the loop.
 *
 * One entry per tick rather than a burst: a burst would land as a single
 * spike on the timeline, and the panel is at its most convincing when
 * requests arrive the way they do in a real application.
 *
 * @returns a handle whose `stop()` ends the loop.
 */
export function startTraffic({ base, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const plan = trafficPlan();
  let index = 0;
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    const entry = plan[index % plan.length];
    index++;
    await send(base, entry);
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    // The loop must never be the reason the process stays alive.
    timer.unref();
  };

  // The first call goes out at once: whoever opens the panel should find it
  // already showing something.
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
