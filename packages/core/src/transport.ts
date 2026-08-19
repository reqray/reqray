/**
 * Where collected requests go.
 *
 * Transport and storage are separate on purpose: locally the data sits in
 * memory, while in staging and production the in-process agent only collects
 * and ships batches to an external collector. Batching and backpressure are
 * the transport's business; the core knows nothing about them.
 */

import { warnOnce } from './logger.js';
import type { RecordedRequest } from './types.js';

/** Where finished requests are sent. */
export interface Transport {
  /** Name for diagnostics: `memory`, `http`. */
  readonly name: string;

  /**
   * Accept a finished request.
   *
   * Called outside request handling. Must not throw: the core does catch
   * transport errors, but do not rely on that.
   */
  send(request: RecordedRequest): void;

  /** Wait for everything buffered to be sent. */
  flush?(): Promise<void>;

  /** Close the transport and release resources. */
  close?(): Promise<void>;
}

/**
 * Transport that stores nothing.
 *
 * The core default: `@loupe/core` depends on no package at all, transports
 * included. Adapters plug in a real transport themselves.
 */
export const nullTransport: Transport = {
  name: 'null',
  send() {
    warnOnce(
      'transport.null',
      'requests are not stored anywhere — no transport configured. Pass `transport` in the options.',
    );
  },
};
