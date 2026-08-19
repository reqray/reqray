import { loupe } from '@loupe/fastify';
import { httpTransport } from '@loupe/transport-http';
import Fastify from 'fastify';
import { connect } from './db.js';
import { listOneOrder, listOrdersEagerly, listOrdersWithNPlusOne } from './orders.js';
import { listPricesInParallel, listPricesSequentially } from './prices.js';
import {
  checkout,
  listOrdersFlaky,
  login,
  registerUser,
  searchProducts,
  slowReport,
} from './shop.js';

const PORT = Number(process.env.PORT ?? 3000);
// Loopback by default so a local run is not exposed to the network; a
// container has to bind 0.0.0.0 or the published port reaches nothing.
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * `none` | `off` | `prod` | `dev` | `staging` — the modes the overhead
 * benchmark compares. `none` does not register the plugin at all, which is the
 * only way to measure what a disabled Loupe actually costs. `staging` ships
 * batches to a collector (`@loupe/server`) instead of keeping them in memory.
 */
const LOUPE_MODE = process.env.LOUPE_MODE ?? 'dev';

/** The staging transport — kept to flush the tail on shutdown. */
let shippedTransport = null;

function loupeOptions() {
  if (LOUPE_MODE === 'off') return { enabled: false };
  if (LOUPE_MODE === 'prod') {
    return {
      enabled: true,
      mode: 'production',
      panel: { gate: 'open' },
      ...(process.env.LOUPE_STACK === 'off' ? { stack: { maxPerFingerprint: 0 } } : {}),
    };
  }
  if (LOUPE_MODE === 'staging') {
    shippedTransport = httpTransport({
      url: process.env.LOUPE_SERVER_URL ?? 'http://127.0.0.1:4300',
      token: process.env.LOUPE_TOKEN,
    });
    return {
      enabled: true,
      mode: 'production',
      // The panel lives on the collector; the application only collects.
      panel: false,
      // Full retention so every click on the demo stand is visible. A real
      // staging keeps the default share.
      sampling: { rate: 1 },
      transport: shippedTransport,
    };
  }
  return {
    mode: 'development',
    // A showcase, not a default: values are opt-in in every mode, and the
    // demo opts in so the panel can show `$1 = 17` under the SQL.
    collectSqlValues: true,
  };
}

const db = await connect();
const app = Fastify({ logger: false });
if (LOUPE_MODE !== 'none') await app.register(loupe, loupeOptions());

// The application's own address — the price routes call back into it.
const self = `http://127.0.0.1:${PORT}`;

app.get('/api/order', async () => listOneOrder(db.pool, 1));
app.get('/api/orders', async () => listOrdersWithNPlusOne(db.pool, 1));
app.get('/api/orders/eager', async () => listOrdersEagerly(db.pool, 1));

// Stand-in external APIs: the demo must not depend on the outside network.
app.get('/api/external/price/:id', async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 12));
  return { id: request.params.id, price: 100 + Number(request.params.id) };
});
app.get('/api/external/inventory/:id', async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 18));
  return { id: request.params.id, inStock: true };
});

app.get('/api/prices', async () => listPricesSequentially(self));
app.get('/api/prices/parallel', async () => listPricesInParallel(self));

app.get('/api/search', async (request) => searchProducts(db.pool, request.query.q ?? 'lamp'));
app.post('/api/login', async (request) => login(db.pool, request.body));
app.post('/api/checkout', async (request) => checkout(db.pool, self, request.body));
app.post('/api/register', async (request) => registerUser(db.pool, request.body));
// Every other call takes the unlucky path — food for the Compare screen.
let flakyTurn = 0;
app.get('/api/orders/flaky', async () => listOrdersFlaky(db.pool, 1, flakyTurn++ % 2 === 1));
app.get('/api/report', async () => slowReport(db.pool));

app.get('/api/boom', async () => {
  const order = undefined;
  // Throws on purpose so the Exceptions screen has something to group.
  return order.total;
});

if (process.env.BENCH === '1') {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();

  // Memory is sampled every second and reported as a median over the last
  // 30 samples. A point-in-time read is a high-water mark: RSS on macOS never
  // comes back down and V8 returns committed heap only after seconds of idle,
  // so single reads wander by tens of megabytes between identical runs.
  const memorySamples = [];
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    memorySamples.push({ rss: m.rss, heapTotal: m.heapTotal });
    if (memorySamples.length > 30) memorySamples.shift();
  }, 1000);
  sampler.unref();

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };

  // Bench-only: these numbers can only be read from inside the process, and
  // the benchmark must not have to guess them from the outside.
  app.get('/__bench/stats', async () => {
    // What Loupe *holds* — live heap after a full collection.
    global.gc?.();
    const memory = process.memoryUsage();
    return {
      heapUsedMb: memory.heapUsed / 1024 / 1024,
      rssMb: median(memorySamples.map((s) => s.rss)) / 1024 / 1024,
      heapTotalMb: median(memorySamples.map((s) => s.heapTotal)) / 1024 / 1024,
      loopLagP99Ms: loopDelay.percentile(99) / 1e6,
      loopLagMaxMs: loopDelay.max / 1e6,
    };
  });
}

await app.listen({ port: PORT, host: HOST });

const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
console.log(`
  ${db.embedded ? 'embedded Postgres (PGlite)' : `Postgres: ${process.env.DATABASE_URL}`}

  ${
    LOUPE_MODE === 'staging'
      ? `panel — on the collector: ${process.env.LOUPE_SERVER_URL ?? 'http://127.0.0.1:4300'}/_loupe/`
      : `panel       ${base}/_loupe/`
  }
  one query   ${base}/api/order
  N+1         ${base}/api/orders
  no N+1      ${base}/api/orders/eager
  seq HTTP    ${base}/api/prices
  no seq      ${base}/api/prices/parallel
  search      ${base}/api/search?q=walnut     (EXPLAIN will show a Seq Scan)
  flaky       ${base}/api/orders/flaky        (for comparing two requests)
  slow        ${base}/api/report              (600 ms outside instrumentation — the uninstrumented bar)
  exception   ${base}/api/boom
  POST        /api/login, /api/checkout       (masking, the "incident")
  POST        /api/register                   (password hashing = a gap mid-waterfall)

  fill the panel with traffic:  pnpm --filter @loupe/example-fastify-postgres traffic
`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void (async () => {
      await app.close();
      // The batch tail must reach the collector before the process dies.
      await shippedTransport?.close();
      await db.stop();
      process.exit(0);
    })();
  });
}
