/**
 * A recorded request, as it travels over the panel API.
 *
 * This package is the single declaration of the wire contract: `@reqray/core`
 * imports these types and re-exports them, so the server and every client
 * describe the same JSON rather than two hopeful approximations of it.
 *
 * There is no runtime code here, and there never will be — a client that
 * speaks the protocol should not have to install the instrumentation that
 * produces it.
 */

/** Span kind. Drives the bar colour in the waterfall. */
export type SpanKind = 'middleware' | 'handler' | 'db' | 'http' | 'cache';

/**
 * The spans a framework adapter opens itself, as opposed to the ones an
 * instrumentation records around somebody else's call.
 */
export type LabelSpanKind = Extract<SpanKind, 'middleware' | 'handler'>;

/** What a cache call does. */
export type CacheOperation = 'get' | 'set' | 'del' | 'other';

/** Place in user code a span came from. Always inside the project. */
export interface Callsite {
  /** Absolute file path. */
  readonly file: string;
  /** Path relative to the project root — what a client shows. */
  readonly relative: string;
  readonly line: number;
  readonly column: number;
}

/** Error attached to a span or to the request as a whole. */
export interface SpanError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

interface SpanCommon {
  /** Sequence number within the request, starting at 1. */
  readonly id: number;
  /** Span this one ran inside of, or `null` for roots. */
  readonly parentId: number | null;
  /** Offset from the request start, ms. */
  readonly startedAt: number;
  /** Duration, ms. */
  readonly duration: number;
  /**
   * Time spent in this span's own code, ms — its duration minus the stretch
   * its children occupied, counting concurrent children once.
   *
   * The number to rank a waterfall by. Ranking by duration always returns the
   * same useless answer: the handler at the top, because it contains
   * everything and did nothing itself.
   *
   * Computed when the request finishes: a span does not know its children
   * while it is still running.
   */
  readonly selfMs: number;
  readonly callsite: Callsite | null;
  readonly error: SpanError | null;
}

/** Middleware span — the work before and after the handler. */
export interface MiddlewareSpan extends SpanCommon {
  readonly kind: 'middleware';
  readonly label: string;
}

/** Route handler span. Parent of SQL, HTTP and cache spans. */
export interface HandlerSpan extends SpanCommon {
  readonly kind: 'handler';
  readonly label: string;
}

/** Database query span. */
export interface DbSpan extends SpanCommon {
  readonly kind: 'db';
  readonly sql: string;
  /** Normalized SQL fingerprint — repeats are grouped by it. */
  readonly fingerprint: string;
  readonly rowCount: number | null;
  /** Who recorded the span: `pg`, `prisma`, `mysql2`. */
  readonly source: string | null;
  /** Registry id of the pool or client that ran the query. */
  readonly clientId: number | null;
  /**
   * Registry id of the physical connection the query ran on.
   *
   * Different from {@link DbSpan.clientId}, which names whatever EXPLAIN
   * should later be sent to — for a pooled query that is the pool. This is
   * the connection itself, and it is what turns `BEGIN` … `COMMIT` into a
   * transaction: everything on one connection between them was inside it.
   */
  readonly connectionId: number | null;
  /**
   * Time spent waiting for a free connection before the query ran, ms.
   *
   * `null` when nothing measured it — a driver without pool instrumentation,
   * or a wait too short to be worth a number. Recorded separately from
   * `duration` because they are different problems: a query that waited is
   * fixed by the pool, a query that ran long is fixed by the query.
   */
  readonly waitMs: number | null;
  /** Parameter values, only when the application collects them. */
  readonly values: readonly string[] | null;
}

/** Outgoing HTTP call span. */
export interface HttpSpan extends SpanCommon {
  readonly kind: 'http';
  readonly method: string;
  readonly url: string;
  readonly statusCode: number | null;
}

/** Cache operation span. */
export interface CacheSpan extends SpanCommon {
  readonly kind: 'cache';
  readonly operation: CacheOperation;
  /** Command as the driver sent it, uppercase. `null` when unknown. */
  readonly command: string | null;
  /** What identifies the value: the key, plus what selects inside it. */
  readonly key: string;
  readonly hit: boolean | null;
}

/** A unit of work inside a request. */
export type Span = MiddlewareSpan | HandlerSpan | DbSpan | HttpSpan | CacheSpan;

/** Log line bound to a request. */
export interface LogEntry {
  /** Offset from the request start, ms. */
  readonly at: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
}

/**
 * What a request cost the process, as distinct from how long it took.
 *
 * The two come apart constantly: a request waiting 800 ms on a database is
 * cheap, one spending 80 ms hashing a password is expensive, and a list
 * ordered by duration puts them the wrong way round. Measured at the edges of
 * the request, so it is always present rather than sampled.
 */
export interface RequestCost {
  /** Processor time in the request's window, user and system, ms. */
  readonly cpuMs: number;
  /**
   * That time as a share of the wall clock. `1` is a request that spent its
   * whole life on a processor, and above `1` is one that had more than one
   * thread working for it — the libuv pool, or a worker.
   */
  readonly cpuShare: number;
  /** Time the garbage collector took inside the window, ms. */
  readonly gcMs: number;
  /** Collections inside the window. */
  readonly collections: number;
  /**
   * Other requests that shared the window.
   *
   * `cpuMs` measures the process, not the request, so this is the number that
   * says how far to trust it: at zero the window was this request's alone;
   * above it the figure is shared, and a client must say so rather than
   * dividing by a guess.
   */
  readonly overlap: number;
}

/**
 * One place in the code, with how much of a stretch it held.
 *
 * From the sampling profiler, so it is a statistical claim rather than a
 * measurement of that function: `share` is the fraction of samples in the
 * window whose stack passed through here.
 */
export interface HotFrame {
  /** The function's name, or `(anonymous)`. */
  readonly functionName: string;
  /** Path relative to the project root. */
  readonly relative: string;
  readonly line: number;
  /**
   * What the frame was calling, or `null`.
   *
   * V8 reports where a function is defined, never the line running, so the
   * address stops at the function. The callee recovers the rest: the frame
   * says where to look, and this says what to look for once there —
   * `pbkdf2Sync`, `processChunkSync`, `parse`.
   */
  readonly inside: string | null;
  readonly samples: number;
  /** Share of the window's running samples, 0..1. */
  readonly share: number;
}

/** How serious a finding is. */
export type FindingSeverity = 'info' | 'warn' | 'critical';

/** Evidence for the N+1 detector. */
export interface NPlusOneEvidence {
  readonly kind: 'n_plus_one';
  /** How many times the same fingerprint ran. */
  readonly repeats: number;
  readonly fingerprint: string;
  /** One query from the group, shown as a sample. */
  readonly sample: string;
  /** Total time of all repeats, ms. */
  readonly totalMs: number;
  readonly spanIds: readonly number[];
}

/** Evidence for the sequential-HTTP detector. */
export interface SequentialHttpEvidence {
  readonly kind: 'sequential_http';
  readonly repeats: number;
  /** Normalized call shape: `GET api.example.com/users/:id`. */
  readonly fingerprint: string;
  readonly sample: string;
  readonly totalMs: number;
  readonly spanIds: readonly number[];
}

/** Evidence for the duplicate-work detectors, HTTP and cache alike. */
export interface DuplicateEvidence {
  readonly kind: 'duplicate';
  readonly repeats: number;
  /** What made them identical: the URL, or the cache key. */
  readonly fingerprint: string;
  readonly sample: string;
  readonly totalMs: number;
  readonly spanIds: readonly number[];
}

/** Evidence for the heavy-response detector: what came back, and from where. */
export interface HeavyResponseEvidence {
  readonly kind: 'heavy_response';
  /** Bytes sent to the client. */
  readonly bytes: number;
  /** Rows the queries returned, when they said. */
  readonly rows: number;
  /** The query that produced most of them, or `null` when none reported. */
  readonly sample: string | null;
  /** Content type as it was sent, for the reader to judge by. */
  readonly contentType: string | null;
  readonly spanIds: readonly number[];
}

/** Evidence for the pool-wait detector: time queueing rather than querying. */
export interface PoolWaitEvidence {
  readonly kind: 'pool_wait';
  /** Time the queries spent waiting for a free connection, ms. */
  readonly waitMs: number;
  /** Time those same queries spent actually running, ms. */
  readonly runMs: number;
  /** How many queries waited. */
  readonly queries: number;
  /** The query that waited longest, as the sample. */
  readonly sample: string;
  readonly spanIds: readonly number[];
}

/** Evidence for the transaction detectors: what a connection was held for. */
export interface TransactionEvidence {
  readonly kind: 'transaction';
  /** Wall time from `BEGIN` to `COMMIT` or `ROLLBACK`, ms. */
  readonly heldMs: number;
  /** Of that, time inside queries — the rest is the connection idle in hand. */
  readonly sqlMs: number;
  /** Time inside outgoing HTTP calls made while it was open, ms. */
  readonly externalMs: number;
  /** Queries between the two ends, the ends themselves not counted. */
  readonly queries: number;
  /** What held it, when something did: `POST api.stripe.com/v1/charges`. */
  readonly sample: string | null;
  /** `COMMIT`, `ROLLBACK`, or `null` when the request ended with it open. */
  readonly closedBy: string | null;
  readonly spanIds: readonly number[];
}

/** Evidence for the budget detector: where a slow request spent its time. */
export interface BudgetEvidence {
  readonly kind: 'budget';
  readonly durationMs: number;
  readonly budgetMs: number;
  /** Time inside outgoing HTTP calls, ms. */
  readonly externalMs: number;
  /** Time inside SQL queries, ms. */
  readonly sqlMs: number;
  /** Always empty: the finding is about the request, not about spans. */
  readonly spanIds: readonly number[];
}

/**
 * Evidence for the slow-code detector: a stretch nothing accounts for.
 *
 * `coverage` travels with it because it is the reason the finding is willing
 * to call the stretch code at all: it is the share of the *rest* of the
 * request that instrumentation did account for. High, and the hole is
 * genuinely the application's own work; low, and Reqray is simply blind to
 * this process — which is why the detector stays quiet there instead of
 * blaming code it cannot see.
 */
export interface SlowCodeEvidence {
  readonly kind: 'slow_code';
  /** The unaccounted stretch itself, ms. */
  readonly stretchMs: number;
  /** Where it starts, ms from the beginning of the request. */
  readonly atMs: number;
  /** What share of the request's wall time it is, 0..1. */
  readonly share: number;
  /** How much of the time outside it was instrumented, 0..1. */
  readonly coverage: number;
  /** The handler or middleware it sits inside, or `null` at the top level. */
  readonly label: string | null;
  /** What ran just before it, or `null` when it opens the request. */
  readonly before: string | null;
  /** What ran just after it, or `null` when it ends the request. */
  readonly after: string | null;
  /** The spans that bracket the stretch — what the waterfall badges. */
  readonly spanIds: readonly number[];
  /**
   * What was actually running in the stretch, heaviest first.
   *
   * Empty unless the sampling profiler is on. With it, the finding stops
   * pointing at the boundary of the hole and points inside it — which is the
   * difference between "somewhere between these two queries" and a line
   * number.
   */
  readonly frames: readonly HotFrame[];
  /**
   * Share of the stretch's samples that were on a processor, or `null` when
   * nothing sampled it.
   *
   * Settles what the stretch itself cannot: near one it is code running, near
   * zero the process was waiting on something with no instrumentation behind
   * it.
   */
  readonly busyShare: number | null;
}

/** Finding specifics. Extended as new detectors land. */
export type FindingEvidence =
  | NPlusOneEvidence
  | SequentialHttpEvidence
  | DuplicateEvidence
  | BudgetEvidence
  | HeavyResponseEvidence
  | PoolWaitEvidence
  | TransactionEvidence
  | SlowCodeEvidence;

/** Detector finding: what is wrong, where, what it costs and how to fix it. */
export interface Finding {
  /** Detector id, e.g. `n_plus_one`. */
  readonly detector: string;
  readonly severity: FindingSeverity;
  /** One line for the block heading. */
  readonly title: string;
  /**
   * Milliseconds that come back if the problem is fixed.
   *
   * Zero when the cost of the problem is not time — a response that is too
   * large costs bytes, and the seconds it takes to reach a phone are not
   * something this process measured. A client shows what the evidence says
   * instead of printing "0 ms recoverable".
   */
  readonly costMs: number;
  readonly callsite: Callsite | null;
  readonly evidence: FindingEvidence;
  /** How to fix it. Tailored to the specific ORM where possible. */
  readonly hint: string;
}

/**
 * What the process was doing while the request was in flight.
 *
 * A property of the process, never of the request: under concurrency the code
 * that blocked the loop is usually somebody else's. Read as "the loop was
 * behind by this much while this ran", never as "this request burned this
 * much CPU".
 */
export interface HostState {
  /** Mean event-loop delay over the sampling window, ms. */
  readonly loopDelayMs: number;
  /** The worst delay in that window — what "blocked" means, ms. */
  readonly loopMaxMs: number;
}

/**
 * Where the request's time went.
 *
 * Each figure is a union of the intervals of its own kind, not a sum of
 * durations: four 100 ms queries inside a 120 ms request ran concurrently and
 * cost 120 ms of it, not 400.
 */
export interface RequestTiming {
  /** Time inside SQL queries, ms. */
  readonly sqlMs: number;
  /** Time inside outgoing HTTP calls, ms. */
  readonly externalMs: number;
  /** Time inside cache operations, ms. */
  readonly cacheMs: number;
  /**
   * Time covered by no instrumented work, ms.
   *
   * The application's own code, a timer, or something Reqray has no
   * instrumentation for. Not "CPU this request burned": under concurrency the
   * process may have been running somebody else's.
   */
  readonly selfMs: number;
  /**
   * Instrumented work overlapped in time.
   *
   * When it did, the three figures above can sum past the wall clock, and a
   * client should say so rather than print an addition that does not add up.
   */
  readonly parallel: boolean;
}

/** A body as the buffer stores it: masked, serialized, size-capped. */
export interface RecordedBody {
  /** Serialized text; JSON when the original was structured. */
  readonly text: string;
  /** The text was cut at the configured limit. */
  readonly truncated: boolean;
  /**
   * How big it was before the cut, in bytes.
   *
   * Recorded separately because `text.length` after truncation is the size of
   * the limit, not the size of the body — and a panel that reports the limit
   * back as a measurement is reporting its own settings.
   */
  readonly bytes: number;
}

/**
 * What the request moved.
 *
 * The honest answer to "where did the memory go". Node has no per-request
 * memory to report — `process.memoryUsage()` around a request under
 * concurrency and garbage collection is noise, and sometimes negative — but
 * what a request pulled out of the database and pushed back to the client is
 * knowable, and it is what the spike was made of.
 */
export interface RequestWeight {
  /** Bytes the client sent, or `null` when nothing said. */
  readonly bytesIn: number | null;
  /** Bytes sent back, or `null` when nothing said. */
  readonly bytesOut: number | null;
  /** Rows returned across every query that reported a count. */
  readonly rows: number;
  /** The largest single result, in rows. */
  readonly biggestRows: number;
}

/** A completed request, whole. */
export interface RecordedRequest {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly query: string | null;
  readonly status: number;
  readonly durationMs: number;
  /** Where that duration went. */
  readonly timing: RequestTiming;
  /** What it moved. */
  readonly weight: RequestWeight;
  /**
   * What it cost to run, as distinct from how long it took.
   *
   * `null` for records written before this was measured: a panel that showed
   * a blank cost for yesterday's request would be reporting its own age as
   * the request's fault.
   */
  readonly cost: RequestCost | null;
  /**
   * How the event loop was behaving at the time, or `null` when nothing was
   * measuring it.
   */
  readonly host: HostState | null;
  /** Request start time, epoch ms. */
  readonly startedAt: number;
  readonly spans: readonly Span[];
  readonly findings: readonly Finding[];
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly requestBody: RecordedBody | null;
  readonly responseBody: RecordedBody | null;
  readonly logs: readonly LogEntry[];
  readonly error: SpanError | null;
  /** How many spans had to be dropped because of the limit. */
  readonly droppedSpans: number;
  /** How many log lines had to be dropped because of the per-request cap. */
  readonly droppedLogs: number;
  /** The test that issued the request, or `null` for ordinary traffic. */
  readonly test: string | null;
}
