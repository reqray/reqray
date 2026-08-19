/**
 * Fills the panel with a realistic-looking session: searches, logins, a few
 * checkouts, the flaky endpoint from both its sides, one slow report, a
 * couple of failures — so the list looks like an application under use, not
 * an empty demo.
 *
 *   pnpm --filter @loupe/example-fastify-postgres traffic
 *   BASE=http://127.0.0.1:3000 node scripts/traffic.js
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';

const SEARCHES = ['walnut', 'lamp', 'steel desk', 'vintage', 'chair', 'matte keyboard'];

/** One user session, told as a story the request list will retell. */
const SCRIPT = [
  ...SEARCHES.map((q) => () => get(`/api/search?q=${encodeURIComponent(q)}`)),
  // A random suffix so a rerun against the same panel registers again instead
  // of hitting the "email is taken" branch.
  () =>
    post('/api/register', {
      email: `user${Math.floor(Math.random() * 1e6)}@example.com`,
      password: 'correct horse battery staple',
    }),
  () => post('/api/login', { login: 'ada@example.com', password: 'hunter2' }),
  () => get('/api/order'),
  () => get('/api/orders/eager'),
  () => get('/api/orders'),
  () => get('/api/prices/parallel'),
  () => get('/api/prices'),
  ...Array.from({ length: 6 }, (_, i) => () => get('/api/orders/flaky', `flaky #${i + 1}`)),
  () => post('/api/checkout', { orderId: 3, cardNumber: '4111 1111 1111 1111' }),
  () => post('/api/checkout', { orderId: 7, cardNumber: '5500 0000 0000 0004' }),
  () => get('/api/report'),
  () => get('/api/boom'),
  () => get('/api/boom'),
];

async function get(path, label = path) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`);
  await response.text();
  console.log(
    `  ${String(response.status).padStart(3)}  ${Math.round(performance.now() - started)
      .toString()
      .padStart(4)} ms  GET ${label}`,
  );
}

async function post(path, body) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.text();
  console.log(
    `  ${String(response.status).padStart(3)}  ${Math.round(performance.now() - started)
      .toString()
      .padStart(4)} ms  POST ${path}`,
  );
}

try {
  await fetch(`${BASE}/api/order`);
} catch {
  console.error(`the app is not responding at ${BASE} — start it first:`);
  console.error('  pnpm --filter @loupe/example-fastify-postgres start');
  process.exit(1);
}

console.log(`driving traffic to ${BASE}\n`);
for (const step of SCRIPT) {
  try {
    await step();
  } catch (error) {
    console.log(`  step failed: ${error.message}`);
  }
  // Jitter keeps the timeline looking human rather than scripted.
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 160));
}

console.log(`\ndone — open the panel: ${BASE}/_loupe/`);
console.log('what to look at:');
console.log('  · rows flagged N+1 and SEQ — detectors with a line of code');
console.log('  · /api/orders/flaky — the compare button in the detail: fast versus slow');
console.log('  · /api/checkout — the Logs tab and a masked cardNumber in the body');
console.log('  · /api/search — EXPLAIN on the SQL tab will show a Seq Scan');
console.log('  · /api/report — a slow request; Exceptions grouped two /api/boom');
console.log('  · /api/report and /api/register — the dashed uninstrumented bar in the waterfall');
console.log('  · the copy link and copy for AI buttons — in the detail header');
