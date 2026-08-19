/**
 * The single entry point through which instrumentations record spans.
 */

import type { RequestScope } from './scope.js';
import type { Span, SpanInput } from './types.js';

/**
 * Records a span in the scope.
 *
 * Does nothing and throws nothing when there is no scope: a call outside a
 * request is normal. Internal errors are swallowed too — instrumentation has
 * no right to break someone else's request.
 *
 * @returns the recorded span, or `null` if nothing was recorded.
 *
 * @example
 * ```ts
 * const scope = current();
 * if (!scope) return original.apply(this, args);
 *
 * const t0 = performance.now();
 * // ...
 * record(scope, {
 *   kind: 'db',
 *   sql,
 *   fingerprint: fingerprintSql(sql),
 *   duration: performance.now() - t0,
 *   callsite: scope.shouldCaptureStack(fingerprint) ? captureCallsite(opts) : null,
 * });
 * ```
 */
export function record(scope: RequestScope | undefined | null, input: SpanInput): Span | null {
  if (!scope) return null;
  try {
    return scope.addSpan(input);
  } catch {
    return null;
  }
}
