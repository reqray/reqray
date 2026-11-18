/**
 * `@reqray/instrumentation-undici` — interception of outgoing HTTP.
 *
 * **Interception method: `diagnostics_channel`.** This is the most preferred
 * option available: undici publishes the channels natively, so nothing is
 * patched and nothing breaks when it is upgraded. Built-in `fetch` is covered
 * along the way — it is undici.
 *
 * Loader hooks are not needed here at all: the subscription works regardless of
 * when and how the application imported undici.
 */

import diagnosticsChannel from 'node:diagnostics_channel';
import {
  type Callsite,
  current,
  fingerprintHttp,
  guarded,
  handedCallsite,
  type Instrumentation,
  patchMethod,
  type RequestScope,
  record,
  redactQuery,
  resolveCallsite,
  type Span,
  toSpanError,
  unpatchMethod,
  withHandedCallsite,
} from '@reqray/core';

/** What undici puts into the `undici:request:create` channel. */
interface UndiciRequest {
  readonly origin?: unknown;
  readonly path?: string;
  readonly method?: string;
}

/** Call state from start to completion. */
interface CallState {
  readonly scope: RequestScope;
  readonly startTime: number;
  readonly method: string;
  readonly url: string;
  readonly callsite: Callsite | null;
  statusCode: number | null;
  /** Whether the span was written when the headers arrived. */
  recorded: boolean;
  /** That span, unless the scope was already full. */
  span: Span | null;
}

// Keyed by the undici request object itself: nothing is left behind once it is
// garbage collected.
const inFlight = new WeakMap<object, CallState>();

function urlOf(request: UndiciRequest): string {
  const origin = typeof request.origin === 'string' ? request.origin : String(request.origin ?? '');
  return `${origin}${request.path ?? ''}`;
}

/** Writes the call's span as things stand: the time so far, the status known. */
function write(state: CallState, error: unknown): void {
  state.recorded = true;
  state.span = record(state.scope, {
    kind: 'http',
    method: state.method,
    url: state.url,
    duration: performance.now() - state.startTime,
    startTime: state.startTime,
    statusCode: state.statusCode,
    callsite: state.callsite,
    error: toSpanError(error),
  });
}

function finish(request: object, error: unknown): void {
  const state = inFlight.get(request);
  if (!state) return;
  inFlight.delete(request);

  try {
    if (!state.recorded) {
      write(state, error);
      return;
    }
    // Written at the headers; the body has now been read to its end, or
    // failed on the way. The record copies spans when the request is
    // finalized, so correcting this one in place is all it takes — and after
    // that point the correction lands on an object nobody reads.
    if (state.span) {
      Object.assign(state.span, {
        duration: performance.now() - state.startTime,
        error: toSpanError(error),
      });
    }
  } catch {
    // Instrumentation must never break the host request.
  }
}

function onCreate(message: unknown): void {
  try {
    const request = (message as { request?: object })?.request;
    if (!request) return;

    // Channel handlers run synchronously in the caller's context, so the scope is
    // still visible here. By the time the request completes the context is a
    // different one — hence the WeakMap.
    const scope = current();
    if (!scope) return;

    const details = request as UndiciRequest;
    const method = details.method ?? 'GET';
    // `?api_key=…` and presigned URLs are secrets in a place masking by
    // header and body field never looked.
    const url = redactQuery(urlOf(details), scope.options.redact);

    // No stack is captured here: the channel is published from the dispatcher,
    // so the user's frame is already off the synchronous stack. The `fetch`
    // wrapper below captures the callsite while the frame is still there and
    // hands it down through the same context the pg pool wrapper uses.
    inFlight.set(request, {
      scope,
      startTime: performance.now(),
      method,
      url,
      callsite: handedCallsite()?.callsite ?? null,
      statusCode: null,
      recorded: false,
      span: null,
    });
  } catch {
    // Instrumentation must never break the host request.
  }
}

function onHeaders(message: unknown): void {
  try {
    const payload = message as { request?: object; response?: { statusCode?: unknown } };
    if (!payload?.request) return;
    const state = inFlight.get(payload.request);
    if (!state) return;
    const status = payload.response?.statusCode;
    if (typeof status === 'number') state.statusCode = status;
    // Recorded now rather than at the trailers: those only come once the
    // body has been read to its end, and `if (!res.ok) throw` never reads it.
    // Such a call used to leave no span at all, and its time showed up as a
    // stretch of the application's own code.
    if (!state.recorded) write(state, undefined);
  } catch {
    // Instrumentation must never break the host request.
  }
}

function onTrailers(message: unknown): void {
  const request = (message as { request?: object })?.request;
  if (request) finish(request, undefined);
}

function onError(message: unknown): void {
  const payload = message as { request?: object; error?: unknown };
  if (payload?.request) finish(payload.request, payload.error);
}

const subscriptions: ReadonlyArray<readonly [string, (message: unknown) => void]> = [
  ['undici:request:create', onCreate],
  ['undici:request:headers', onHeaders],
  ['undici:request:trailers', onTrailers],
  ['undici:request:error', onError],
];

let subscribed = false;

/** Method and URL of a `fetch` call, best effort for every call shape. */
function targetOf(input: unknown, init: unknown): [method: string, url: string] {
  const options = init as { method?: unknown } | undefined;
  if (input && typeof input === 'object' && 'url' in input && 'method' in input) {
    const request = input as { url: unknown; method: unknown };
    const method =
      typeof options?.method === 'string'
        ? options.method
        : typeof request.method === 'string'
          ? request.method
          : 'GET';
    return [method, typeof request.url === 'string' ? request.url : String(input)];
  }
  return [typeof options?.method === 'string' ? options.method : 'GET', String(input)];
}

/**
 * Wraps `globalThis.fetch` to capture the caller's line of code.
 *
 * The channels record the span, but they fire from the dispatcher where the
 * user's frame is gone. This wrapper is the only place the frame still exists;
 * the callsite is handed down the same way the pg pool wrapper does it. The
 * wrapper changes nothing else — arguments, return value and errors pass
 * through untouched.
 */
function patchFetch(): void {
  patchMethod(
    globalThis,
    'fetch',
    (original: any) =>
      function reqrayFetch(
        this: unknown,
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) {
        let handed: { callsite: Callsite | null } | null = null;
        try {
          const scope = current();
          if (scope) {
            const [method, url] = targetOf(input, init);
            handed = {
              callsite: resolveCallsite(scope, fingerprintHttp(method, url), reqrayFetch),
            };
          }
        } catch {
          // Instrumentation must never break the host call.
        }
        if (!handed) return original.call(this, input, init);
        return withHandedCallsite(handed, () => original.call(this, input, init));
      },
  );
}

/** Instrumentation for outgoing HTTP: undici and built-in `fetch`. */
export function instrumentUndici(): Instrumentation {
  return {
    name: 'undici',
    // The channels have been stable since undici 5; there is no range to check,
    // the subscription does not depend on the installed package version.
    supportedVersions: '*',
    captures: 'outgoing HTTP',

    apply() {
      if (subscribed) return;
      guarded('undici', () => {
        for (const [channel, handler] of subscriptions) {
          diagnosticsChannel.subscribe(channel, handler);
        }
        patchFetch();
        subscribed = true;
      });
    },

    unapply() {
      if (!subscribed) return;
      guarded('undici', () => {
        for (const [channel, handler] of subscriptions) {
          diagnosticsChannel.unsubscribe(channel, handler);
        }
        unpatchMethod(globalThis, 'fetch');
      });
      subscribed = false;
    },
  };
}
