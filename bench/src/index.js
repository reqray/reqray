/**
 * Overhead benchmark.
 *
 * Reqray runs inside somebody else's application, on the hot path. These
 * numbers are the main argument for anyone putting it into production, and no
 * competitor publishes theirs — so the benchmark is part of the product, not
 * a formality.
 *
 * Every scenario runs against the real demo application from
 * `examples/fastify-postgres`, never against a synthetic handler, and each one
 * is measured three times in the same process lineage: Reqray off, Reqray in
 * production mode with 1% sampling, and Reqray in development mode at 100%.
 *
 *   pnpm bench
 *   pnpm bench --scenario light
 *   pnpm bench --duration 10
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';
import EmbeddedPostgres from 'embedded-postgres';

const exampleRoot = fileURLToPath(new URL('../../examples/fastify-postgres/', import.meta.url));
const serverRoot = fileURLToPath(new URL('../../packages/server/', import.meta.url));

const SCENARIOS = [
  { name: 'light', path: '/api/order', about: 'one SQL query, small response' },
  { name: 'typical', path: '/api/orders/eager', about: '2 SQL, 150-order response' },
  { name: 'heavy', path: '/api/orders', about: 'deliberate N+1, 150 queries' },
];

const MODES = [
  { name: 'none', env: 'none', about: 'not attached' },
  { name: 'off', env: 'off', about: 'enabled: false' },
  { name: 'prod', env: 'prod', about: 'prod, 1% sample' },
  { name: 'dev', env: 'dev', about: 'development, 100%' },
  // 100% retention shipped in batches to a collector in its own process —
  // the docker-compose.staging.yml shape.
  { name: 'staging', env: 'staging', about: 'staging, batches' },
];

/** The first seconds are JIT warm-up and are thrown away, not measured. */
const WARMUP_SECONDS = 5;
const DEFAULT_SECONDS = 30;
const CONNECTIONS = 20;

/**
 * Requests per second to hold.
 *
 * The project budget is stated at 1000 rps, and that is what gets
 * published. Saturating the CPU instead measures the throughput ceiling — a
 * different, also useful number, but not the one the budget is about: at the
 * ceiling every per-request cost is compared against a handler that does
 * almost nothing, and any of them looks enormous.
 */
const DEFAULT_RATE = 1000;

function parseArgs(argv) {
  const args = { duration: DEFAULT_SECONDS, scenario: null, rate: DEFAULT_RATE, modes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--duration') args.duration = Number(argv[++i]);
    if (argv[i] === '--scenario') args.scenario = argv[++i];
    if (argv[i] === '--rate') args.rate = Number(argv[++i]);
    // Comma-separated subset of modes; `none` is always kept as the baseline.
    if (argv[i] === '--modes') args.modes = argv[++i].split(',');
    // Unlimited: shows the throughput ceiling instead of the budgeted load.
    if (argv[i] === '--saturate') args.rate = 0;
  }
  return args;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Still starting: seeding the embedded database takes a moment.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`application did not come up: ${url}`);
}

/**
 * Starts a real Postgres in its own process.
 *
 * The database must not share the event loop with the application: otherwise
 * Reqray's work competes with the query engine and the measured overhead is an
 * artefact rather than a number. That rules out the demo's embedded PGlite,
 * which is fine for correctness tests and useless here.
 */
async function startDatabase() {
  const dataDir = mkdtempSync(join(tmpdir(), 'reqray-bench-'));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  await postgres.initialise();
  await postgres.start();

  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await postgres.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Starts the collector the staging mode ships to. */
async function startCollector() {
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/cli.js'], {
    cwd: serverRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitFor(`http://127.0.0.1:${port}/healthz`, 15_000);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`collector did not come up: ${error.message}\n${stderr.trim()}`);
  }
  return {
    url: `http://127.0.0.1:${port}`,
    stop() {
      child.kill('SIGKILL');
    },
  };
}

async function startApp(mode, port, databaseUrl, collectorUrl) {
  const app = spawn(
    process.execPath,
    // `--expose-gc` so heap can be read after a forced collection: that number
    // catches leaks, while RSS shows real consumption. `none` runs without
    // `--import` at all: with the standalone mode the mere import now
    // instruments, and the baseline must be a true baseline.
    mode === 'none'
      ? ['--expose-gc', 'src/index.js']
      : ['--expose-gc', '--import', '@reqray/register', 'src/index.js'],
    {
      cwd: exampleRoot,
      env: {
        ...process.env,
        PORT: String(port),
        REQRAY_MODE: mode,
        BENCH: '1',
        NODE_ENV: '',
        DATABASE_URL: databaseUrl,
        ...(collectorUrl ? { REQRAY_SERVER_URL: collectorUrl } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  // Keep stderr: a bare "did not start" timeout hides why.
  let stderr = '';
  app.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitFor(`http://127.0.0.1:${port}/api/order`, 90_000);
  } catch (error) {
    app.kill('SIGKILL');
    throw new Error(`${error.message}\n${stderr.trim()}`);
  }
  return app;
}

async function load(url, seconds, rate) {
  return autocannon({
    url,
    connections: CONNECTIONS,
    duration: seconds,
    pipelining: 1,
    ...(rate > 0 ? { overallRate: rate } : {}),
  });
}

async function measure(scenario, mode, seconds, databaseUrl, rate) {
  const port = await freePort();
  const collector = mode.env === 'staging' ? await startCollector() : null;
  const app = await startApp(mode.env, port, databaseUrl, collector?.url);
  const base = `http://127.0.0.1:${port}`;

  try {
    await load(`${base}${scenario.path}`, WARMUP_SECONDS, rate);
    const result = await load(`${base}${scenario.path}`, seconds, rate);
    // Memory numbers are medians the application sampled during the load
    // window — see the demo's BENCH block for why point reads are useless.
    const stats = await (await fetch(`${base}/__bench/stats`)).json();

    return {
      p50: result.latency.p50,
      p95: result.latency.p97_5,
      p99: result.latency.p99,
      max: result.latency.max,
      rps: result.requests.average,
      errors: result.errors + result.non2xx,
      ...stats,
    };
  } finally {
    app.kill('SIGKILL');
    collector?.stop();
  }
}

function delta(value, baseline) {
  const diff = value - baseline;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${diff.toFixed(diff >= 10 ? 0 : 1)}`;
}

function report(scenario, results, rate, modes = MODES) {
  const off = results.none;
  console.log(`\n${scenario.name} — ${scenario.about}`);

  // Below the target rate the scenario is at its ceiling, and the deltas stop
  // being about overhead: they are about what the machine had left.
  if (rate > 0 && off.rps < rate * 0.95) {
    console.log(
      `  ! the scenario cannot hold ${rate} rps even without Reqray (${off.rps.toFixed(0)}) — ` +
        'the numbers below show the ceiling, not the budget',
    );
  }
  // `V8 heap` — median committed V8 heap while under load: this is the number
  // the memory budget is checked against. `retained` — live heap after a full
  // GC, i.e. what Reqray holds on to; the README uses the same word. `rss` —
  // median under load, shown for honesty: it is a process high-water mark and
  // its deltas are dominated by GC timing.
  console.log(
    '  mode                 p50     p99     max      rps V8 heap   retained      rss  lag p99',
  );
  for (const mode of modes) {
    const r = results[mode.name];
    const suffix =
      mode.name === 'none'
        ? ''
        : `   Δp99 ${delta(r.p99, off.p99)} ms, Δheap ${delta(r.heapTotalMb, off.heapTotalMb)} MB, rps ${(((r.rps - off.rps) / off.rps) * 100).toFixed(1)}%`;

    console.log(
      `  ${mode.about.padEnd(18)} ${String(r.p50).padStart(5)}   ${String(r.p99).padStart(5)}   ` +
        `${String(r.max).padStart(5)}   ${r.rps.toFixed(0).padStart(6)}   ` +
        `${r.heapTotalMb.toFixed(1).padStart(6)}   ${r.heapUsedMb.toFixed(1).padStart(6)}   ` +
        `${r.rssMb.toFixed(1).padStart(6)}   ${r.loopLagP99Ms.toFixed(2).padStart(6)}${suffix}`,
    );
    if (r.errors > 0) console.log(`     ! errors under load: ${r.errors}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const scenarios = args.scenario ? SCENARIOS.filter((s) => s.name === args.scenario) : SCENARIOS;
const modes = args.modes
  ? MODES.filter((m) => m.name === 'none' || args.modes.includes(m.name))
  : MODES;

if (scenarios.length === 0) {
  console.error(`unknown scenario: ${args.scenario}`);
  process.exit(1);
}

console.log(
  `Reqray overhead · ${scenarios.length} scenarios × ${modes.length} modes · ` +
    `${args.duration}s measured after ${WARMUP_SECONDS}s of warm-up · ` +
    `${args.rate > 0 ? `${args.rate} rps` : 'unlimited'} · ${CONNECTIONS} connections`,
);

const external = process.env.DATABASE_URL;
const database = external ? null : await startDatabase();
const databaseUrl = external ?? database.url;
if (!external) console.log('Started a dedicated Postgres in a separate process.\n');

try {
  for (const scenario of scenarios) {
    const results = {};
    for (const mode of modes) {
      results[mode.name] = await measure(scenario, mode, args.duration, databaseUrl, args.rate);
    }
    report(scenario, results, args.rate, modes);
  }
} finally {
  await database?.stop();
}

console.log('\nMeasured on:', process.version, process.platform, process.arch);
console.log(`Database: Postgres in a separate process${external ? ' (DATABASE_URL)' : ''}.`);
