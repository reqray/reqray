/**
 * The transport is tested against a real HTTP server: what matters is the
 * behaviour on the wire and around failures, not the internals.
 */

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type RecordedRequest, resetWarnings } from '@loupe/core';
import { httpTransport, type IngestPayload } from '@loupe/transport-http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function record(id: string): RecordedRequest {
  return {
    id,
    method: 'GET',
    path: '/orders',
    query: null,
    status: 200,
    durationMs: 12,
    startedAt: Date.now(),
    spans: [],
    findings: [],
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    logs: [],
    error: null,
    droppedSpans: 0,
    droppedLogs: 0,
  };
}

/** Collector stub: collects batches, fails on demand. */
interface Collector {
  readonly url: string;
  readonly batches: RecordedRequest[][];
  /** While `true`, every ingest gets a 500. */
  failing: boolean;
  received(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function startCollector(): Promise<Collector> {
  const batches: RecordedRequest[][] = [];
  const waiters: Array<() => void> = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (collector.failing) {
        response.writeHead(500).end();
        return;
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as IngestPayload;
      batches.push([...payload.requests]);
      for (const wake of waiters.splice(0)) wake();
      response.writeHead(200).end('{}');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const collector: Collector = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    failing: false,
    received(count, timeoutMs = 2_000) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`the collector never received ${count} records`)),
          timeoutMs,
        );
        const check = () => {
          if (batches.flat().length >= count) {
            clearTimeout(deadline);
            resolve();
            return;
          }
          waiters.push(check);
        };
        check();
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return collector;
}

let collector: Collector;

beforeEach(async () => {
  resetWarnings();
  collector = await startCollector();
});

afterEach(async () => {
  await collector.close();
});

describe('batching', () => {
  it('sends a batch once it reaches the size', async () => {
    const transport = httpTransport({ url: collector.url, batchSize: 3, flushIntervalMs: 60_000 });

    transport.send(record('a'));
    transport.send(record('b'));
    expect(collector.batches).toHaveLength(0);
    transport.send(record('c'));

    await collector.received(3);
    expect(collector.batches[0]?.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    await transport.close();
  });

  it('sends an incomplete batch on the timer', async () => {
    const transport = httpTransport({ url: collector.url, batchSize: 100, flushIntervalMs: 20 });

    transport.send(record('a'));
    transport.send(record('b'));

    await collector.received(2);
    expect(collector.batches[0]?.map((r) => r.id)).toEqual(['a', 'b']);
    await transport.close();
  });

  it('sends the token in a header', async () => {
    const seen: Array<string | undefined> = [];
    const probe = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(200).end('{}');
    });
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const url = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;

    const transport = httpTransport({ url, token: 'staging-secret', batchSize: 1 });
    transport.send(record('a'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seen[0]).toBe('Bearer staging-secret');
    await transport.close();
    await new Promise<void>((resolve) => {
      probe.closeAllConnections();
      probe.close(() => resolve());
    });
  });
});

describe('backpressure', () => {
  it('evicts the oldest records when the queue overflows', async () => {
    collector.failing = true;
    const transport = httpTransport({
      url: collector.url,
      batchSize: 10,
      flushIntervalMs: 60_000,
      maxQueue: 3,
      retryDelayMs: 60_000,
    });

    for (const id of ['a', 'b', 'c', 'd', 'e']) transport.send(record(id));
    collector.failing = false;
    await transport.flush();

    expect(collector.batches.flat().map((r) => r.id)).toEqual(['c', 'd', 'e']);
    await transport.close();
  });

  it('an unreachable collector neither crashes nor blocks the application', async () => {
    // A port from the closed collector: connections are refused instantly.
    const dead = collector.url;
    await collector.close();

    const transport = httpTransport({ url: dead, batchSize: 2, flushIntervalMs: 10 });
    for (let i = 0; i < 20; i++) transport.send(record(String(i)));

    // Sending must fail in the background without an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await transport.close();
  });

  it('after the collector recovers, the queue gets through', async () => {
    collector.failing = true;
    const transport = httpTransport({
      url: collector.url,
      batchSize: 2,
      flushIntervalMs: 10,
      retryDelayMs: 20,
    });

    transport.send(record('a'));
    transport.send(record('b'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(collector.batches).toHaveLength(0);

    collector.failing = false;
    await collector.received(2, 5_000);
    expect(collector.batches.flat().map((r) => r.id)).toEqual(['a', 'b']);
    await transport.close();
  });
});

describe('shutdown', () => {
  it('flush sends the tail smaller than a batch', async () => {
    const transport = httpTransport({
      url: collector.url,
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    transport.send(record('a'));
    await transport.flush();

    expect(collector.batches.flat().map((r) => r.id)).toEqual(['a']);
    await transport.close();
  });

  it('after close nothing is sent and nothing crashes', async () => {
    const transport = httpTransport({ url: collector.url, batchSize: 1 });
    await transport.close();

    transport.send(record('late'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(collector.batches).toHaveLength(0);
  });
});
