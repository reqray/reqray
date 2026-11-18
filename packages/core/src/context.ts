import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * Current request context.
 *
 * A single `AsyncLocalStorage` per process (see `state.ts` — it lives in the
 * shared state so that the ESM and CJS copies of core do not drift apart).
 * The framework adapter wraps request handling in {@link runInScope};
 * instrumentations reach the scope through {@link current}. No scope means the
 * span is simply ignored, which is not an error: application code also runs
 * outside requests (migrations, workers, startup).
 */

import type { RequestScope } from './scope.js';
import { globalSlot } from './state.js';
import type { Callsite } from './types.js';

/** The request context. One per process — see `state.ts` for why. */
const storage = globalSlot('context.storage', () => new AsyncLocalStorage<RequestScope>());

/**
 * Callsite handed from a pool wrapper down to the driver wrapper.
 *
 * Absent outside a pooled query — that is what tells the driver wrapper to
 * capture a stack of its own.
 */
export const pendingCallsite = globalSlot(
  'context.pendingCallsite',
  () => new AsyncLocalStorage<{ readonly callsite: Callsite | null; readonly clientId?: number }>(),
);

/**
 * Scope of the current request, or `undefined`.
 *
 * This is the first check in every instrumentation: no scope, immediate
 * return, not a single allocation made.
 */
export function current(): RequestScope | undefined {
  return storage().getStore();
}

/** Runs `fn` inside the scope. Return values and exceptions pass through as is. */
export function runInScope<T>(scope: RequestScope, fn: () => T): T {
  return storage().run(scope, fn);
}

/**
 * Enters a scope without wrapping a function.
 *
 * Needed by frameworks where the request start and end are different hooks
 * (Fastify's `onRequest`) and handling cannot be wrapped in a single call.
 */
export function enterScope(scope: RequestScope): void {
  storage().enterWith(scope);
}

/**
 * Runs `fn` outside of any scope.
 *
 * Needed for Reqray's own background work: writing to storage must not end up
 * as spans of the request being handled.
 */
export function runOutsideScope<T>(fn: () => T): T {
  return storage().exit(fn);
}
