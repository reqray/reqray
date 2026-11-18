# @reqray/protocol

## 0.1.1

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
