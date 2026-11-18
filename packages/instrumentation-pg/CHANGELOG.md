# @reqray/instrumentation-pg

## 0.1.0

### Minor Changes

- cf04d37: What the connection was doing
  
  A query that took 340 ms because it waited 338 of them for a free connection
  is drawn exactly like a query that worked for 340, and the reader goes off to
  add an index that will not help. Reqray now measures the queue in front of a
  query and the time a transaction holds a connection open — the two things a
  waterfall cannot show, and the two the pool runs out of connections for.
  
  **The queue.** `Pool.connect` is instrumented, and the wait lands on the query
  as `waitMs`, drawn as a hatched lead-in on its own bar rather than as another
  row. It is recorded only when the acquire genuinely queues: an idle connection
  handed over on the next tick is scheduling, and a brand-new connection is TCP
  and authentication, which is fixed by warming the pool rather than enlarging
  it. The `pool_wait` finding fires when a query waited longer than it ran, and
  says what to look at upstream instead of telling anybody to raise `max`.
  
  **The hold.** Spans now carry the physical connection they ran on, which turns
  `BEGIN` … `COMMIT` into a transaction without recording anything new. The
  `transaction_hold` finding names the classic that is invisible to anything
  seeing only SQL or only outgoing calls: a payment API called with the
  transaction still open, two hundred milliseconds of a connection nobody else
  can use. It points at the call, not at the `BEGIN`, and reports what was held
  rather than a saving — moving the call out does not make that request faster,
  it gives the connection back sooner.
  
  The Project tab gained the pools themselves: size, connections open, and
  whether anything is queueing right now.
  
  **And a repair worth more than the feature.** A query that had to wait for a
  connection was being filed under whoever released one — a request that had
  already finished, or no request at all. Five queries issued through
  `Promise.all` on a pool of one arrived in the panel as one. The queue now
  carries the request across, along with the callsite it was issued from, and
  the N+1 detector judges a run by when its queries were *issued* rather than
  when they got to run — so a pool with one connection no longer turns
  `Promise.all` into an N+1.
  
  The overhead benchmark is unchanged: p99 identical across the matrix, with the
  queue check reading four numbers and allocating nothing.
- c136fbd: Main-screen quality and collaboration.
  
  **Request log.** `console.*` lines written during handling land in the record
  of that exact request — terminal output is unchanged. Capped at
  200 lines, lines containing sensitive words are replaced with a marker,
  `logs: false` turns it off.
  
  **Permalink.** `#/req/<id>` — the URL of a specific trace can be shared in chat
  and opens the same detail view; a "copy link" button in the header.
  
  **Comparing two requests.** `#/compare/<a>/<b>` — two waterfalls on a single
  timeline plus a diff by work group: you can see exactly where they diverged.
  
  **"Copy for AI".** A button assembles the request breakdown as markdown —
  findings with the code line, waterfall, SQL, EXPLAIN plans — and puts it on
  the clipboard. No keys and no network: the data never leaves the machine.
  
  **SQL parameter values** — only via an explicit `collectSqlValues: true`; the
  default is `false` in every mode; values are never substituted into EXPLAIN.
- c136fbd: First release, aimed at local development.
  
  Automatic instrumentation via `node --import @reqray/register`: Fastify
  and Express, the `pg` driver (and therefore Prisma 7, which goes through
  node-postgres), outgoing HTTP via `diagnostics_channel`.
  
  The N+1 detector shows the file, the line, and the time saved. The dashboard:
  a list with filters and a live feed, waterfall, SQL with highlighting, bodies
  and headers after masking, request replay with metric comparison, exception
  groups.
- c136fbd: Zero lines of code, a sequential-HTTP detector, and EXPLAIN from the dashboard.
  
  **Standalone mode.** `node --import @reqray/register app.js` — and the dashboard
  works without a single code change: incoming HTTP is intercepted through the
  built-in `diagnostics_channel`, and the dashboard comes up on a neighboring
  port (4310). Any adapter automatically turns the mode off. No request bodies
  and no Replay — the limitations are stated right in the startup line.
  
  **`sequential_http` detector.** An `await fetch` loop over a list is the same
  disease as a query in a loop: the finding shows the code line and the savings
  from `Promise.all`. The heuristics are the same as for N+1; different URLs in
  a row are not flagged — a data dependency is invisible from timing alone.
  Along the way, outgoing HTTP spans gained the code line of the call — the
  `fetch` wrapper captures the stack while the user's frame is still on it.
  
  **EXPLAIN from the dashboard.** Click an SQL span to get the plan with hints
  ("Seq Scan with a filter — an index may be needed"). The SQL comes from the
  record, `ANALYZE` is never used, parameterized queries go through
  `GENERIC_PLAN` (PostgreSQL 16+), and the plan runs on the same pool that
  executed the query. Outside local development it is enabled only explicitly:
  `reqray({ explain: true })`.

### Patch Changes

- cf04d37: Twenty fixes from an audit of the whole repository.
  
  **Behaviour that changes**
  
  - A panel with no gate answers only to its own machine: a loopback connection
    addressed to `localhost` or `127.0.0.1`. Reaching it from another machine,
    through a proxy or from outside a container now takes a gate —
    `panel: { gate: 'open' }` says so explicitly. A collector started without a
    token follows the same rule and accepts `/ingest` only as
    `application/json`.
  - Sensitive query parameters are masked like body fields, in the request's
    own URL and in the URLs of outgoing calls.
  - `@reqray/nestjs` observes exceptions with an interceptor instead of a
    catch-all filter, so the application's own exception filter decides the
    response again. `ReqrayExceptionFilter` is gone; `rxjs` is a peer dependency.
  - `register()` takes no options. Its `instrumentations` list could never be
    honoured — importing the package had already registered. Explicit
    registration is `instrumentPg().apply(pg)`.
  - Request ids carry a 40-bit process prefix; the CLI's id column is wider.
  
  **Fixes**
  
  - A test name from a header can no longer inject a line into an exported curl
    script, and control characters never reach the terminal from the CLI.
  - A malformed `%` in a panel URL is a 400, not an uncaught exception.
  - Streams are never recorded as bodies.
  - The N+1 detector no longer reports keyset paging — a `LIMIT` query repeated
    until a short page.
  - Outgoing calls are recorded when the headers arrive, so a response whose
    body is never read still leaves a span.
  - pg is patched when the loader hands over an ESM namespace with the classes
    under `default`.
  - Fastify records requests the client aborted; Express forwards every
    argument of `res.json` / `res.send`.
  - The SQLite store counts only what it can evict, sweeps in steps rather than
    on every write, and no longer stays over budget because of a pin.
  - The HTTP transport's `close()` waits for the batch on the wire; the file
    transport keeps its size cap under a shared retention policy.
  - Paging over an in-memory list is ordered, so a slow request beside a page
    boundary is neither skipped nor repeated.
  - The live feed no longer pushes matching rows out of a filtered list, and
    the history chart honours `status:` and `method:` typed into the search.
- cf04d37: Manifests that tell the truth, and one place for the patching rules.
  
  A Nest application on Fastify installed `@reqray/express` through
  `@reqray/nestjs` and got an unmet peer dependency for Express, a framework it
  does not use — and the reverse on Express. Both adapter peers are optional
  now, which is what every instrumentation already did.
  
  `@reqray/server` declared Node >= 20 while hard-depending on
  `@reqray/store-sqlite`, which needs 22.5: `EBADENGINE` on every Node 20
  install. Its floor matches the store it ships with.
  `@reqray/instrumentation-ioredis` claimed `>=5 <7`, promising an ioredis 6
  that does not exist and would have been patched untested; it says `>=5 <6`.
  `@reqray/instrumentation-prisma` is no longer published — it was an empty
  module that installed core and asked for a Prisma peer it never patched. Its
  reasoning stays in the repo, and README already says what it said.
  
  `@reqray/core` gains `patchMethod`, `unpatchMethod`, `isPatched`, `settle`,
  `settleCallback` and `guarded`: the plumbing all three instrumentations kept
  a copy of. Idempotence is keyed per method name, so two patches on one
  prototype can no longer share a flag — `Pool.prototype` needed a second
  symbol pair to work around exactly that. Driver knowledge stays in each
  instrumentation; only the mechanics moved.
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [c136fbd]
- Updated dependencies [c136fbd]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [c136fbd]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [cf04d37]
- Updated dependencies [21cfe4f]
- Updated dependencies [c136fbd]
  - @reqray/core@0.1.0
