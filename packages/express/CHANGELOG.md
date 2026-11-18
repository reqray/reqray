# @reqray/express

## 0.1.1

### Patch Changes

- Updated dependencies [a52e790]
  - @reqray/core@0.1.1
  - @reqray/dashboard@0.1.1
  - @reqray/store-memory@0.1.1

## 0.1.0

### Minor Changes

- c136fbd: First release, aimed at local development.
  
  Automatic instrumentation via `node --import @reqray/register`: Fastify
  and Express, the `pg` driver (and therefore Prisma 7, which goes through
  node-postgres), outgoing HTTP via `diagnostics_channel`.
  
  The N+1 detector shows the file, the line, and the time saved. The dashboard:
  a list with filters and a live feed, waterfall, SQL with highlighting, bodies
  and headers after masking, request replay with metric comparison, exception
  groups.
- c136fbd: Staging: agent and collector.
  
  `@reqray/transport-http` sends records in batches and never blocks the
  application: the queue is bounded, the oldest records are dropped on
  overflow, and an unreachable collector means a warning and retries with
  exponential backoff.
  
  `@reqray/server` — the collector as a separate process: batch ingestion,
  storage, and the same dashboard. Without a token it listens on 127.0.0.1
  only; with a token, the dashboard is entered via `/auth?token=…`.
  
  `@reqray/nestjs` — a module in `imports`, nothing more; the Express or
  Fastify platform is detected automatically, and exceptions reach the record
  through a global filter. The Express and Fastify adapters export
  `recordFailure` for frameworks that intercept exceptions before they do.
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
- cf04d37: `@reqray/core` splits into three entry points.
  
  Importing `@reqray/core` to time a query used to link the panel with it: the
  `git blame` subprocess runner, the dashboard's static file server, replay's
  call back into the application. The recording core and the panel-reading
  core were one module graph joined by nothing but a barrel file — nothing on
  the recording path ever imported `panel/`.
  
  - `@reqray/core` — recording. Its CJS bundle no longer contains
    `require("child_process")` or `createReadStream` at all.
  - `@reqray/core/panel` — the router, the aggregates, the exports, EXPLAIN,
    replay, blame. Everything that reads back what was recorded.
  - `@reqray/core/testing` — the twelve `reset*`/`clear*` hooks a suite needs
    to scrub the process between files. They are not part of what the library
    does and no longer appear on its public surface.
  
  **Breaking:** panel symbols move to the `/panel` subpath and the reset hooks
  to `/testing`. `REPLAY_HEADER` stays on the main entry — it is read off an
  incoming request by the adapter, on the recording path.
  
  Three smaller changes ride along. The detector list lives in one registry
  object instead of three places nothing kept in agreement, and the option
  types are derived from it, so a new detector is one line; an option a
  detector does not have is now refused with a warning naming the ones it
  does. `NODE_ENV` is read once: an explicit `mode: 'production'` switches
  recording off, where before `enabled` consulted the environment separately
  and could disagree with the mode decided from it. And a `RequestScope`
  carries only the recording settings, so an instrumentation wrapper cannot
  reach the panel's gate or the retention policy's file handles.
- cf04d37: A disabled Reqray now registers nothing at all.
  
  `enabled: false` used to build the runtime and add the request hooks anyway,
  and check the flag from inside them: the hooks ran on every request, split the
  URL and allocated the object they were checked from before returning early.
  Not recording is not the same as costing nothing, and the published "disabled
  Reqray costs zero" only holds if there is no hook. Both adapters now decide once
  at registration — Fastify adds no hooks, Express hands back pass-throughs — and
  both have a test that says so.
  
  Found by re-running the overhead benchmark rather than by reading the code,
  which is what the benchmark is for. The published numbers were re-measured on
  the same hardware and now show the spread across three runs instead of one
  lucky number.
  
  The demo application also drives itself now: it calls its own routes on a loop
  covering every surface the panel has, so the panel is full the moment it is
  opened. `DEMO_TRAFFIC=off` stops it.
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
- cf04d37: The stores are called stores, and a pinned request stops vanishing.
  
  **Renamed:** `@reqray/transport-memory` → `@reqray/store-memory`,
  `@reqray/transport-sqlite` → `@reqray/store-sqlite`. Fifteen of their members
  serve the panel and two are transport; calling them transports described the
  five percent. `@reqray/transport-file` and `@reqray/transport-http` keep the
  name they earn — they are genuinely write-only.
  
  **Fixed:** a pin is somebody deliberately setting a request aside, and it
  survived a filter on a store with a `page()` of its own while disappearing on
  a store without one. The panel gave two answers depending on what was behind
  it. `pageFromList` in `@reqray/core/panel` is now the single rule: the
  router's fallback calls it and the memory store composes it. That fallback
  also pages for the first time — it used to answer `nextCursor: null`
  whatever was asked, so a store without paging of its own had no second page
  at all.
  
  Muted patterns are resolved once per panel rather than rebuilt from the
  store's whole state map at every call site, including once per request
  delivered over the live feed.
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
  - @reqray/dashboard@0.1.0
  - @reqray/store-memory@0.1.0
