/**
 * The mechanics every instrumentation repeats.
 *
 * An instrumentation is two things: knowledge of one driver — where the SQL
 * is, which argument is the key, what a hit looks like — and the same plumbing
 * every time. The knowledge stays in its own package; the plumbing is here,
 * because each copy of it is a place to get idempotence or error containment
 * wrong inside somebody's production process.
 *
 * Deliberately not here: span shaping. A helper deciding what a db span looks
 * like would pull every driver's vocabulary into core.
 */

import { warnOnce } from './logger.js';

/**
 * Marker for a patched method, in the global symbol registry.
 *
 * Global because one module can reach the loader hook twice by different
 * resolution paths. Keyed by method name because a prototype carries more than
 * one patch — `Pool.prototype` has both `query` and `connect` — and a shared
 * marker would silently skip whichever ran second.
 */
function patchedKey(method: string): symbol {
  return Symbol.for(`reqray.patched.${method}`);
}

/** Where a wrapper keeps the function it replaced. */
function originalKey(method: string): symbol {
  return Symbol.for(`reqray.original.${method}`);
}

// The targets are foreign prototypes: every property access here is untyped by
// nature, and pretending otherwise would only move the casts to the callers.
type Patchable = Record<string | symbol, unknown>;

/** Whether this exact method on this exact target is already wrapped. */
export function isPatched(target: unknown, method: string): boolean {
  return (target as Patchable | null | undefined)?.[patchedKey(method)] === true;
}

/**
 * Replaces one method with a wrapper built from the original.
 *
 * Idempotent: a target already patched for this method is left alone, and so
 * is a target that has no such method to begin with.
 *
 * @returns whether the wrapper was installed.
 */
export function patchMethod(
  target: unknown,
  method: string,
  wrap: (original: (...args: never[]) => unknown) => (...args: never[]) => unknown,
): boolean {
  const object = target as Patchable | null | undefined;
  if (!object) return false;

  const original = object[method];
  if (typeof original !== 'function' || isPatched(object, method)) return false;

  const patched = wrap(original as (...args: never[]) => unknown) as unknown as Patchable;
  patched[originalKey(method)] = original;
  object[method] = patched;
  object[patchedKey(method)] = true;
  return true;
}

/**
 * Puts the original method back.
 *
 * @returns whether anything was restored.
 */
export function unpatchMethod(target: unknown, method: string): boolean {
  const object = target as Patchable | null | undefined;
  if (!object || !isPatched(object, method)) return false;

  const original = (object[method] as Patchable | undefined)?.[originalKey(method)];
  if (typeof original === 'function') object[method] = original;
  delete object[patchedKey(method)];
  return true;
}

/**
 * Runs `finish` when a driver call settles, whichever way it settles.
 *
 * A promise, a callback, or an object that completes on its own — `pg`'s
 * submittables, a cursor, a stream. The third is the trap: recording it on
 * return would put a zero-duration span in the waterfall for something still
 * running, so it is left alone.
 *
 * A rejection rethrows the original error; nothing the caller sees changes.
 */
export function settle<T>(result: T, finish: (value: unknown, error: unknown) => void): T {
  const thenable = result as { then?: unknown } | null | undefined;
  if (!thenable || typeof thenable.then !== 'function') return result;

  return (result as unknown as Promise<unknown>).then(
    (value: unknown) => {
      finish(value, undefined);
      return value;
    },
    (error: unknown) => {
      finish(undefined, error);
      // Unchanged: replacing it changes what the application's catch sees.
      throw error;
    },
  ) as unknown as T;
}

/**
 * Wraps a driver callback so the span is recorded before the caller's own
 * handler runs — and so a throw from that handler cannot lose the span.
 */
export function settleCallback(
  callback: (...args: never[]) => unknown,
  finish: (value: unknown, error: unknown) => void,
): (...args: never[]) => unknown {
  return function reqrayCallback(this: unknown, ...args: never[]) {
    const [error, value] = args as unknown as [unknown, unknown];
    finish(value, error);
    return callback.apply(this, args);
  };
}

/**
 * Runs instrumentation work that must never reach the application.
 *
 * Whatever goes wrong, the host request continues. Reported once — repeating
 * it per query turns a broken instrumentation into a broken log — and that
 * instrumentation then does nothing.
 */
export function guarded(name: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce(
      `instrumentation.${name}`,
      `${name}: instrumentation disabled after an error: ${reason}`,
    );
  }
}
