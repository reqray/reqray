/**
 * The Reqray runtime: what framework adapters call on every request.
 *
 * This is the hot-path boundary. `begin` and `finish` must cost close to
 * nothing; detectors, masking, serialization and the transport write are
 * deferred to `setImmediate`, where they no longer affect the client's
 * response time.
 */

import { join } from 'node:path';
import { recordBody } from './body.js';
import { type ReqrayOptions, type ResolvedOptions, resolveOptions } from './config.js';
import { instrumentConsole } from './console-capture.js';
import { runOutsideScope } from './context.js';
import { measureCost, startCostMeter, stopCostMeter } from './cost.js';
import { runDetectors } from './detectors/index.js';
import { printDiagnosticsOnce, UNGATED_PANEL_NOTE } from './diagnostics.js';
import { type HostMonitor, startHostMonitor } from './host.js';
import { nextRequestId } from './ids.js';
import { warn, warnOnce } from './logger.js';
import { assertPanelAllowed } from './panel.js';
import { type HotFrame, type RequestProfiler, startProfiler } from './profiler.js';
import { redactHeaders, redactQuery } from './redact.js';
import { deliverReplay } from './replay-waiters.js';
import { shouldRetain } from './sampling.js';
import { RequestScope } from './scope.js';
import { selfTimes, timingOf } from './timing.js';
import { multiTransport, nullTransport, type Transport } from './transport.js';
import type { Finding, LogEntry, RecordedRequest, RequestCost, SpanError } from './types.js';
import { weightOf } from './weight.js';

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
export interface Reqray {
  readonly options: ResolvedOptions;
  readonly transport: Transport;

  /**
   * Starts a request.
   *
   * @returns the scope, or `undefined` if Reqray is disabled. In that case the
   * adapter must do nothing at all — this is what "disabled Reqray costs zero"
   * means.
   */
  begin(start: RequestStart): RequestScope | undefined;

  /** Finishes a request. Safely accepts `undefined`. */
  finish(scope: RequestScope | undefined, outcome: RequestOutcome): void;

  /**
   * Stops what this runtime started and lets go of what it holds.
   *
   * `createReqray` starts a host monitor and may open a store; `Transport`
   * declares both `flush` and `close`, and there was no way to reach either.
   * A long-lived process never needed this; a test that builds a runtime per
   * case, and a graceful shutdown that wants the last batch to land, both do.
   *
   * Safe to call twice.
   */
  close(): Promise<void>;
}

/** Runtime creation options. */
export interface ReqrayInit extends ReqrayOptions {
  /**
   * Where to put collected requests.
   *
   * Several are allowed and are written to in order: a store the panel reads
   * and a log file on disk are two transports over one stream of requests.
   */
  readonly transport?: Transport | readonly Transport[];
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
export const TEST_HEADER = 'x-reqray-test';

/**
 * Header that marks a replay.
 *
 * Beside `TEST_HEADER` rather than in the panel: both are read off an incoming
 * request by the adapter, on the recording path. The panel writes this one,
 * which does not make it the panel's.
 */
export const REPLAY_HEADER = 'x-reqray-replay';

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
  // Decoding can produce what a header never could: `%0A` is a line break,
  // and this name is later written into a shell script and onto a terminal.
  trimmed = trimmed.replace(/\p{Cc}/gu, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TEST_NAME) : null;
}

/**
 * How much went back to the client, cheaply.
 *
 * What the client was told, when it was told anything; the body's own size
 * when the framework streamed it as text. An object body is not serialized
 * here to find out — that is the expensive half of finishing a request, and
 * it happens once, later, for the requests that are kept.
 */
function bytesOutOf(outcome: RequestOutcome): number | null {
  const declared = Number(outcome.responseHeaders?.['content-length']);
  if (Number.isFinite(declared) && declared >= 0) return declared;
  return typeof outcome.responseBody === 'string' ? Buffer.byteLength(outcome.responseBody) : null;
}

/** What the response said it was, without the charset and the rest. */
function contentTypeOf(outcome: RequestOutcome): string | null {
  const raw = outcome.responseHeaders?.['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? (value.split(';')[0]?.trim() ?? null) : null;
}

/**
 * Masking and measurement, done once.
 *
 * The detectors need to know how much came back, and the record needs the
 * same masked headers and bodies. Doing it twice would mean masking twice —
 * the expensive half of finishing a request — so it happens here, after the
 * response is on the wire, and both readers share the result.
 */
function prepare(scope: RequestScope, outcome: RequestOutcome, options: ResolvedOptions) {
  const redact = options.redact;
  const requestHeaders = outcome.requestHeaders
    ? redactHeaders(outcome.requestHeaders, redact)
    : {};
  const responseHeaders = outcome.responseHeaders
    ? redactHeaders(outcome.responseHeaders, redact)
    : {};
  const spans = scope.orderedSpans();
  const requestBody = recordBody(outcome.requestBody, redact);
  const responseBody = recordBody(outcome.responseBody, redact);
  return {
    spans,
    requestHeaders,
    responseHeaders,
    requestBody,
    responseBody,
    weight: weightOf({ spans, requestHeaders, responseHeaders, requestBody, responseBody }),
  };
}

type Prepared = ReturnType<typeof prepare>;

/**
 * Completes a slow-code finding with what was actually running in it.
 *
 * The detector can only name the boundary: `shop.js:231` is the query the
 * stretch ends at, not the `pbkdf2Sync` three lines above it that spent the
 * time. Samples know the difference, so where the profiler has them the
 * finding stops pointing at the edge of the hole and points into it.
 *
 * Only the frames are inserted when the window turns out to have been idle.
 * A stretch spent waiting has no line of code to blame, and moving the
 * callsite to whatever ran for two of its samples would be worse than the
 * boundary it already had.
 */
function withHotSpots(
  findings: readonly Finding[],
  scope: RequestScope,
  profiler: RequestProfiler | null,
): Finding[] {
  if (!profiler) return [...findings];

  return findings.map((finding) => {
    const evidence = finding.evidence;
    if (evidence.kind !== 'slow_code') return finding;

    const from = scope.startTime + evidence.atMs;
    const hot = profiler.read(from, from + evidence.stretchMs);
    if (!hot) return finding;

    const top = hot.frames[0];
    const running = hot.busyShare >= RUNNING_SHARE && top !== undefined;

    return {
      ...finding,
      ...(running
        ? {
            callsite: {
              file: join(scope.options.stack.projectRoot, top.relative),
              relative: top.relative,
              line: top.line,
              column: 0,
            },
            title: `${Math.round(evidence.stretchMs)} ms in ${top.functionName}`,
            hint: hintForFrame(top),
          }
        : {
            hint: `Only ${Math.round(hot.busyShare * 100)}% of the samples taken in this stretch were on a processor, so the time went on waiting rather than on running — I/O with no instrumentation behind it, or a timer.`,
          }),
      evidence: { ...evidence, frames: hot.frames, busyShare: hot.busyShare },
    };
  });
}

/**
 * Where to look, and what to look for once there.
 *
 * V8 reports the line a function is defined on, never the line executing, so
 * the address can only be the function. Naming what it was calling is what
 * closes the remaining distance: `registerUser` at `shop.js:213` is where,
 * and `pbkdf2Sync` is the call inside it that spent the time.
 */
function hintForFrame(frame: HotFrame): string {
  const where = `${Math.round(frame.share * 100)}% of the samples in this stretch were inside ${frame.functionName} at ${frame.relative}:${frame.line}`;
  return frame.inside
    ? `${where}, calling ${frame.inside}. V8 reports where a function starts rather than the line running, so look for the ${frame.inside} call.`
    : `${where}.`;
}

/**
 * Above this share of running samples, a stretch is called code and the
 * finding is re-aimed at the function holding it.
 *
 * Below it the stretch was mostly waiting, and the busiest frame is whatever
 * the sampler caught on the way past.
 */
const RUNNING_SHARE = 0.5;

/**
 * Microseconds between stack samples.
 *
 * A millisecond resolves a hundred-millisecond stretch into roughly eighty
 * readings, which is enough for a share to mean something, and measured at
 * about seven microseconds on a request's p99 — under a fiftieth of the
 * budget the published overhead numbers are held to.
 */
const SAMPLE_INTERVAL_US = 1_000;

function buildRecord(
  scope: RequestScope,
  outcome: RequestOutcome,
  durationMs: number,
  findings: readonly Finding[],
  host: HostMonitor | null,
  prepared: Prepared,
  cost: RequestCost,
): RecordedRequest {
  const { spans, requestHeaders, responseHeaders, requestBody, responseBody } = prepared;
  const self = selfTimes(spans);
  return {
    id: scope.id,
    method: scope.method,
    path: scope.path,
    query: outcome.query ? redactQuery(outcome.query, scope.options.redact) : null,
    status: outcome.status,
    durationMs,
    timing: timingOf(spans, durationMs),
    weight: prepared.weight,
    // The window the request ran in, not a measurement of the request: two
    // native reads, and the panel says so in as many words.
    host: host?.read() ?? null,
    cost,
    startedAt: scope.startedAt,
    // Self time is attached here rather than at display time so that the
    // panel, the terminal client and anything else reading the API get one
    // number rather than three implementations of the same subtraction.
    spans: spans.map((span) => ({ ...span, selfMs: self.get(span.id) ?? span.duration })),
    findings,
    // Masking happens before the buffer write, not at display time.
    requestHeaders,
    responseHeaders,
    requestBody,
    responseBody,
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
export function createReqray(init: ReqrayInit = {}): Reqray {
  const options = resolveOptions(init);

  // Before any resource is acquired: this throws on the staging path, and a
  // monitor started first would tick on with nothing left to stop it.
  if (options.enabled) assertPanelAllowed(options);

  const transport = Array.isArray(init.transport)
    ? multiTransport(init.transport)
    : ((init.transport as Transport | undefined) ?? nullTransport);

  // One histogram for the process, started with it: a request that finishes
  // asks the monitor what the loop was doing, and gets an answer or a null.
  const host = options.enabled && options.hostMetrics ? startHostMonitor() : null;

  // The collector is watched from the moment Reqray is: a request's cost is
  // read at its edges, so there is nothing to switch on per request.
  if (options.enabled) startCostMeter();

  // Sampling runs for the process, not per request: a stretch worth
  // explaining is only known about once it is over.
  const profiler =
    options.enabled && options.profile
      ? startProfiler({ stack: options.stack, intervalUs: SAMPLE_INTERVAL_US })
      : null;

  if (options.enabled) {
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
    const ungated = options.panel !== null && options.panel.gate === null;
    setImmediate(() => printDiagnosticsOnce(ungated ? UNGATED_PANEL_NOTE : undefined));
  }

  let closed = false;

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
      // The one thing that cannot wait: measured now, or it measures the
      // scheduling delay as well. The cost is read here for the same reason —
      // the processor time of the tick that follows is not this request's.
      const durationMs = performance.now() - scope.startTime;
      const cost = measureCost(scope.costMark, scope.startTime, durationMs);

      setImmediate(() => {
        // Reqray's own work must not end up as spans of the request being handled.
        runOutsideScope(() => {
          try {
            // What the detectors need to know about the request as a whole;
            // the scope only knows about spans. Read straight off the outcome
            // rather than from the prepared record: in production the
            // detectors run before the sampling decision, and masking a body
            // about to be dropped is work nobody asked for.
            //
            // Built here rather than above, because everything in it is
            // derivable from `outcome`, which the closure already holds — and
            // the response path is not the place to allocate an object and
            // split a content-type header.
            const facts = {
              durationMs,
              status: outcome.status,
              bytesOut: bytesOutOf(outcome),
              contentType: contentTypeOf(outcome),
            };

            // A replay is not sampled: its record is needed exactly once and
            // right now — the comparison block in the panel is built from it.
            if (
              scope.replayId &&
              deliverReplay(
                scope.replayId,
                buildRecord(
                  scope,
                  outcome,
                  durationMs,
                  withHotSpots(runDetectors(scope, options, facts), scope, profiler),
                  host,
                  prepare(scope, outcome, options),
                  cost,
                ),
              )
            ) {
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
                withHotSpots(
                  findingsFirst ? findings : runDetectors(scope, options, facts),
                  scope,
                  profiler,
                ),
                host,
                prepare(scope, outcome, options),
                cost,
              ),
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            warnOnce('reqray.finish', `request not recorded: ${reason}`);
          }
        });
      });
    },

    async close() {
      if (closed) return;
      closed = true;

      host?.stop();
      profiler?.stop();
      stopCostMeter();
      // Flush before close: the point of closing gracefully is that the last
      // batch lands, and a transport that buffers has nowhere to put it after.
      try {
        await transport.flush?.();
      } catch {
        // A shutdown must not fail because a collector was already gone.
      }
      try {
        await transport.close?.();
      } catch {
        // Same.
      }
    },
  };
}
