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

/**
 * A transport that writes to several others.
 *
 * It says which ones: the panel needs the store among them, and a wrapper
 * that hides its members would hide the store with them.
 */
export interface MultiTransport extends Transport {
  readonly transports: readonly Transport[];
}

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
 * One transport that writes to several.
 *
 * A store and a log file are two transports over one stream of requests, and
 * neither should have to know about the other. A transport that throws is
 * reported once and skipped — the others still get the request, because a
 * broken log must not cost the panel its data.
 */
export function multiTransport(transports: readonly Transport[]): Transport {
  const list = transports.filter(Boolean);
  if (list.length === 1) return list[0] as Transport;

  const fanOut: MultiTransport = {
    name: list.map((transport) => transport.name).join('+') || 'null',
    transports: list,

    send(request) {
      for (const transport of list) {
        try {
          transport.send(request);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          warnOnce(
            `transport.send.${transport.name}`,
            `${transport.name} refused a request: ${reason}`,
          );
        }
      }
    },

    async flush() {
      await Promise.all(list.map((transport) => transport.flush?.()));
    },

    async close() {
      await Promise.all(list.map((transport) => transport.close?.()));
    },
  };
  return fanOut;
}

/**
 * Transport that stores nothing.
 *
 * The core default: `@reqray/core` depends on no package at all, transports
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
