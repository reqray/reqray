/**
 * The Loupe runtime: what framework adapters call on every request.
 *
 * This is the hot-path boundary. `begin` and `finish` must cost close to
 * nothing; detectors, masking, serialization and the transport write are
 * deferred to `setImmediate`, where they no longer affect the client's
 * response time.
 */

import { recordBody } from './body.js';
import { type LoupeOptions, type ResolvedOptions, resolveOptions } from './config.js';
import { instrumentConsole } from './console-capture.js';
import { runOutsideScope } from './context.js';
import { runDetectors } from './detectors/index.js';
import { printDiagnosticsOnce } from './diagnostics.js';
import { nextRequestId } from './ids.js';
import { warn, warnOnce } from './logger.js';
import { assertPanelAllowed } from './panel.js';
import { redactHeaders } from './redact.js';
import { shouldRetain } from './sampling.js';
import { RequestScope } from './scope.js';
import { loupeState } from './state.js';
import { nullTransport, type Transport } from './transport.js';
import type { Finding, LogEntry, RecordedRequest, SpanError } from './types.js';

/** Headers in the shape Node and the frameworks hand them over. */
export type HeaderMap = Readonly<Record<string, string | string[] | number | undefined>>;

/** What is known about a request when it starts. */
export interface RequestStart {
  readonly method: string;
  /** Path without the query string. */
  readonly path: string;
  /**
   * Value of the replay marker header, if present.
   *
   * Such a request stays out of the main list: its record goes to the panel
   * that started the replay.
   */
  readonly replayId?: string | null;
}

/** Request outcome. Passed by the adapter once the response has been sent. */
export interface RequestOutcome {
  readonly status: number;
  /** Query string without the `?`, if there was one. */
  readonly query?: string | null;
  readonly requestHeaders?: HeaderMap;
  readonly responseHeaders?: HeaderMap;
  readonly requestBody?: unknown;
  readonly responseBody?: unknown;
  /** The exception, if handling failed. */
  readonly error?: unknown;
}

/** What an adapter drives on every request. */
export interface Loupe {
  readonly options: ResolvedOptions;
  readonly transport: Transport;

  /**
   * Starts a request.
   *
   * @returns the scope, or `undefined` if Loupe is disabled. In that case the
   * adapter must do nothing at all — this is what "disabled Loupe costs zero"
   * means.
   */
  begin(start: RequestStart): RequestScope | undefined;

  /** Finishes a request. Safely accepts `undefined`. */
  finish(scope: RequestScope | undefined, outcome: RequestOutcome): void;
}

/** Runtime creation options. */
export interface LoupeInit extends LoupeOptions {
  /** Where to put collected requests. */
  readonly transport?: Transport;
}

/**
 * Coerces anything thrown into a `SpanError`.
 *
 * Needed by instrumentations: they mark a span with an error but must rethrow
 * the exception itself unchanged.
 */
export function toSpanError(error: unknown): SpanError | null {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  return { name: 'Error', message: String(error), stack: null };
}

function formatDuration(durationMs: number): string {
  return durationMs < 10 ? `${durationMs.toFixed(1)} ms` : `${Math.round(durationMs)} ms`;
}

/**
 * Brackets the collected log lines with a request start and end line.
 *
 * Assembled at finalization rather than on the hot path: both lines are fully
 * derived from data already known.
 */
function bracketLogs(scope: RequestScope, status: number, durationMs: number): LogEntry[] {
  return [
    { at: 0, level: 'info', message: `→ ${scope.method} ${scope.path}` },
    ...scope.logs,
    {
      at: durationMs,
      level: status >= 500 ? 'error' : 'info',
      message: `← ${status} in ${formatDuration(durationMs)}`,
    },
  ];
}

/** How a test harness names the test behind a request. */
export const TEST_HEADER = 'x-loupe-test';

/** The maximum length of a test name kept in a record. */
const MAX_TEST_NAME = 200;

/**
 * The test that issued the request, from the header the harness sets.
 *
 * Read from the raw headers rather than the redacted copy: masking may have
 * replaced the value, and this one is a test name, not a secret.
 *
 * Header values are latin1, and test names are full of characters that are
 * not — Vitest and Jest separate suite from case with `›`. A percent-encoded
 * value is therefore decoded; anything that fails to decode is kept as sent,
 * because a slightly odd name is better than no name.
 */
function testOf(outcome: RequestOutcome): string | null {
  const raw = outcome.requestHeaders?.[TEST_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  let trimmed = value.trim();
  if (trimmed.includes('%')) {
    try {
      trimmed = decodeURIComponent(trimmed);
    } catch {
      // Not percent-encoded after all — a literal `%` in the name.
    }
  }
  return trimmed ? trimmed.slice(0, MAX_TEST_NAME) : null;
}

function buildRecord(
  scope: RequestScope,
  outcome: RequestOutcome,
  durationMs: number,
  findings: readonly Finding[],
  options: ResolvedOptions,
): RecordedRequest {
  const redact = options.redact;
  return {
    id: scope.id,
    method: scope.method,
    path: scope.path,
    query: outcome.query ?? null,
    status: outcome.status,
    durationMs,
    startedAt: scope.startedAt,
    spans: scope.orderedSpans(),
    findings,
    // Masking happens before the buffer write, not at display time.
    requestHeaders: outcome.requestHeaders ? redactHeaders(outcome.requestHeaders, redact) : {},
    responseHeaders: outcome.responseHeaders ? redactHeaders(outcome.responseHeaders, redact) : {},
    requestBody: recordBody(outcome.requestBody, redact),
    responseBody: recordBody(outcome.responseBody, redact),
    logs: bracketLogs(scope, outcome.status, durationMs),
    error: toSpanError(outcome.error),
    droppedSpans: scope.droppedSpans,
    droppedLogs: scope.droppedLogs,
    test: testOf(outcome),
  };
}

/**
 * Creates the runtime.
 *
 * If the panel is enabled somewhere it could be reachable from outside and no
 * gate is set, this throws right here, at application startup.
 */
export function createLoupe(init: LoupeInit = {}): Loupe {
  const options = resolveOptions(init);
  const transport = init.transport ?? nullTransport;

  if (options.enabled) {
    assertPanelAllowed(options);
    // A global tap; whether a line is recorded is decided per request from
    // its scope's options.
    if (options.logs) instrumentConsole();
    if (options.replay && !options.isLocalDevelopment) {
      warn(
        'replay is enabled outside local development. Replaying a request in production means charging a card twice and sending an email twice.',
      );
    }
    // The report is printed on the next tick: by then the adapter has reported
    // itself and the loader hooks have reported everything loaded so far.
    setImmediate(printDiagnosticsOnce);
  }

  return {
    options,
    transport,

    begin(start) {
      if (!options.enabled) return undefined;
      return new RequestScope({
        id: nextRequestId(),
        method: start.method,
        path: start.path,
        options,
        replayId: start.replayId ?? null,
      });
    },

    finish(scope, outcome) {
      if (!scope) return;

      try {
        scope.closeAllSpans();
      } catch {
        // An unclosed span is no reason to lose the whole request.
      }
      const durationMs = performance.now() - scope.startTime;
      // What the detectors need to know about the request as a whole; the
      // scope only knows about spans.
      const facts = { durationMs, status: outcome.status };

      setImmediate(() => {
        // Loupe's own work must not end up as spans of the request being handled.
        runOutsideScope(() => {
          try {
            const waiter = scope.replayId
              ? loupeState().replayWaiters.get(scope.replayId)
              : undefined;

            // A replay is not sampled: its record is needed exactly once and
            // right now — the comparison block in the panel is built from it.
            if (waiter) {
              waiter(
                buildRecord(
                  scope,
                  outcome,
                  durationMs,
                  runDetectors(scope, options, facts),
                  options,
                ),
              );
              return;
            }

            const hasError = outcome.error !== undefined && outcome.error !== null;

            // Detectors run before sampling only when a finding is itself a
            // reason to keep the request. Otherwise they run on the requests
            // that survived, which in production is one in a hundred.
            const findingsFirst = options.sampling.alwaysOnFinding;
            const findings = findingsFirst ? runDetectors(scope, options, facts) : [];

            const retained = shouldRetain(options.sampling, {
              durationMs,
              status: outcome.status,
              hasError,
              findings,
            });
            if (!retained) return;

            transport.send(
              buildRecord(
                scope,
                outcome,
                durationMs,
                findingsFirst ? findings : runDetectors(scope, options, facts),
                options,
              ),
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            warnOnce('loupe.finish', `request not recorded: ${reason}`);
          }
        });
      });
    },
  };
}
