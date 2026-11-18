import { reqray } from '@reqray/fastify';
import { sqliteTransport } from '@reqray/store-sqlite';
import { fileTransport, retentionPolicy } from '@reqray/transport-file';
import { httpTransport } from '@reqray/transport-http';
import Fastify from 'fastify';
import { connectCache } from './cache.js';
import { connect } from './db.js';
import { startTraffic } from './demo-traffic.js';
import { listOneOrder, listOrdersEagerly, listOrdersWithNPlusOne } from './orders.js';
import { listPricesInParallel, listPricesSequentially } from './prices.js';
import {
  checkout,
  exportPriceHistory,
  invoice,
  listOrdersFlaky,
  login,
  payHolding,
  payReleasing,
  profile,
  registerUser,
  reportBurst,
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
 * only way to measure what a disabled Reqray actually costs. `staging` ships
 * batches to a collector (`@reqray/server`) instead of keeping them in memory.
 */
const REQRAY_MODE = process.env.REQRAY_MODE ?? 'dev';

/** The staging transport — kept to flush the tail on shutdown. */
let shippedTransport = null;

/** The request log, when one is configured — closed on shutdown. */
let requestLog = null;

function reqrayOptions() {
  if (REQRAY_MODE === 'off') return { enabled: false };
  if (REQRAY_MODE === 'prod') {
    return {
      enabled: true,
      mode: 'production',
      panel: { gate: 'open' },
      ...(process.env.REQRAY_STACK === 'off' ? { stack: { maxPerFingerprint: 0 } } : {}),
    };
  }
  if (REQRAY_MODE === 'staging') {
    shippedTransport = httpTransport({
      url: process.env.REQRAY_SERVER_URL ?? 'http://127.0.0.1:4300',
      token: process.env.REQRAY_TOKEN,
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
  // One policy for everything that keeps anything, remembered on disk so a
  // change made in the panel is still there after a restart.
  const retention =
    process.env.REQRAY_DB || process.env.REQRAY_LOG
      ? retentionPolicy({
          days: Number(process.env.REQRAY_DAYS ?? 7),
          file: '.reqray/retention.json',
        })
      : null;

  // `REQRAY_DB=.reqray/requests.db pnpm start` keeps a history that survives a
  // restart; `REQRAY_LOG=.reqray/log` writes the same requests as a file per
  // day, which is what `grep` and a log shipper understand. Without either,
  // the demo uses the ring in memory — the default everywhere.
  const stores = [
    process.env.REQRAY_DB
      ? sqliteTransport({ file: process.env.REQRAY_DB, ...(retention ? { retention } : {}) })
      : null,
    process.env.REQRAY_LOG
      ? fileTransport({ dir: process.env.REQRAY_LOG, ...(retention ? { retention } : {}) })
      : null,
  ].filter(Boolean);

  requestLog = stores.find((store) => store.name === 'file') ?? null;

  return {
    mode: 'development',
    // Without a gate the panel answers only to the machine it runs on. In a
    // container that machine is not the one with the browser: the published
    // port arrives from the bridge address, so the demo image says "open"
    // out loud — the decision a real deployment has to make too.
    ...(HOST === '0.0.0.0' ? { panel: { gate: 'open' } } : {}),
    // A showcase, not a default: values are opt-in in every mode, and the
    // demo opts in so the panel can show `$1 = 17` under the SQL.
    collectSqlValues: true,
    // `REQRAY_HOST_METRICS=0` turns the event-loop histogram off, which is how
    // the benchmark measures what watching the loop costs.
    hostMetrics: process.env.REQRAY_HOST_METRICS !== '0',
    ...(retention ? { retention } : {}),
    ...(requestLog ? { requestLog } : {}),
    ...(stores.length > 0 ? { transport: stores } : {}),
  };
}

const db = await connect();
const cache = await connectCache();
const app = Fastify({ logger: false });
if (REQRAY_MODE !== 'none') await app.register(reqray, reqrayOptions());

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
// A payment provider answers in its own time, and 220 ms is a modest one.
app.get('/api/external/charge/:id', async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 220));
  return { id: request.params.id, ok: true };
});

app.get('/api/prices', async () => listPricesSequentially(self));
app.get('/api/prices/parallel', async () => listPricesInParallel(self));

app.get('/api/search', async (request) => searchProducts(db.pool, request.query.q ?? 'lamp'));
app.post('/api/login', async (request) => login(db.pool, request.body));
app.post('/api/checkout', async (request) => checkout(db.pool, self, request.body));
app.post('/api/register', async (request) => registerUser(db.pool, request.body));
// The same charge twice: once with the connection held across it, once with
// it handed back first. Same duration, and only one of them holds the pool.
app.post('/api/pay', async (request) =>
  payHolding(db.pool, self, Number(request.body?.orderId ?? 1)),
);
app.post('/api/pay/after', async (request) =>
  payReleasing(db.pool, self, Number(request.body?.orderId ?? 1)),
);
// Every other call takes the unlucky path — food for the Compare screen.
let flakyTurn = 0;
app.get('/api/orders/flaky', async () => listOrdersFlaky(db.pool, 1, flakyTurn++ % 2 === 1));
app.get('/api/report', async () => slowReport(db.pool));
// Five at once through a pool that has four: the queue, not the query.
app.get('/api/reports/burst', async () => reportBurst(db.pool));
// Megabytes of JSON out of one fast query: the mistake a waterfall cannot show.
app.get('/api/export', async () => exportPriceHistory(db.pool));
app.get('/api/invoice/:id', async (request) => invoice(db.pool, self, Number(request.params.id)));
app.get('/api/profile/:id', async (request) =>
  profile(db.pool, cache.client, Number(request.params.id)),
);

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
    // What Reqray *holds* — live heap after a full collection.
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

// The demo drives itself. An empty panel demonstrates nothing, and a reader
// should not have to call fourteen routes by hand before the product shows
// what it is. Off under the benchmark, where self-inflicted load would be
// measured as somebody's overhead, and off in tests, which assert on traffic
// they issued themselves.
const traffic =
  process.env.DEMO_TRAFFIC === 'off' || process.env.BENCH === '1'
    ? null
    : startTraffic({
        base: self,
        ...(process.env.DEMO_TRAFFIC_INTERVAL
          ? { intervalMs: Number(process.env.DEMO_TRAFFIC_INTERVAL) }
          : {}),
      });

const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
console.log(`
  ${db.embedded ? 'embedded Postgres (PGlite)' : `Postgres: ${process.env.DATABASE_URL}`}
  ${cache.embedded ? 'embedded Redis (in-process)' : `Redis: ${process.env.REDIS_URL}`}
  ${process.env.REQRAY_DB ? `history: ${process.env.REQRAY_DB} (survives a restart)` : 'history: in memory (REQRAY_DB=<file> to keep one)'}
  ${process.env.REQRAY_LOG ? `log:     ${process.env.REQRAY_LOG} (one JSON line per request, a file per day)` : 'log:     not written (REQRAY_LOG=<dir> to write one)'}

  ${
    REQRAY_MODE === 'staging'
      ? `panel — on the collector: ${process.env.REQRAY_SERVER_URL ?? 'http://127.0.0.1:4300'}/_reqray/`
      : `panel       ${base}/_reqray/`
  }
  one query   ${base}/api/order
  N+1         ${base}/api/orders
  no N+1      ${base}/api/orders/eager
  seq HTTP    ${base}/api/prices
  no seq      ${base}/api/prices/parallel
  search      ${base}/api/search?q=walnut     (EXPLAIN will show a Seq Scan)
  flaky       ${base}/api/orders/flaky        (for comparing two requests)
  slow        ${base}/api/report              (over the budget; the time is outside instrumentation)
  duplicate   ${base}/api/invoice/1           (the same external call made twice)
  cache       ${base}/api/profile/1           (the same cache key read twice)
  exception   ${base}/api/boom
  POST        /api/login, /api/checkout       (masking, the "incident")
  POST        /api/register                   (password hashing = a gap mid-waterfall)

  ${
    traffic
      ? 'the demo is calling these routes itself — the panel fills on its own.\n  a burst on demand:            pnpm --filter @reqray/example-fastify-postgres traffic\n  to stop the loop:             DEMO_TRAFFIC=off'
      : 'fill the panel with traffic:  pnpm --filter @reqray/example-fastify-postgres traffic'
  }
`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void (async () => {
      traffic?.stop();
      await app.close();
      // The batch tail must reach the collector before the process dies.
      await shippedTransport?.close();
      // The last lines are still in the stream's buffer; closing writes them.
      await requestLog?.close();
      await cache.stop();
      await db.stop();
      process.exit(0);
    })();
  });
}
