# @reqray/core

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
- cf04d37: Redis, for real: `@reqray/instrumentation-ioredis`.
  
  The panel has had a Cache tab and a duplicate-read detector for a while, and
  nothing to fill them with. Now `ioredis` 5 and 6 are instrumented — standalone
  clients, cluster clients and pipelines alike — with no configuration beyond the
  `node --import @reqray/register` that was already required.
  
  **What a cache span holds.** The command as the driver sent it (`GET`,
  `HGETALL`, `EXPIRE`), the key, how long it took, whether it hit, and the line
  of application code that made the call. Cache **values are never recorded** —
  in any mode, with no opt-in to change that: `SET session:9 <jwt>` is recorded
  as `SET session:9`. Which arguments are a key is decided per command, and a
  command Reqray does not recognise records its name and nothing else, which is
  what keeps `AUTH` and custom commands from leaking through.
  
  **The duplicate-read detector now has teeth.** `dup_cache` groups by the whole
  call rather than the key alone, so two reads of different fields of one hash
  are two reads, not a false positive; a command that reads *and* removes
  (`LPOP`, `SPOP`) is never called a duplicate, and neither is one whose member
  argument cannot be recorded. When it does fire, the finding names both the
  line it fired on and the other line that read the same thing.
  
  **Why patching and not `diagnostics_channel`.** ioredis publishes a tracing
  channel since 5.11, and its arguments arrive sanitized: `HGET`, `HGETALL` and
  `MGET` come through with the key replaced by `?`. A key-level cache view cannot
  be built on that, and a detector grouping by `?` would report every hash read
  in a request as one duplicate. So `sendCommand` is wrapped instead, and the
  value positions are dropped here — deliberately, per command.
  
  The demo application gained `GET /api/profile/1`: a cache in front of the
  database, with one read of the same key too many. It runs against an
  in-process Redis-compatible server by default, so it still needs no Docker;
  set `REDIS_URL` to point it at a real one.
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
- cf04d37: The detail answers "what do I change" before it explains itself
  
  The costliest finding now leads the request detail as THE FIX: what fired,
  what it costs this request, the statement, the line of code as a link into
  the editor — and the ways out. A fix prompt scoped to this one finding for
  whatever assistant is at hand, "show the N calls" landing the SQL tab on
  exactly that statement, and mute, which files the pattern away through the
  findings tab's own state.
  
  Where a template is confident, the card carries a suggested diff. The first
  template is N+1 on pg: the trailing equality folded into `ANY($n)` — one
  query instead of a hundred and fifty — with the arithmetic in the footer and
  "replay & verify" wired into the replay that fills the Compare screen. The
  diff is over the statement the panel captured, never over code it did not
  see: an ORDER BY tail, a LIMIT, an unknown placeholder, and there is no
  diff, because a wrong fix is worse than none.
  
  The time line became the TIME SPLIT bar: one 16px stack in the waterfall's
  own colours, each layer's share visible before any number is read.
  
  And the detail grew its context rail — the request seen from outside
  itself: the route's distribution as a strip with this call as the marker
  (the baseline now reports p50/p99/max alongside avg and p95), who issued it
  when a test did, and NEARBY IN TIME — the requests that ran around it, each
  one click away. On a narrow window the rail folds into a `context` toggle.
- cf04d37: Findings: occurrences become a work list
  
  Every detector firing was recorded somewhere — a flag on a list row, a count
  in the status bar — and none of it added up to "here is what to fix". The
  new Findings tab does: occurrences group by detector and code location, so
  two routes both firing N+1 at the same line are one row, and eight hundred
  occurrences are the handful of problems they always were. Sorted by
  recoverable time, never by recency — recency is the request list's question.
  
  Each pattern is one plain sentence, the code location as a link into the
  editor, the routes it fired on, how often and how recently, and the time
  that comes back if it is fixed — drawn as a bar against the loudest pattern
  in view. A row expands into the hint, the three worst requests (each opens
  the detail), and exports: markdown, JSON, or a GitHub-issue body, copied to
  the clipboard rather than posted anywhere.
  
  Patterns carry a state. `ack` and `muted` are the reader's own bookkeeping,
  kept in the store — the SQLite history remembers them across restarts.
  Muting is presentation, not detection: the detector keeps running and the
  record keeps its findings, but a muted pattern stops flagging rows in the
  list and the live feed. `fixed?` is computed, never stored — the pattern has
  been silent since the file it points at last changed — and wears its
  question mark honestly.
  
  The tab shows a dot while unacknowledged patterns exist, and the status
  bar's findings count now leads here, scoped to the window the list is
  looking at. An empty tab names every detector and the thresholds it runs
  with, because silence from a disabled detector is not a clean bill of
  health.
  
  Under it: `/api/findings` and a `findings()` reader beside `history()` —
  stores hand over one row per occurrence, from the flagged minority only, and
  the grouping happens once in the core. `/api/meta` now reports the resolved
  detector settings.
- cf04d37: History: any metric, any period, and the requests behind the point
  
  Everything the panel drew was scoped to something. The strip above the list
  spans the whole store but counts only requests; the route charts cover the
  whole store for one endpoint at a time. There was no way to ask what latency
  did this week, and nowhere that stated a period's numbers as numbers.
  
  The new History screen does both. Ten metrics, all of them things Reqray
  already measured — percentiles, throughput, error rate, queries and outgoing
  calls per request, response size, event-loop delay, findings per request — over
  the last hour, today, seven days, or everything the store holds, narrowed
  further by dragging across the chart. Two at once where they share a story:
  latency against how far behind the event loop was is a question worth putting
  on one chart, and each line gets its own scale and its own side.
  
  The chart is zoomed three ways: a drag across a stretch, the wheel, or a
  trackpad pinch — anchored on the cursor, so the spike being looked at stays
  put while the window tightens around it. Two fingers sideways pan a zoomed
  window; winding back out past the whole period clears the zoom. While a new
  reading is in flight the chart already on screen stays up and dims instead of
  blanking, and a new question sweeps its answer in from the left.
  
  A rail beside the plot names the requests behind the chart: idle, the ten
  slowest of the whole period in view under the chart's current filter;
  hovering a column narrows it to that column, leaving widens it back, and
  every row opens the request directly. Beside the plot rather than over it,
  so the chart is never covered. Clicking a column pins it — the stretch is
  marked on the chart, the rail locks to it, and the pointer is free to cross
  the plot without every column on the way stealing the list — and "open all
  in the list" carries whatever the rail is scoped to into the request list.
  The route charts carry the same list as a card under the hovered column,
  scoped to the route.
  
  The charts are live, and follow the panel's own toggle. While live, the
  history window slides forward every few seconds — a relative period whole,
  "everything" at its right edge, and a pinned zoom re-read in place rather than
  moved under the reader's eyes; the routes screen re-reads on the same cadence,
  with an open route's charts riding the refresh instead of resetting. Paused
  means nothing moves.
  
  Above it, the period as figures: calls, error rate, p50/p95/p99, time in SQL
  against time in application code, the busiest endpoint and the detector that
  fired most — each against the same period immediately before, because a number
  with nothing to compare it to is a number nobody acts on.
  
  **What keeps it from being a dashboard.** Every column is the set of requests
  that made it: click one and the list opens on exactly those, filtered as the
  chart was. A fixed list of metrics rather than a query language, two lines at
  most, nothing saved, nothing that alerts. The filter the list is showing is
  inherited — "what did *this endpoint* do this week" is the question the screen
  is for — and named in a pill that clears it, because an inherited filter
  nobody can see turns an empty chart into a mystery.
  
  Under it: `/api/series`, and a `history()` method beside `durations()` and
  `counts()`. Stores hand over a few numbers per request and say when they
  stopped reading; the bucketing and the percentiles happen once, in the core, so
  the same data cannot produce different figures depending on which store is
  behind it. A stretch nothing ran in is drawn as a void rather than as a zero,
  and a period the store could not read to the end says so instead of presenting
  its recent part as the whole.
  
  The SQLite store gains three columns — time in SQL, time in application code,
  and bytes sent — through the same migration path the event-loop reading used.
  Existing databases keep working and answer `null` for the requests recorded
  before them, which is what "not measured" is.
- cf04d37: History: the period before, what changed in this one, and two columns compared
  
  The figures above the chart already claimed "+21% from the last hour". Now
  the chart says it too: the period immediately before is drawn behind the
  line as a ghost, cut into the same columns and sharing the line's own scale,
  so worse-than-last-week is a shape rather than a percentage. It is the
  primary metric only — a ghost behind each of two lines is four lines on one
  chart — and the new `against` control turns it off. The companion-metric
  control is now called `with`, which is what it always meant.
  
  The chart carries annotations at the moments the panel actually witnessed: a
  detector pattern seen here for the first time, and this process starting. No
  inferred deploys and no guessed incidents — an annotation is a claim that
  something happened, and a wrong one sends somebody looking for a change
  nobody made. They are thinned to a handful, because eight rules inside one
  second are a hatch pattern rather than an annotation.
  
  Beside the plot, the rail now answers what changed in the window: the
  patterns first seen inside it, the routes that strayed from their usual, and
  a way into the findings tab scoped to exactly this stretch.
  
  And two columns can be held side by side: pin one, shift-click another, and
  both bands sit on the chart while the rail states each one's calls and the
  drawn metric's value. A plain click is a fresh question and drops the
  comparison with it.
- cf04d37: The process underneath: event-loop delay, per request and per route.
  
  A route that got slower with no change to its span timings is not a slow
  route. It is a process that could not get scheduled — and that is invisible
  in a waterfall, where every span is individually fast and the time is
  *between* them.
  
  ```
  341 ms · 2.0 ms sql · 339 ms your code · loop behind 335 ms
  ```
  
  That is the demo's registration endpoint: two queries of a millisecond each,
  and a password hash that holds the event loop for a third of a second. No
  span can show it, and until now neither could Reqray.
  
  **Measured as the process, never as the request.** Under concurrency the code
  that blocked the loop is usually somebody else's, so the panel says "the loop
  was behind by this much while this ran" and never "this request burned this
  much CPU". libuv reports the whole sampling interval, so an idle loop reads
  as eleven milliseconds at a resolution of ten; the baseline comes off, and
  what is left is the lateness. Under one sampling interval nothing is said at
  all — that is the granularity of the measurement, not an event.
  
  **Under host pressure, on a route.** `GET /api/requests/:id/baseline` also
  answers whether this route is slower when the host is struggling: its own
  calls, split by whether the loop was in its *own* top quartile at the time.
  
  > When event-loop delay was over 37 ms, this route's p95 was 1.8× slower —
  > 24% of 100 calls landed there.
  
  Elevated is never a fixed threshold: a delay that is alarming for one service
  is idle for the next, and the only baseline worth comparing a process against
  is the same process. The cutoff is printed so the claim can be checked, both
  halves are shown so the size of the effect is visible rather than taken on
  faith, and the card says outright that the two moved together — which is
  evidence, not proof. A neighbour on the same box explains the shape as well.
  
  It renders only when it holds up: the loop actually varied, at least twenty
  calls on each side, and the elevated half at least half again slower. It is
  absent far more often than present, and that is the design.
  
  **What it costs.** The histogram's `mean` walks its buckets and costs eleven
  microseconds a call — trivial once, and eleven milliseconds of every second
  at a thousand requests. It is read at most once every fifty milliseconds,
  which is nothing against a window a second long, so the cost stops scaling
  with traffic: p99 with the monitor on and off is the same figure across
  repeated benchmark runs. `hostMetrics: false` turns it off.
  
  Requests recorded before this carry `host: null`, and the SQLite store adds
  its column to a database that already exists rather than failing every insert
  against the old shape. "Not measured" and "the loop was fine" stay different
  facts everywhere, including through the store.
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
- cf04d37: One wire contract.
  
  `@reqray/protocol` now holds every panel response type, not the half that
  happened to be extracted first: exceptions, routes and their charts, the
  timeline and the activity behind one of its columns, EXPLAIN, replay and
  blame, and the project report down to diagnostics, pools and retention.
  Core imports them back and re-exports them, so nothing downstream changes.
  
  The dashboard imports that contract instead of transcribing it — `api.ts`
  falls from 1 041 lines to 529 — which fixes two bugs the hand-copy had
  already produced. A truncated response body reported the capture limit as
  its own size, because the copy lacked the `bytes` field recorded for
  exactly that reason. And `isRunEvidence` narrowed to a merged evidence
  type that still admitted the `duplicate` kind it had just excluded; a new
  detector kind is now a compile error rather than a hole in the waterfall.
  
  `@reqray/cli` moves `@reqray/protocol` into its dependencies: its published
  types import it, so `import { ReqrayClient } from '@reqray/cli'` failed to
  compile. The transports name the contract in their own manifests rather
  than reaching it through core.
  
  `@reqray/core` describes itself accurately — "no third-party runtime
  dependencies", since its one dependency is types that emit nothing — and a
  test now reads the built bundle to keep that true.
- cf04d37: The panel stops trusting the browser.
  
  The panel gate says who may use the panel. It said nothing about which
  *page* was asking, so any site open in a developer's browser could send a
  form-shaped POST to `/_reqray/api/replay` and make the application run a
  recorded request again — a second charge, a second email — or run EXPLAIN,
  or spawn `git`. The reply was unreadable to that page, which is no comfort:
  the effect had already happened.
  
  Every state-changing route now requires `Sec-Fetch-Site: same-origin`, the
  browser's own account of where a request came from, which script cannot
  set. `same-site` is refused with `cross-site`: two ports of localhost are
  one site, and a dev server on another port is the case this is about. A
  caller that sends neither that header nor an `Origin` is not a browser —
  curl, `@reqray/cli`, a script — and passes unchanged.
  
  Three narrower fixes ride along. Replay and the curl export take the
  application's address from the socket instead of the `Host` header, so a
  forged header can no longer aim a replayed request, chosen headers and all,
  at an arbitrary host. `git blame` answers nothing for a file outside the
  project root or a line that is not an integer. EXPLAIN refuses a record
  that holds a second statement after a semicolon, skipping quotes and
  comments so an ordinary `'a;b'` still plans.
  
  Exports now carry at most a thousand requests and say in the file when they
  cut one short, and a panel holds at most thirty-two live feeds open.
- cf04d37: A Project tab: what is instrumented, and what the settings actually are.
  
  The startup report has always been printed once, at boot, into a terminal —
  which is the wrong place for it. "Why do I not see my SQL" is a question asked
  hours later, by which point the line has scrolled away, and in a container it
  was never on screen at all. `GET /api/project` serves the same report, and the
  panel has a screen for it, with the ✘ lines carrying the same hints the
  terminal gave.
  
  Beside it, the settings in force rather than the ones you think you passed:
  the sampling share, the store and how full it is, the per-request limits, which
  of replay / EXPLAIN / blame / SQL values are on, the detectors with their
  thresholds, and the exact list of header and body fields masked before anything
  is written — the list to check when a custom entry was added and something
  still looks unmasked.
  
  And the application itself: name and version from its manifest, the directory
  Reqray treats as project code, and the branch, commit and dirty state it is
  running — the first question anyone asks of a staging panel.
  
  Nothing secret goes on the screen. Environment variables are not read, and the
  panel's gate is reported as present or absent, never by value; both have tests
  that say so.
- cf04d37: What a request cost to run, on every row.
  
  The waterfall answers how long a request took. It never answered what running
  it cost, and the two come apart constantly: a request waiting 800 ms on a
  database is cheap, one spending 200 ms hashing a password is expensive, and a
  list ordered by duration puts them the wrong way round. The demo has both —
  `/api/report` waits 854 ms for 6% of a processor, `/api/register` burns 234 ms
  for 100% of one — and until now the panel drew them as the same kind of slow.
  
  Every request now carries a `cost`: processor time in its window, that time as
  a share of the wall clock, the garbage collector's time inside it, and how
  many other requests shared the window. The list has a CPU column beside the
  duration, on the same yardstick, because the two are only useful read
  together — a long bar next to a short one is a request that waited, two long
  bars are a request that worked. It sorts, and the detail header says the same
  thing in words.
  
  Measured at the edges of the request with `process.cpuUsage()`, which costs
  0.28 µs a call, so it is always on rather than sampled and nothing here is a
  setting.
  
  **What it does not claim.** Retained memory: there is no way in V8 to ask what
  a request still holds, and a number invented for that column would be wrong in
  exactly the cases somebody would act on it. What is measured instead is the
  collector's time in the window, which is what allocation pressure actually
  costs the request that causes it.
  
  `cpuShare` is deliberately uncapped. `process.cpuUsage()` counts every thread
  the process has, so a request the libuv pool worked for genuinely spends more
  processor time than wall time; the panel reports 138% and says more than one
  thread worked for it, rather than rounding the most interesting reading on the
  screen down to 100%. Where other requests shared the window, the figure
  belongs to the window and the panel says so instead of dividing by a guess.
  
  Records written before this have `cost: null` and read as unmeasured — never
  as free.
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
- cf04d37: What the request moved: bytes, rows, and the response that was too large.
  
  "Where is the memory going" is the question a Node backend cannot answer
  honestly. `process.memoryUsage()` around a request, under concurrency and a
  garbage collector that runs when it likes, is noise and occasionally
  negative. What a request *moved* is knowable — and it is what the spike was
  made of.
  
  ```
  88 ms · 49 ms sql · 39 ms your code · 3.8 MB out · 48,400 rows
  
  HEAVY  3.8 MB response from 48,400 rows                      3.8 MB · application/json
         SELECT p.id, p.title, p.price, d::date AS day FROM products p CROSS JOIN …
         src/shop.js:213
         fix   Paginate it, or return only the fields the caller uses.
  ```
  
  **`weight` on every record** — bytes in, bytes out, rows across every query
  that reported a count, and the largest single result. Bodies now keep their
  original size, in bytes and taken before the truncation cap: `text.length`
  after a cut is the size of the limit, and a panel reporting its own settings
  back as a measurement is worse than one reporting nothing. Nothing is
  guessed — a request neither the header nor the recorded body can size reads
  as unknown, never as zero, and the Routes screen shows `—` rather than
  sorting it against routes that measured theirs.
  
  **A detector for the response that grew with the table behind it.** Above a
  megabyte of structured text, with the query and the line of code that
  produced the rows. It never fires on a file: a twelve-megabyte PDF is a
  document and a twelve-megabyte JSON body is a forgotten `LIMIT`, and the
  content type is the only thing that tells them apart. And it names a query
  only when it can identify one — the one that returned the most rows, or the
  only one there was. Faced with three uncounted queries it points nowhere,
  rather than picking the slowest and calling it the source.
  
  **Its cost is bytes.** `costMs` is zero, and the panel and the terminal print
  the size and the rows where they print "41 ms recoverable" for an N+1. The
  seconds a large response spends reaching a phone are not something this
  process measured, and a plausible figure in the one field the screen treats
  as measured is the thing this project does not do.
  
  Which meant findings had to sort by severity before cost: a twelve-megabyte
  response would otherwise rank below a duplicate cache read that wasted a
  third of a millisecond.
  
  The demo gained `/api/export` — the price history of every product for every
  day, written for a report and left in the API. One fast query, four megabytes
  back: the mistake a waterfall has nothing to show for.
- cf04d37: Three charts for one endpoint, and a click that asks what ran.
  
  Enough to see "it got slower at 14:20, after the deploy" and to stop there.
  Opening a route on the Routes screen draws its latency, the share that
  failed, and how often it was called — bucketed by the store, with the strip's
  own bucketing function, so a chart and the strip above it cannot disagree
  about when something happened. Over the same stretch the table was computed
  over, too: a table describing thirteen minutes above a chart describing six
  hours is two answers to one question.
  
  **Latency is a p95 line over a p50–p99 band**, and the number of columns
  follows the traffic rather than the width of the box. Three lines was the
  obvious drawing and the wrong one: a column holding five calls has a p95 and
  a p99 that are the same number — the slowest of the five — so the three sat a
  pixel apart and read as one thick wobble. A single empty column between two
  busy ones is sampling rather than silence, and breaking the line there turned
  an ordinary series into a row of dashes.
  
  **Every column is clickable, because a chart nobody can click is
  decoration.** Clicking one asks what ran in that moment, and the answer is
  ranked by how far each route strayed from *its own* behaviour — never by
  volume, because ranked by volume the busiest endpoint tops every moment and
  explains nothing.
  
  The first run of this screen listed fifteen endpoints, all at ×6.5. They were
  all at ×6.5 because the demo had restarted and every route rose together, and
  a route judged against the total it is part of will always look unusual
  inside a burst. So each route is judged against how *the rest of the traffic*
  moved: one means it rose exactly as much as everything around it, which is
  not an answer to "what was different here". When nothing is disproportionate
  the panel says the traffic rose across the board and names no culprit.
  
  Two more floors, because a ratio alone is not enough at low rates: three
  calls where two were expected is 1.5× and nothing has happened, so an excess
  of at least three calls is required as well — and at least five milliseconds
  before "slower" means anything, since a route that doubled from 0.2 ms has
  doubled and nobody has noticed. When nothing stands out the drawer says so:
  garbage collection, a neighbour on the box, or the host. A list of ordinary
  routes presented as an explanation is worse than admitting there is none.
  
  **Two endpoints and two store methods.** `GET /api/routes/series` and `GET
  /api/timeline/at`, answered by `durations` (now carrying whether the call
  failed, and bounded by a time range) and by a new `counts`, which groups by
  route with an aggregate rather than by loading a busy minute of requests to
  count them. A store that cannot group says so, and the panel prints that
  instead of asking for ever.
  
  **One thing moved.** Clicking a row on the Routes screen now opens the route
  rather than jumping to a filtered list — looking at a route is the commoner
  gesture — and the filter is a *show these requests* button inside the opened
  panel.
  
  **A selected column is marked, not filled.** A band from floor to ceiling is
  the same shape the throughput chart draws its data with, and at full height
  it read as the tallest sample on the chart — a spike that was not there. It
  is a faint neutral wash with a tick along the top edge now, the way a
  selected tab is marked, which is what it is.
  
  **A stretch with no traffic is drawn, not left blank.** An empty middle with
  a mark at each end reads as a broken chart; it is a route nothing called, and
  now it says so — hatched, and named on hover. Clicking into one gets the
  answer it deserves: either the routes that did run, or that nothing ran there
  at all.
  
  Not a dashboard builder, not alerting, not aggregates over arbitrary
  dimensions, and not a time-range picker on this screen. That is the line
  where this becomes a worse Datadog.
- cf04d37: Routes: what fired on each endpoint, and the shape of its traffic
  
  The routes table ranked endpoints by cost and said nothing about why any of
  them cost that. It does now: a FINDINGS column carries the detectors that
  fired on each route — the reason to open this screen — and sorts by what
  those findings cost rather than by how many kinds there are, because one N+1
  worth a second outranks three cheap duplicates. Muted patterns are left out:
  muting is presentation, and a badge is a shout.
  
  A TREND sparkline cuts every route into the same ten columns of the same
  window, so two rows are comparable by eye: steady, bursty, or called twice
  and never since. It reddens when something failed in the window, and sorting
  by it puts the routes that are busy now above the ones that went quiet.
  
  TIME SHARE went neutral except for the single worst route. A bar that
  reddens with its own figure calls a quiet screen's biggest share a problem.
  
  Opening a route now says what the charts cannot. One sentence when the shape
  deserves one — every call costing the same is a constant in the code rather
  than load; a tail many times the median is where the story is — and silence
  otherwise, because a tool that says something about everything says nothing.
  Under it, the route's top finding with its call site as a link into the
  editor: the charts say when it was slow, this says whether anybody already
  knows why.
- cf04d37: The sampling profiler: which function burned the time.
  
  `slow_code` could find the stretch of a request that nothing accounts for and
  say what brackets it. It could not say what ran inside, because nothing was
  recorded there — that is what makes it a stretch. On the demo it read "279 ms
  of your own code, called from `src/shop.js:231`", and `shop.js:231` is the
  `INSERT` the stretch *ends* at: three lines past the `pbkdf2Sync` that spent
  the time. The finding pointed at the boundary because the boundary was all it
  had.
  
  With sampling on, a slow-code finding is completed from the stack samples
  taken inside its own window. It now reads "220 ms in registerUser", points at
  `src/shop.js:213`, and says which call inside it held the samples:
  
      WHAT WAS RUNNING          88% of samples on a processor
      100%  registerUser  src/shop.js:213  calling pbkdf2Sync
  
  It also settles the question `slow_code` had to hedge. A stretch whose samples
  are mostly idle was not code at all, and the finding says so and names nobody
  rather than blaming whatever the sampler caught in passing.
  
  **What a sample cannot tell you,** stated because both limits are V8's and
  both are load-bearing. A profile node carries the line a function is *defined*
  on, never the line running — Node omits the per-line tick counts the protocol
  allows for — so the address is a function, and naming the call inside it is
  what recovers the rest. And an optimised function inlined into its caller is
  not on the stack at all: a small helper called in a loop can be reported as
  the function that calls it. Hence a share of samples rather than a measurement
  of a function, and a hint that says where to look rather than what to delete.
  
  The flamegraph still draws span time rather than sample time, and allocation
  sampling is not in yet — its samples carry a sequence number rather than a
  timestamp, so attributing them to one request needs the profile rotated in
  slices instead of read by window.
  
  Off outside local development, gated like replay and EXPLAIN. Sampling itself
  is cheap — 7 µs on a request's p99 at a millisecond interval, against a budget
  of 500 — but a profile names the application's own functions and files, which
  is a decision somebody makes rather than a default they discover. The
  published overhead numbers are unaffected: nothing here runs in production
  unless asked.
- cf04d37: The search speaks tokens, views keep the question, and ⌘K runs it all
  
  The filter box now reads tokens: `status:5xx` or `status:404`, `method:post`,
  `path:/api/orders`, `has:n+1` (and seq, dup, slow, wait, tx, heavy, findings,
  error), `test:` bare or with a name, `>100ms` in either unit, `sql>10`. A
  word that is not a token stays free text — `localhost:3000` still matches
  paths — and tokens compose with the chips, both narrowing the same filter.
  The server learned the same words: path, exact status, SQL count, the flag,
  and the issuing test are now filter fields in both stores, answered
  identically and held together by the parity suite, so a token means the same
  thing over a ring of five hundred and a history of half a million. The
  history chart and its rail unfold tokens too, instead of matching them as
  substrings of nobody's path.
  
  A filter worth coming back to can be saved under a name: the whole question
  — tokens, chips, route — minus the time range, which a view deliberately
  never keeps. Saved views live in the `views` pill, apply in one click, and
  update when saved under the same name again.
  
  ⌘K (or Ctrl+K) opens the palette from anywhere, typing included: the tabs,
  the saved views, the token vocabulary (picked entries drop into the search
  field), and the routes of the requests in hand. Substring match, arrows and
  Enter, Esc closes. A launcher, not a second query language — the query
  language is the search field it leads into.
- cf04d37: Self time, and how this call compares.
  
  The panel answered "the database took 26 ms". It did not answer "and where
  did the other 400 ms go", which for a Node backend is the more common
  question — and it did not answer "is 400 ms even unusual here", which is the
  question a reader asks before the first one.
  
  **Where the time went, in one line.** Every record now carries `timing`: SQL,
  outgoing HTTP, cache, and the time covered by no instrumented work at all.
  The detail header reads `30 ms · 26 ms sql · 3.8 ms your code`, and
  `reqray show` prints the same three figures in a `TIME` block.
  
  These are unions, never sums. Four 100 ms queries fired together cost a
  120 ms request 100 ms of it, not 400 — a sum there is not merely imprecise,
  it is larger than the request that contains it. When the layers overlap the
  panel says so, because the parts can then add up past the whole.
  
  **And what did the work.** Every span carries `selfMs`: its duration minus
  the stretch its children occupied. Under the waterfall is a table ranked by
  it, because ranking by duration is what everyone tries first and always
  returns the same useless answer — the handler at the top, since it contains
  everything and did none of it. Identical spans collapse into one row the way
  the waterfall draws them as one bar: `150× SELECT line_items · 86% · 26 ms`.
  
  **Is this call unusual?** `GET /api/requests/:id/baseline` compares a request
  against the route's own history and says: faster than average, typical, or
  slower than 95% of calls. Both stores answer it with a query for that route
  rather than by reading a page and sorting it. Under twenty comparable calls
  there is no ninety-fifth percentile worth the name, so none is reported and
  nothing is ever called slow; under two there is no card at all. A tool that
  calls an ordinary request slow teaches you to stop reading the card.
  
  **Also fixed:** the budget detector contradicted the header directly above
  it. It summed span durations and named the first layer above zero, so a
  request that spent 857 of its 867 ms in application code was advised that
  "1% of the time went to SQL — start there". It reads the same timing now and
  names the layer that actually holds the time.
  
  Records written before this exist in stores on disk; the panel fills their
  timing in on read rather than showing a blank header for yesterday's request.
- cf04d37: `slow_code`: the stretch of a request that nothing accounts for, with an
  address.
  
  Every other detector reasons from something Reqray watched happen. This one
  reasons from an absence — the stretch where no query, no call and no cache
  read was in flight — which for a Node backend is the most common answer once
  the database has been ruled out, and the one a waterfall shows worst, because
  the evidence for it is empty space. `slow_budget` could already say "82% of
  this request is not covered by any instrumentation" and stop there, naming the
  fact and never the place.
  
  The finding is addressed by what brackets it — 400 ms between the query at
  `orders.ts:18` and the one at `total.ts:47` — and named by the innermost
  handler or middleware it sits inside, never the request-wide one, which would
  amount to reporting that the time was spent inside the request.
  
  An empty stretch has a second explanation, and it is not the application's
  fault: I/O Reqray has no instrumentation for. What separates the two is not how
  much of the request was covered but where the silence sits. A process Reqray
  cannot see is not slow in one place — it is full of holes, one for every call
  it has no instrumentation for. A process Reqray can see, with one slow function
  in it, has exactly one. So the finding is made only when the stretch accounts
  for most of the request's silence, and never for a request nothing was
  recorded in at all. A tool that blames your code for its own blind spot is a
  tool nobody keeps installed.
  
  It does not claim CPU. The host monitor measures the event loop and says in as
  many words that it can never attribute it to one request; a detector that
  quietly did so anyway would contradict the screen above it. What is reported
  is a stretch of the request's own wall clock.
  
  How far the heading goes is decided structurally: with instrumented work on
  both sides, the silence is demonstrably *between* two things Reqray watched, so
  it reads "852 ms of your own code". At either edge of a request it does not —
  a leading stretch shares its ground with parsing, a trailing one with
  serializing the response — so those read "nothing accounts for" and the hint
  keeps the alternative open. The heading never claims more than the hint below
  it is prepared to defend.
  
  Also: the largest single stretch rather than the sum of them, so scattered
  async overhead cannot add up to a defect that points nowhere; queueing for a
  connection is accounted time, not silence, which leaves it to `pool_wait`; and
  `isContainer` moved out of `timing.ts` as an export rather than being written
  a second time.
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
- cf04d37: Process state gets owners, and three real bugs go with it.
  
  `state.ts` used to declare one record of sixteen unrelated fields — the
  request context, two SQL caches, a log sink, a boolean, two counters, a
  callback map — whose only shared property was "must not be duplicated", and
  every module that needed one field imported the whole thing. It now hands
  out named, typed slots, and eleven modules declare the state they own.
  
  **A memory leak.** The map of learned callsite origins had no ceiling, while
  every cache beside it had one from the start with a comment about
  applications that build SQL dynamically. Such an application leaked a record
  per distinct statement, for the life of the process.
  
  **Two split brains.** The outgoing-HTTP fingerprint cache lived in a module
  variable, so a dual ESM/CJS load gave two caches with one ceiling and half
  the hits each. `explain-targets` kept its pool→id map module-locally while
  the id counter was global, so one pool could take two ids and EXPLAIN could
  resolve an id to the wrong pool.
  
  **A cap that did not apply.** `shouldCaptureStack()` called with no
  fingerprint looked its count up under the empty string — a key nothing ever
  writes — and so answered "capture" every time.
  
  All four caches now turn over two generations instead of clearing at the
  ceiling: an application sitting just past the limit used to discard its
  hottest statement with its coldest and re-scan everything until the cache
  refilled.
  
  `Reqray` gains `close()`: it stops the host monitor and flushes the transport
  before closing it. `Transport` declared `flush` and `close` and nothing could
  reach either. The panel gate is now checked before any of that is started.
  `registerPool` is one `WeakMap` lookup rather than the linear scan its own
  docstring denied, and `addSpan` builds each span once instead of allocating a
  shared object and spreading it.
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
- cf04d37: Reqray in the terminal: `reqray watch` and `reqray show`.
  
  The panel answers "which line of code" better than anything else here, and it
  answers it in a browser. Two questions do not need one: what is happening right
  now, and what happened in that one request. `@reqray/cli` is a client for the
  same API the panel is built on — no instrumentation of its own, nothing to
  configure, and a collector on another machine is an ordinary URL over an ssh
  tunnel.
  
  ```console
  $ npx @reqray/cli watch --slower-than 100
  reqray 0.6.0   watching localhost:3000   pid 41822   ctrl-c to stop
  
     TIME         METHOD ST  PATH                               DUR    Q FLAGS
     09:41:03.077 POST   201 /api/orders                      118ms   9q
  !  09:42:10.184 GET    200 /api/orders                      512ms  51q N+1
  !! 09:43:02.184 POST   500 /api/orders                      2.14s  12q ERR
     └ TypeError: Cannot read properties of undefined (reading 'currency')
       services/pricing.js:61                            reqray show 9012
  ```
  
  **One line per request, on a grid that does not move.** Only the path column is
  flexible; time, method, duration and flags keep their place, so output at 80
  columns and at 200 reads the same way. Severity is a glyph in the first two
  columns and colour is a second layer over it — `NO_COLOR`, a pipe, a CI log and
  `--ascii` lose bytes and not a single distinction. A path is truncated by whole
  segments, so what is left is still a path. `--slower-than`, `--status`,
  `--method`, `--path` (a glob) and `--findings-only` narrow the stream; a
  dropped connection reconnects with a doubling delay and says so in one muted
  line rather than going quiet.
  
  **A row on screen can be opened.** The stream prints no identifiers by
  default — eight characters of noise on every line, in the column the eye
  scans — so `show` takes the question instead: `--last`, `--last --failed`,
  `--last --slowest`, and `--last --path /orders`, each answered by the store
  rather than by sifting a page of results in the client. `watch --ids` adds the
  column when copying one is what you want.
  
  **`reqray show <id>` is the detail view without the browser.** The waterfall
  drawn in box characters — an N+1 collapsed to a single `47× SELECT line_items`,
  handlers as brackets, spans shorter than a cell as slivers rather than missing
  — then the findings, each with what it costs, the line of code and the fix, and
  then the response. `--last`, `--last --failed` and `--last --slowest` ask the
  collector the question instead of making you find an id first. `--sql` prints
  every query wrapped rather than cut, with keywords and placeholders coloured as
  in the panel; `--json` hands back the raw trace; `--body` prints the body whole.
  
  **Two additions to the panel API rather than workarounds in the client.**
  `sort=slowest` on `GET /api/requests`, implemented by both stores with the
  cursor keyed by the sort column — "the slowest request" over a history on disk
  cannot be found by reading a page of it and comparing. And `errors=1`, which is
  wider than the 5xx class on purpose: a handler that threw and still answered
  200 is the failure worth finding.
  
  **`@reqray/protocol` is the wire contract, declared once.** Types only, no
  runtime code, no dependencies — safe in a browser bundle, an editor plugin or a
  CLI. `@reqray/core` imports it type-only and re-exports it, so the server and
  every client describe the same JSON instead of each carrying an approximation
  of it. Core still loads nothing new at run time.
  
  Exit codes are 0, 1 for a failure or a collector that cannot be reached, and 2
  for arguments. Failures are addressed to a person — what happened and what to
  check — with the technical cause behind `--verbose` and never a stack trace.
  Ctrl+C exits immediately and quietly.
- cf04d37: Filter by time — and a strip that spans the whole history.
  
  With requests kept on disk, "what happened yesterday between two and three"
  became a reasonable question and there was nothing to ask it with. `from` and
  `to` are part of the filter now, applied by the store like everything else, so
  narrowing to an hour searches the history rather than the page in hand.
  
  **One selected stretch, however it was picked.** Dragging across the strip
  above the list, clicking days in a calendar and typing exact minutes all set
  the same thing, and all of it goes to the server. The new `time · …` pill
  holds the named answers — last 15 minutes, last hour, last 24 hours, today,
  yesterday — a month calendar where one click is a day and two are a stretch,
  and a pair of fields for the minutes a calendar cannot express. Either end may
  be left empty: "everything since Monday" is a question people ask. Days the
  store has nothing for are dimmed, so how far back the history goes is visible
  rather than guessed at.
  
  **The strip is drawn by the store, not by the rows on screen.** It used to be
  bucketed from whatever was loaded, which with a history means the last page —
  a few minutes — and a strip covering a few minutes cannot be dragged back to
  yesterday. Stores now offer three numbers per request (when, how long, whether
  it failed) through `timeSeries()`, and `GET /api/timeline` buckets them for the
  whole range. The bucketing lives in the core, so the strip and the list can
  never disagree about which column a request falls in.
  
  Fixed on the way: a filter that matched nothing replaced the entire screen with
  the "no requests recorded yet" welcome — including the filter bar that caused
  it, leaving no way back. An empty result now says "nothing matches — 87
  recorded" inside the list, with the filters where they were and a button to
  clear them. The welcome screen is for an empty store, which is the only thing
  it was ever true about.
- 21cfe4f: The v0.6 surfaces: a timeline scrubber over the request list, pinning that
  survives the ring buffer, highlight rules, per-route aggregates, a reworked
  comparison with a verdict, a flamegraph beside the waterfall, three new
  detectors (duplicate outbound reads, duplicate cache reads, requests over
  budget) in a findings block, exports (HAR, curl, trace JSON, deep link), git
  blame in exception stacks with open-in-editor, test provenance, and a keyboard
  layer with `#l/…` deep links — the links written before it still open.
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

- cf04d37: One waterfall, and the terminal starts answering the question.
  
  The waterfall was built twice — once for the browser, once for the terminal —
  and the two disagreed about what a waterfall is. The panel collapsed both
  kinds of run a detector reports; the terminal collapsed only N+1, so one
  request showed four bars in one client and a single bar in the other. The
  panel drew the stretches no instrumentation covers; the terminal drew none,
  so `reqray show` on a 2.14-second request with a 12-millisecond query printed
  the query and said nothing about the remaining 2.13 seconds. The panel showed
  a query's wait for a connection; the terminal dropped it, so a query that took
  340 ms because it queued for 338 of them looked exactly like one that worked
  for 340.
  
  **New:** `@reqray/waterfall` holds the model — which spans collapse into one
  bar, where the uninstrumented stretches are, how deep each bar sits, which
  parents ran their children in parallel. Types only from `@reqray/protocol`, so
  it is safe in a browser bundle and the terminal client still imports no part
  of core.
  
  It decides nothing about drawing. A terminal has twenty-eight columns for a
  label and a browser has an ellipsis; both clients keep their own words, their
  own colours and their own bars, because that is a difference between screens
  rather than between answers.
  
  **Fixed in `@reqray/cli`:** uninstrumented time now appears in the terminal
  waterfall, sequential-HTTP runs collapse the way they do in the panel, and a
  query that queued says so.
  
  **Also in the dashboard:** free text in the search box is matched the way the
  server matches it — within one field rather than across the join of several,
  so `GET /api` no longer selects rows a page would never have returned — and a
  route chip ignores the case of its method. A parity test now runs both filters
  over the same rows through the server's own parser. A failed mute or a refused
  clear reports the failure instead of showing success, and a pattern last seen
  a week ago says "7d ago" rather than "10080m ago".
- cf04d37: A pattern's state is one type, not fourteen copies of it.
  
  `StoredPatternState` has been in the protocol since the findings tab shipped,
  and nothing used it: `'new' | 'ack' | 'muted'` was retyped by hand in seven
  places across the core panel, both stores and the dashboard, and its filed
  subset `'ack' | 'muted'` in seven more. The subset now has a name too —
  `FiledPatternState`, derived from the settable one, since `new` is the absence
  of a stored row rather than a value.
  
  The endpoint that accepts a state had the list three times in one function:
  the check, the refusal message and a comment. It is one array now, and the
  message is built from it, so a state added to the contract cannot be accepted
  while the error still names the old three.
  
  The dashboard names the two facts it reads off a state rather than spelling
  them at each site: what the Findings dot counts, and what "open only" keeps.
  They were written out in three places, and the two that count had to agree or
  the dot would lie.
  
  The same everywhere else a closed set was spelled out rather than named: the
  operating mode (`ReqrayMode`, which the config sets and the panel reports, so
  the two must agree), the spans an adapter opens itself (`LabelSpanKind`), the
  list's sort order (`RequestSort`, which the protocol already had), the request
  list's sort direction, the timeline's scope, the alignment of a tick's label,
  and the accents the stylesheet reads off `data-tone` — a swatch and a duration
  bar both speak that vocabulary, and only one of them had it written down.
  
  The rail's title and its `data-scope` were two spellings of one decision, made
  twice from the same three conditions. One function decides now, and both read
  off it.
  
  No behaviour changed, and nothing on the wire moved: these strings are stored
  in SQLite and sent as JSON, so the values are contract, not internal names.
- cf04d37: The timeline strip opens on the traffic, not on the silence.
  
  A store that keeps a week and an application that ran for an hour drew a
  strip with sixty-two empty columns and everything squeezed into the last one.
  True, and useless: the shape of what is happening now was one mark wide.
  
  The strip is now drawn over the newest run of traffic — the stretch at the
  end, with silences shorter than a tenth of the strip treated as pauses inside
  it rather than as gaps between sessions — and says which stretch that is:
  `last 2h 23m · drag to zoom`. One click switches to `5d 6h kept`, and back.
  It changes only what is *drawn*: the list is not filtered by it, so nothing
  disappears without being asked for.
  
  It only fires where it helps. A store whose traffic already fills its range
  has nothing to crop, and neither has a session shorter than ten minutes — a
  dev sitting has pauses in it for a coffee, a restart, a test run, and none of
  them separate one session from another.
  
  `GET /api/timeline` takes an optional `from` and `to` for this, which is also
  how a panel can ask for any stretch it wants to draw.
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
  - @reqray/protocol@0.1.0
