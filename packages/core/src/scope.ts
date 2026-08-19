/**
 * `RequestScope` — everything known about one request being handled.
 *
 * Lives in `AsyncLocalStorage` (see `context.ts`). The framework adapter
 * creates the scope and wraps handling in it; instrumentations reach it via
 * `current()` and push spans into it.
 */

import type { ResolvedOptions } from './config.js';
import { loupeState } from './state.js';
import type { LogEntry, Span, SpanError, SpanInput } from './types.js';

/** Log lines one request may hold. Above it lines are counted, not stored. */
const MAX_LOG_LINES = 200;

/** An open, not yet finished span. */
interface OpenFrame {
  readonly id: number;
  readonly parentId: number | null;
  readonly kind: 'middleware' | 'handler';
  readonly label: string;
  readonly startTime: number;
}

/** What the scope needs to know at creation time. */
export interface RequestScopeInit {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly options: ResolvedOptions;
  /** `performance.now()` at the request start. */
  readonly startTime?: number;
  /** `Date.now()` at the request start. */
  readonly startedAt?: number;
  /** Replay marker: such a request stays out of the main list. */
  readonly replayId?: string | null;
}

/** Everything known about one request being handled. */
export class RequestScope {
  readonly id: string;
  readonly method: string;
  /** The path may be refined after route matching — e.g. to `/users/:id`. */
  path: string;
  /** `performance.now()` at the request start. */
  readonly startTime: number;
  /** `Date.now()` at the request start. */
  readonly startedAt: number;
  readonly options: ResolvedOptions;
  /** Replay id, if the request was launched from the panel. */
  readonly replayId: string | null;

  /** Finished spans, in completion order. */
  readonly spans: Span[] = [];
  readonly logs: LogEntry[] = [];

  /** How many spans were dropped because of the `maxSpansPerRequest` limit. */
  droppedSpans = 0;
  /** How many log lines were dropped because of the per-request cap. */
  droppedLogs = 0;

  #nextSpanId = 1;
  #open: OpenFrame[] = [];

  constructor(init: RequestScopeInit) {
    this.id = init.id;
    this.method = init.method;
    this.path = init.path;
    this.options = init.options;
    this.startTime = init.startTime ?? performance.now();
    this.startedAt = init.startedAt ?? Date.now();
    this.replayId = init.replayId ?? null;
  }

  /** Span the work is currently running inside of, or `null`. */
  get currentSpanId(): number | null {
    return this.#open.length > 0 ? (this.#open[this.#open.length - 1]?.id ?? null) : null;
  }

  /**
   * Whether to capture a stack for the next occurrence of a fingerprint.
   *
   * Always in development. In production only while the origin of that
   * fingerprint is still unknown, counted **across the process** rather than
   * within one request: a request usually issues a handful of queries, so
   * per-request counting would mean capturing a stack for nearly every one of
   * them — measured at roughly a third of the application's throughput.
   * Later spans reuse what was learned; see `resolveCallsite`.
   */
  shouldCaptureStack(fingerprint?: string): boolean {
    const max = this.options.stack.maxPerFingerprint;
    if (max === Number.POSITIVE_INFINITY) return true;
    if (max <= 0) return false;

    const known = loupeState().callsites.get(fingerprint ?? '');
    return (known?.samples ?? 0) < max;
  }

  /**
   * Records a finished span.
   *
   * @internal Called through {@link record}; instrumentations never touch the
   * scope directly.
   */
  addSpan(input: SpanInput): Span | null {
    if (this.spans.length + this.#open.length >= this.options.maxSpansPerRequest) {
      this.droppedSpans++;
      return null;
    }

    const startTime = input.startTime ?? performance.now() - input.duration;
    const common = {
      id: this.#nextSpanId++,
      parentId: this.currentSpanId,
      startedAt: startTime - this.startTime,
      duration: input.duration,
      callsite: input.callsite ?? null,
      error: input.error ?? null,
    };

    let span: Span;
    switch (input.kind) {
      case 'db':
        span = {
          ...common,
          kind: 'db',
          sql: input.sql,
          fingerprint: input.fingerprint,
          rowCount: input.rowCount ?? null,
          source: input.source ?? null,
          clientId: input.clientId ?? null,
          values: input.values ?? null,
        };
        break;
      case 'http':
        span = {
          ...common,
          kind: 'http',
          method: input.method,
          url: input.url,
          statusCode: input.statusCode ?? null,
        };
        break;
      case 'cache':
        span = {
          ...common,
          kind: 'cache',
          operation: input.operation,
          key: input.key,
          hit: input.hit ?? null,
        };
        break;
      default:
        span = { ...common, kind: input.kind, label: input.label };
        break;
    }

    this.spans.push(span);
    return span;
  }

  /**
   * Opens a span that subsequent spans will nest inside.
   *
   * @returns the span id for {@link closeSpan}, or `-1` if the span limit
   * kicked in.
   * @internal
   */
  openSpan(kind: 'middleware' | 'handler', label: string): number {
    if (this.spans.length + this.#open.length >= this.options.maxSpansPerRequest) {
      this.droppedSpans++;
      return -1;
    }
    const id = this.#nextSpanId++;
    this.#open.push({
      id,
      parentId: this.currentSpanId,
      kind,
      label,
      startTime: performance.now(),
    });
    return id;
  }

  /**
   * Closes a previously opened span. Repeat calls and unknown ids are ignored.
   *
   * @internal
   */
  closeSpan(id: number, error: SpanError | null = null): Span | null {
    if (id < 0) return null;
    const index = this.#open.findIndex((frame) => frame.id === id);
    if (index === -1) return null;

    const [frame] = this.#open.splice(index, 1);
    if (!frame) return null;

    const span: Span = {
      id: frame.id,
      parentId: frame.parentId,
      kind: frame.kind,
      label: frame.label,
      startedAt: frame.startTime - this.startTime,
      duration: performance.now() - frame.startTime,
      callsite: null,
      error,
    };
    this.spans.push(span);
    return span;
  }

  /** Closes whatever is still open at the end of the request. @internal */
  closeAllSpans(): void {
    while (this.#open.length > 0) {
      const frame = this.#open[this.#open.length - 1];
      if (!frame) break;
      this.closeSpan(frame.id);
    }
  }

  /**
   * Adds a log line bound to the request. @internal
   *
   * Capped: a request logging in a tight loop must not blow up the buffer.
   */
  addLog(level: LogEntry['level'], message: string): void {
    if (this.logs.length >= MAX_LOG_LINES) {
      this.droppedLogs++;
      return;
    }
    this.logs.push({ at: performance.now() - this.startTime, level, message });
  }

  /**
   * Spans in start order — the order the waterfall shows them in.
   *
   * Sorted once at request finalization, i.e. already off the hot path.
   */
  orderedSpans(): Span[] {
    return [...this.spans].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  }
}
