import type { RequestScope } from '../scope.js';
import type { Finding } from '../types.js';

/**
 * A detector is a pure function that inspects a finished `RequestScope` and
 * returns a list of findings.
 *
 * It runs **after** the response has been sent to the client, so it can afford
 * to be relatively expensive. But not quadratic: at 500 spans per request
 * `O(n²)` is already noticeable.
 */
export interface Detector<Options> {
  /** Identifier that ends up in `Finding.detector`. */
  readonly id: string;
  readonly defaultOptions: Options;
  run(scope: RequestScope, options: Options, request: FinishedRequest): Finding[];
}

/**
 * Facts about the finished request that are not on the scope.
 *
 * The wall duration is measured by the adapter when the response ends;
 * deriving it inside a detector would measure the finalization delay too.
 */
export interface FinishedRequest {
  readonly durationMs: number;
  readonly status: number;
  /**
   * Bytes sent to the client, or `null` when nothing said how many.
   *
   * The scope knows about spans and nothing about the response, and a
   * detector that reached for the body would be reading it a second time
   * after it was already masked and capped.
   */
  readonly bytesOut: number | null;
  /**
   * The response's content type, without its parameters, or `null`.
   *
   * One header rather than the map: a detector that could read every header
   * would end up reading the ones masking exists for.
   */
  readonly contentType: string | null;
}
