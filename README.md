# Loupe

A dev panel and request-inspection tool for Node.js. Plugs in with a single
line, instruments HTTP and SQL on its own, shows every request as a waterfall,
and finds N+1 **down to the file, the line, and the time saved**.

Think Laravel Telescope for the Node ecosystem, with two differences: the
instrumentation is fully automatic — no `recordQuery` calls in your code — and
the core is designed for production, not just localhost.

> You see one specific slow request whole — SQL, bodies, outgoing calls, the
> log — and you know at once which line of code is slowing it down.

We don't compete with Datadog or New Relic on aggregates and charts. Loupe is
about the post-mortem of a single request and about finding N+1 — the things
big APMs don't do.

## What it looks like

```
150 identical queries ran in a loop
  src/orders.js:26
  ~29 ms recoverable out of the 48 ms request
  → Collect the ids and fetch "line_items" with a single
    WHERE … IN (…) instead of a query per iteration
```

Not "this request made 151 database calls" but "here is the line, here is how
much time comes back, here is what to do".

![Request detail with an N+1 finding](docs/screenshots/02-detail-nplus1.png)

On the left, the waterfall: a run of 150 identical queries folded into a
single bar. Below it, a callout with the finding's cost and the line of code;
below that, the SQL, with the repeats collected into one row marked `150 calls`.

![Request list](docs/screenshots/01-requests.png)

Try it with a single command. Via Docker, with a real Postgres in a
neighboring container:

```bash
docker compose up --build
# open http://localhost:3000/api/orders, then http://localhost:3000/_loupe/
```

Or with no Docker at all — the database comes up embedded:

```bash
pnpm build && pnpm --filter @loupe/example-fastify-postgres start
# open http://127.0.0.1:3000/api/orders, then http://127.0.0.1:3000/_loupe/
```

To make the panel look like a live application from the start, fill it with
ready-made traffic from a second terminal — searches, logins, checkouts,
errors:

```bash
pnpm --filter @loupe/example-fastify-postgres traffic
```

The screenshots above come from this very demo: a UI test takes them in a
real browser, and the same test checks that the panel rendered at all.

## Getting started

**Zero lines of code** — adding `--import` to the launch is enough:

```bash
pnpm add -D @loupe/register
node --import @loupe/register app.js
```

If the application has no Loupe adapter, register intercepts incoming HTTP on
its own through Node's standard `diagnostics_channel` and brings the panel up
on a neighboring port:

```
loupe: no adapter found — panel is up at http://127.0.0.1:4310/_loupe/
```

This is the "try it in 30 seconds" mode: SQL, outgoing calls, the waterfall
and the detectors already work. The limitations are honest — request bodies
are not collected (reading someone else's stream is off limits), Replay is
unavailable, paths come without route normalization. The port is
`LOUPE_PANEL_PORT`; turn it off with `LOUPE_STANDALONE=off`.

**Full recording** — an adapter in one line:

```bash
pnpm add @loupe/fastify @loupe/register
```

```js
import Fastify from 'fastify';
import { loupe } from '@loupe/fastify';

const app = Fastify();
await app.register(loupe);
```

```bash
node --import @loupe/register app.js
```

`--import` is mandatory: the loader hooks must be in place before the
application loads its database driver. Launch without it and Loupe will say so
at startup rather than stay silent:

```
loupe  instrumentation active
  ✔ fastify@5.12.0       requests
  ✔ pg@8.23.0            SQL
  ✔ undici (built-in)    outgoing HTTP
```

Express takes two handlers — Express hands exceptions only to the error
handler, and it has to go after the routes:

```js
const inspector = loupe();
app.use(inspector.middleware);
// ...routes...
app.use(inspector.errorHandler);
```

For NestJS — a module in `imports`; the platform (Express or Fastify) is
detected on its own:

```ts
import { LoupeModule } from '@loupe/nestjs';

@Module({
  imports: [LoupeModule.forRoot()],
})
export class AppModule {}
```

## Staging: agent and collector

Locally the data lives in process memory. Wherever the process is reachable
from outside, the application only collects and ships batches, while storage
and the panel live in a separate process — `@loupe/server`:

```js
import { httpTransport } from '@loupe/transport-http';

await app.register(loupe, {
  enabled: true,
  mode: 'production',
  panel: false, // the panel lives on the collector
  transport: httpTransport({
    url: 'http://loupe-collector:4300',
    token: process.env.LOUPE_TOKEN,
  }),
});
```

```bash
npx @loupe/server            # LOUPE_TOKEN=… HOST=0.0.0.0 — to listen externally
```

The transport never blocks the application: the queue is bounded, on overflow
the **oldest** entries are dropped, and an unreachable collector is a log
warning plus exponential-backoff retries, not growing memory. Without a token
the collector listens only on 127.0.0.1; with a token, panel sign-in is
`/auth?token=…`.

The fully assembled stack is in `docker-compose.staging.yml`:

```bash
docker compose -f docker-compose.staging.yml up --build
# application: http://localhost:3000/api/orders
# panel:       http://localhost:4300/auth?token=staging-secret
```

## What's already there

| | |
|---|---|
| Frameworks | Fastify 5, Express 4/5, NestJS 10/11 (both platforms), any `node:http` — in standalone mode |
| Database | `pg` (and Prisma 7 — it goes through node-postgres) |
| Outgoing HTTP | undici and the built-in `fetch`, via `diagnostics_channel`; the calling line of code — via the `fetch` wrapper |
| Detectors | N+1; sequential HTTP calls (a missed `Promise.all`) |
| Panel | list with filters and a live feed, waterfall, SQL with EXPLAIN, bodies, headers, logs, request replay, exception groups |
| Logs | `console.*` calls made during handling land in their request's record; terminal output is unchanged. pino/winston write past console and are not captured yet |
| Transport | in-memory locally; HTTP batches with backpressure to `@loupe/server` |

**EXPLAIN — one click on a SQL span.** The query plan with hints right in the
detail view: a Seq Scan with a filter is flagged with "An index on the
filtered column may help". The SQL comes from the record — the panel client
cannot send its own; `ANALYZE` is never used, so nothing ever executes;
parameterized queries are planned via `GENERIC_PLAN` (PostgreSQL 16+);
EXPLAIN goes to the same pool that ran the original query. Outside local
development it is opt-in only: `loupe({ explain: true })`.

## Security

- `enabled` defaults to `NODE_ENV !== 'production'`.
- Sensitive fields are masked **before** they reach the buffer, not at
  display time. By default `authorization`, `cookie`, `set-cookie` are covered
  in headers and `password`, `token`, `secret`, `cardNumber` in bodies.
- The panel does not mount without an explicit gate anywhere except local
  development (`NODE_ENV` is `development`, `test`, or unset). In staging the
  application fails at startup with an explanation instead of silently
  opening access.
- Request replay outside local development is forbidden and enabled only by an
  explicit flag: a replay in production is a second card charge and a second
  email.
- SQL parameter values are not collected in any mode. For local debugging
  there is an explicit opt-in, `collectSqlValues: true` — enable it
  deliberately: positional values carry no field names, so name-based masking
  does not protect them. Values are never interpolated into EXPLAIN.

## Overhead

Loupe executes inside someone else's application, on the hot path, so the
overhead numbers are part of the product, not a formality. The benchmark
lives in `bench/` and runs three scenarios against the real demo application:

```bash
DATABASE_URL=postgresql://... pnpm bench
```

Conditions: Fastify 5 + pg + Postgres 18 as a separate process, Node 24, macOS
arm64, 1000 rps, 20 connections, 30 s measured after 5 s of warmup. Deltas are
against an application with the plugin not installed at all. Memory figures
are medians of per-second samples under load; "retained" is the heap after a
forced GC.

```
                        p99     retained    V8 heap
one SQL query, small response
  enabled: false      +3.0 ms     +0.2 MB     +0.0 MB
  prod, 1% sample     +1.0 ms     +2.1 MB      +55 MB
  development, 100%   +3.0 ms     +0.6 MB     +118 MB
  staging, batches    +5.0 ms     +3.2 MB     +122 MB

2 SQL queries, a 150-order response
  enabled: false      +0.0 ms     +1.8 MB      −18 MB
  prod, 1% sample     +1.0 ms      +12 MB      +34 MB
  development, 100%   +2.0 ms      +16 MB      +33 MB
  staging, batches    +9.0 ms     +5.6 MB      +23 MB
```

**Disabled Loupe costs zero** — the jitter in its rows (+3 ms, −18 MB) is
exactly the scale of noise between runs: disabled Loupe executes not a single
line.

**Staging here ships 100% of requests** — that is the demo-stand
configuration, so that every click shows up in the collector panel. Shipping
full bodies at ~29 MB/s costs tail latency: +9 ms p99 on the typical
scenario. With the production sample share (1%) the shipping disappears from
the tails. Meanwhile the agent retains less than any mode with a panel — the
transport queue holds already-serialized strings, not objects.

**In production and development the latency overhead is not measurable at this
load**: the p99 deltas sit within the resolution of autocannon, which reports
whole milliseconds, and change sign from run to run. Only staging's full
shipping is measurable — see above.

**Memory is two different numbers, and they must not be confused.**
"Retained" is what Loupe actually holds on to: the request buffer with spans
and bodies. Production is +2…12 MB against a +15 budget, development up to
+16 against a +60 budget. "V8 heap" is how much committed memory the process
occupies under load on top of the baseline: it is tens of megabytes larger
not because of Loupe's data but because of V8 policy — under any noticeable
per-request allocation churn it inflates the young generation, trading memory
for speed, and gives it back when idle. Verified by bisection: the entire
difference appears at the span-recording layer at ~2 MB/s of allocations, and
with `node --max-semi-space-size=4` it collapses to +8 MB with no latency
loss at this load — which is exactly the recommendation for memory-constrained
deployments. RSS is not shown in the table: on macOS it is a high-water mark
that does not come down even after V8 has returned the memory, and its deltas
measure GC timing luck.

The deliberate-N+1 scenario is not in the table: it cannot hold 1000 rps even
without Loupe (~420), so what gets measured there is the machine's ceiling.
The benchmark says so in a separate line, so that ceiling numbers are not
mistaken for budget numbers.

## What's not there yet

An honest list, so you don't discover it on your own application:

- **Bundled applications** (esbuild, Next.js). The bundler resolves imports at
  build time, so the loader hook simply never fires — automatic
  instrumentation cannot work in principle; explicit registration is all
  that remains.
- **Attribution to Prisma.** Prisma 7 queries are visible because it reaches
  the database through node-postgres, but the span is labeled `pg`: the hint
  comes out generic instead of "add `include`", and the model name is not
  recorded.
- **Callsite for outgoing HTTP.** `diagnostics_channel` publishes its event
  from inside undici's dispatcher, when no frame of the calling code is left
  on the stack.
- **Separate middleware spans.** For now a single span covers the whole
  handling; the nesting of SQL, cache and outgoing HTTP inside it is still
  correct.
- **SQLite storage and OpenTelemetry** — planned for v0.3.

## Development

```bash
pnpm install
pnpm build      # build must run before tests: the loader-hook e2e launches node --import
pnpm test
pnpm lint
pnpm typecheck
```
