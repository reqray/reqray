# @reqray/cli

## 0.1.0

### Minor Changes

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
  - @reqray/protocol@0.1.0
  - @reqray/waterfall@0.1.0
