/**
 * Public Reqray types.
 *
 * The shapes that travel over the panel API are declared once, in
 * `@reqray/protocol`, and re-exported here: the server and every client — the
 * dashboard, the terminal client, somebody's script — must not each carry
 * their own approximation of the same JSON. `@reqray/protocol` contains no
 * runtime code, so core still loads nothing it did not load before.
 *
 * What stays here is what only the recording side needs: the inputs an
 * instrumentation passes to `record`, and the instrumentation contract
 * itself.
 *
 * The core entity names are fixed project-wide and are never renamed:
 * `Span`, `RequestScope`, `Finding`, `Instrumentation`.
 */

import type { CacheOperation, Callsite, LabelSpanKind, SpanError } from '@reqray/protocol';

export type {
  BaselineResponse,
  BudgetEvidence,
  CacheOperation,
  CacheSpan,
  Callsite,
  DbSpan,
  DuplicateEvidence,
  DurationBaseline,
  Finding,
  FindingEvidence,
  FindingSeverity,
  HandlerSpan,
  HeavyResponseEvidence,
  HostPressure,
  HostPressureSide,
  HostState,
  HttpSpan,
  LabelSpanKind,
  LogEntry,
  MetricSeries,
  MiddlewareSpan,
  NPlusOneEvidence,
  PoolWaitEvidence,
  RecordedBody,
  RecordedRequest,
  RequestCost,
  RequestTiming,
  RequestWeight,
  SequentialHttpEvidence,
  SeriesMetric,
  SeriesResponse,
  SeriesTotals,
  SlowCodeEvidence,
  Span,
  SpanError,
  SpanKind,
  TransactionEvidence,
} from '@reqray/protocol';

/** What is known about a panel request when access is checked. */
export interface PanelRequestContext {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip: string | null;
}

/**
 * Who is allowed into the panel.
 *
 * `'open'` is a deliberate "let everyone in": you can write it, but you can
 * never get it by default.
 *
 * Here rather than beside the check that uses it: `config.ts` needs the type
 * and `panel.ts` needs `ResolvedOptions`, and that cycle compiles only while
 * both directions stay type-only.
 */
export type PanelGate = 'open' | ((context: PanelRequestContext) => boolean);

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
  /** @see DbSpan.connectionId */
  readonly connectionId?: number | null;
  /** @see DbSpan.waitMs */
  readonly waitMs?: number | null;
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
  readonly command?: string | null;
  readonly key: string;
  readonly hit?: boolean | null;
}

/** @see MiddlewareSpan @see HandlerSpan */
export interface LabelSpanInput extends SpanInputCommon {
  readonly kind: LabelSpanKind;
  readonly label: string;
}

/** What an instrumentation passes to {@link record}. */
export type SpanInput = DbSpanInput | HttpSpanInput | CacheSpanInput | LabelSpanInput;

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
