# @reqray/server

## 0.1.0

### Minor Changes

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
- cf04d37: Follow-ups to the audit.
  
  - `apiKey`, `signature` and `cvv` join the default mask list for bodies and
    query strings.
  - The startup report says when the panel has no gate and so answers its own
    machine only, and how to open it.
  - `@reqray/transport-http` caps its queue by size (`maxQueueBytes`, 8 MB) as
    well as by count, and honours `Retry-After`.
  - The collector answers 429 with `Retry-After` once eight batches are on
    their way in.
  - A live feed whose reader has stopped reading is dropped past 1 MB of
    backlog instead of growing in the application's memory.
  - Dashboard: an EXPLAIN answer no longer lands on a different request; the
    list re-reads itself after a pause or a visit to another screen; pinned
    requests stay out of time-scoped lists; the compare verdict's percentage
    reads the same in both directions.
- cf04d37: A request history that outlives the process, and a list that pages.
  
  Until now every request lived in a ring in memory — the last five hundred in
  the application, two thousand in the collector — and a restart threw all of it
  away. That is a defensible default for a dev panel and no answer at all to
  "what happened an hour ago". Storage was always a transport, so now there is
  one for keeping things:
  
  ```js
  import { sqliteTransport } from '@reqray/store-sqlite';
  
  await app.register(reqray, {
    transport: sqliteTransport({ file: '.reqray/requests.db' }),
  });
  ```
  
  The collector takes the same store through `REQRAY_DB=/var/lib/reqray/requests.db`.
  
  **`node:sqlite`, so nothing is compiled at install time.** Node has shipped
  SQLite since 22.5, which is what this package requires — storage that needs a
  build toolchain is storage most people never switch on.
  
  **Retention is a promise about disk, not a hope.** Two budgets, whichever runs
  out first: `maxRequests` (20 000) and `maxBytes` (256 MB). Past them the oldest
  go — except pinned requests, since the point of a pin is that it is the one you
  are working on.
  
  **The list pages, and the filter reaches the store.** `/api/requests` answers
  with one page and a cursor, and takes the whole filter — method, status,
  duration, search text, N+1s, test-issued, one route — so narrowing means
  narrowing everything stored rather than everything loaded. The panel loads a
  page, keeps the live feed prepending to it, and offers "older requests" at the
  end of the list.
  
  Both stores implement the same paging, so the panel behaves identically over
  either, and a test fills both with the same records and demands the same ids
  back for seventeen filters — including the ones where a search for `%` or `a_i`
  would otherwise be read as SQL wildcards.
  
  Fixed along the way: the panel kept exactly 500 rows in the browser regardless
  of what the server actually held, so a larger buffer made the list silently
  shrink to a third of itself while the reader watched. It now takes the size
  from the panel meta.
- cf04d37: A log on disk, and one retention setting the panel can change.
  
  A database is what the panel reads. It is not what `grep` reads, what `tail -f`
  follows, what a log shipper picks up, or what an operator copies off a machine
  before the container is gone. `@reqray/transport-file` writes the same requests
  as one line of JSON each, in a file per day, beside whatever store the panel is
  reading:
  
  ```js
  import { fileTransport, retentionPolicy } from '@reqray/transport-file';
  
  const retention = retentionPolicy({ days: 7, file: '.reqray/retention.json' });
  
  await app.register(reqray, {
    retention,
    transport: [
      sqliteTransport({ file: '.reqray/requests.db', retention }),
      fileTransport({ dir: '.reqray/log', retention }),
    ],
  });
  ```
  
  On the collector it is two variables: `REQRAY_LOG=/var/lib/reqray/log` and
  `REQRAY_DAYS=7`.
  
  **Several transports, one stream of requests.** `transport` takes a list now. A
  store and a log have nothing to say to each other, and a transport that throws
  is reported once and skipped — a broken log must not cost the panel its data.
  The panel finds the store among them; when none of the transports keeps
  anything it says so at startup rather than leaving a 404 to be explained.
  
  **One retention policy, three readers.** `retentionPolicy` holds days, size and
  count, and the SQLite store, the log and the panel all read the same object, so
  "a week" means one thing wherever it is shown. Age is a limit the store did not
  have: it sweeps when the policy changes, on a throttle while requests arrive,
  and it declines to store a request that is already past the limit — batches
  from a collector arrive late, and writing something only to sweep it a minute
  later is work nobody asked for. Pinned requests are exempt, as they are from
  every other limit.
  
  **The Project tab can change it.** A Retention card shows what is kept, what
  the store holds, what the log holds and where it is, and — when the application
  passed a writable policy — changes the number. The stores sweep on the news
  rather than at the next restart, and the value is remembered in a small JSON
  file that is read at startup and wins over what is written in code: a setting
  that resets when the process does is not a setting. Lowering it deletes data,
  which is why it is the only setting the panel writes, why the numbers are
  checked again on arrival, and why a policy can be created `writable: false`.
  
  Writing is streamed and never on the request path. A write that fails takes the
  log down and nothing else, with one warning; a log that falls behind the
  application drops lines and counts them rather than growing the heap, and the
  count is on the card.
  
  Also fixed: the panel's relative times counted minutes forever, so anything
  older than a couple of hours read as `10080m ago`. They degrade through hours
  and days now — which the git blame lines on the Exceptions screen needed too.
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

### Patch Changes

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
  - @reqray/store-sqlite@0.1.0
  - @reqray/transport-file@0.1.0
  - @reqray/store-memory@0.1.0
