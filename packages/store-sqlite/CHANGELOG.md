# @reqray/store-sqlite

## 0.1.1

### Patch Changes

- Updated dependencies [a52e790]
  - @reqray/core@0.1.1
  - @reqray/protocol@0.1.1

## 0.1.0

### Minor Changes

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
  - @reqray/protocol@0.1.0
