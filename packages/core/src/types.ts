/**
 * Public Loupe types.
 *
 * The core entity names are fixed project-wide and are never renamed:
 * `Span`, `RequestScope`, `Finding`, `Instrumentation`.
 */

/**
 * Span kind. Drives the bar colour in the waterfall and decides which
 * detectors look at the span at all.
 */
export type SpanKind = 'middleware' | 'handler' | 'db' | 'http' | 'cache';

/** Cache operation. */
export type CacheOperation = 'get' | 'set' | 'del';

/**
 * Place in user code the span came from.
 *
 * Always points inside the project: frames from `node_modules` and Node
 * internals are dropped while capturing the stack.
 */
export interface Callsite {
  /** Absolute file path. */
  readonly file: string;
  /** Path relative to the project root — what the panel shows. */
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
  /**
   * Who recorded the span: `pg`, `prisma`, `mysql2`.
   * Detectors use it to tailor the hint to a specific ORM.
   */
  readonly source: string | null;
  /**
   * Registry id of the pool or client that ran the query — EXPLAIN goes to
   * the same database. `null` when the executor is unknown or gone.
   */
  readonly clientId: number | null;
  /**
   * Parameter values as strings, only under `collectSqlValues: true`.
   * `null` — not collected (the default in every mode).
   */
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
  readonly key: string;
  readonly hit: boolean | null;
}

/** A unit of work inside a request. */
export type Span = MiddlewareSpan | HandlerSpan | DbSpan | HttpSpan | CacheSpan;

interface SpanInputCommon {
  /** Duration, ms. */
  readonly duration: number;
  /**
   * `performance.now()` at the moment the span started.
   *
   * Only needed when the span is recorded later than it finished: by default
   * the start is derived as "now minus duration".
   */
  readonly startTime?: number;
  readonly callsite?: Callsite | null;
  readonly error?: SpanError | null;
}

/** @see DbSpan */
export interface DbSpanInput extends SpanInputCommon {
  readonly kind: 'db';
  readonly sql: string;
  readonly fingerprint: string;
  readonly rowCount?: number | null;
  readonly source?: string | null;
  readonly clientId?: number | null;
  readonly values?: readonly string[] | null;
}

/** @see HttpSpan */
export interface HttpSpanInput extends SpanInputCommon {
  readonly kind: 'http';
  readonly method: string;
  readonly url: string;
  readonly statusCode?: number | null;
}

/** @see CacheSpan */
export interface CacheSpanInput extends SpanInputCommon {
  readonly kind: 'cache';
  readonly operation: CacheOperation;
  readonly key: string;
  readonly hit?: boolean | null;
}

/** @see MiddlewareSpan @see HandlerSpan */
export interface LabelSpanInput extends SpanInputCommon {
  readonly kind: 'middleware' | 'handler';
  readonly label: string;
}

/** What an instrumentation passes to {@link record}. */
export type SpanInput = DbSpanInput | HttpSpanInput | CacheSpanInput | LabelSpanInput;

/** Log line bound to a request. */
export interface LogEntry {
  /** Offset from the request start, ms. */
  readonly at: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
}

/** How serious a finding is. Drives highlighting in the panel. */
export type FindingSeverity = 'info' | 'warn' | 'critical';

/** Evidence for the N+1 detector. */
export interface NPlusOneEvidence {
  readonly kind: 'n_plus_one';
  /** How many times the same fingerprint ran. */
  readonly repeats: number;
  readonly fingerprint: string;
  /** One query from the group — shown in the panel as a sample. */
  readonly sample: string;
  /** Total time of all repeats, ms. */
  readonly totalMs: number;
  readonly spanIds: readonly number[];
}

/** Evidence for the sequential-HTTP detector. */
export interface SequentialHttpEvidence {
  readonly kind: 'sequential_http';
  /** How many calls of one shape ran in sequence. */
  readonly repeats: number;
  /** Normalized call shape: `GET api.example.com/users/:id`. */
  readonly fingerprint: string;
  /** One call from the run — shown in the panel as a sample. */
  readonly sample: string;
  /** Total time of all calls, ms. */
  readonly totalMs: number;
  readonly spanIds: readonly number[];
}

/** Finding specifics. Extended as new detectors land. */
export type FindingEvidence = NPlusOneEvidence | SequentialHttpEvidence;

/**
 * Detector finding: what is wrong, where, what it costs and how to fix it.
 *
 * Without `costMs` and `callsite` a finding is useless — it reports a problem
 * but does not help solve it.
 */
export interface Finding {
  /** Detector id, e.g. `n_plus_one`. */
  readonly detector: string;
  readonly severity: FindingSeverity;
  /** One line for the block heading in the panel. */
  readonly title: string;
  /**
   * Milliseconds that come back if the problem is fixed.
   * Potential saving, not "how long it took".
   */
  readonly costMs: number;
  readonly callsite: Callsite | null;
  readonly evidence: FindingEvidence;
  /** How to fix it. Tailored to the specific ORM where possible. */
  readonly hint: string;
}

/**
 * Instrumentation for a third-party library.
 *
 * The implementation must be transparent to the application: return value,
 * error type, callback order and `this` all stay as they were.
 */
export interface Instrumentation {
  /** Package name as the application resolves it: `pg`, `prisma`, `undici`. */
  readonly name: string;
  /** Semver range the instrumentation is verified against. */
  readonly supportedVersions: string;
  /** What exactly is intercepted — a string for the startup diagnostics. */
  readonly captures?: string;
  /** Patch the module exports. Called once per module. */
  apply(exports: any): void;
  /** Restore the exports to their original state. Needed by tests. */
  unapply?(exports: any): void;
}

/**
 * A body as the buffer stores it: masked, serialized, size-capped.
 *
 * Text rather than a parsed tree — see `body.ts` for why.
 */
export interface RecordedBody {
  /** Serialized text; JSON when the original was structured. */
  readonly text: string;
  /** The text was cut at `redact.maxBodyLength`. */
  readonly truncated: boolean;
}

/** A completed request — what goes to the transport and to the panel. */
export interface RecordedRequest {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly query: string | null;
  readonly status: number;
  readonly durationMs: number;
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
}
