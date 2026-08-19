/**
 * `@loupe/instrumentation-undici` — interception of outgoing HTTP.
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
  handedCallsite,
  type Instrumentation,
  type RequestScope,
  record,
  resolveCallsite,
  toSpanError,
  warnOnce,
  withHandedCallsite,
} from '@loupe/core';

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
}

// Keyed by the undici request object itself: nothing is left behind once it is
// garbage collected.
const inFlight = new WeakMap<object, CallState>();

function urlOf(request: UndiciRequest): string {
  const origin = typeof request.origin === 'string' ? request.origin : String(request.origin ?? '');
  return `${origin}${request.path ?? ''}`;
}

function finish(request: object, error: unknown): void {
  const state = inFlight.get(request);
  if (!state) return;
  inFlight.delete(request);

  try {
    record(state.scope, {
      kind: 'http',
      method: state.method,
      url: state.url,
      duration: performance.now() - state.startTime,
      startTime: state.startTime,
      statusCode: state.statusCode,
      callsite: state.callsite,
      error: toSpanError(error),
    });
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
    const url = urlOf(details);

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

/** "Already patched" marker: two copies of this module must not stack wrappers. */
const PATCHED_FETCH = Symbol.for('loupe.patched.fetch');

interface PatchedFetch {
  (...args: unknown[]): unknown;
  [PATCHED_FETCH]?: typeof globalThis.fetch;
}

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
  const holder = globalThis as { fetch?: typeof globalThis.fetch };
  const original = holder.fetch;
  if (typeof original !== 'function' || (original as PatchedFetch)[PATCHED_FETCH]) return;

  const patched = function loupeFetch(
    this: unknown,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) {
    let handed: { callsite: Callsite | null } | null = null;
    try {
      const scope = current();
      if (scope) {
        const [method, url] = targetOf(input, init);
        handed = { callsite: resolveCallsite(scope, fingerprintHttp(method, url), loupeFetch) };
      }
    } catch {
      // Instrumentation must never break the host call.
    }
    if (!handed) return original.call(this, input, init);
    return withHandedCallsite(handed, () => original.call(this, input, init));
  } as typeof globalThis.fetch;

  (patched as PatchedFetch)[PATCHED_FETCH] = original;
  holder.fetch = patched;
}

function unpatchFetch(): void {
  const holder = globalThis as { fetch?: typeof globalThis.fetch };
  const original = (holder.fetch as PatchedFetch | undefined)?.[PATCHED_FETCH];
  if (original) holder.fetch = original;
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
      try {
        for (const [channel, handler] of subscriptions) {
          diagnosticsChannel.subscribe(channel, handler);
        }
        patchFetch();
        subscribed = true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce('instrumentation.undici', `undici: instrumentation disabled: ${reason}`);
      }
    },

    unapply() {
      if (!subscribed) return;
      try {
        for (const [channel, handler] of subscriptions) {
          diagnosticsChannel.unsubscribe(channel, handler);
        }
        unpatchFetch();
      } catch {
        // Unsubscribing must never throw into the host application either.
      }
      subscribed = false;
    },
  };
}
