/**
 * A collector that answers the three endpoints the client uses.
 *
 * Real HTTP on a real port: the client is a client, and a mocked `fetch`
 * would test the mock. Small enough to keep the interesting parts —
 * a stream that can be dropped mid-flight, a gate that wants a token —
 * within reach of a test.
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PanelMeta, RequestDetail, RequestRow } from '@reqray/protocol';

/** What a fake collector lets a test do. */
export interface FakeCollector {
  /** Base URL of the panel, mount point included. */
  readonly url: string;
  /** Sends a row to everyone watching. */
  push(row: RequestRow): void;
  /** Cuts every open stream, the way a restarting application does. */
  drop(): void;
  /** How many streams are open right now. */
  watchers(): number;
  /** Replaces what the list answers with. */
  setRows(rows: readonly RequestRow[]): void;
  close(): Promise<void>;
}

/** Options for {@link fakeCollector}. */
export interface FakeCollectorOptions {
  readonly rows?: readonly RequestRow[];
  readonly details?: readonly RequestDetail[];
  readonly meta?: Partial<PanelMeta>;
  /** With a token set, requests without it are refused. */
  readonly token?: string;
}

const DEFAULT_META: PanelMeta = {
  pid: 41_822,
  startedAt: 0,
  mode: 'development',
  bufferSize: 500,
  replayEnabled: true,
  blameEnabled: true,
  detectors: [],
};

/** Starts one. Remember to close it. */
export async function fakeCollector(options: FakeCollectorOptions = {}): Promise<FakeCollector> {
  let rows = [...(options.rows ?? [])];
  const details = new Map((options.details ?? []).map((detail) => [detail.id, detail]));
  const streams = new Set<ServerResponse>();

  const send = (response: ServerResponse, status: number, payload: unknown): void => {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://collector.local');
    const route = url.pathname.replace(/^\/_reqray/, '') || '/';

    if (options.token && request.headers['x-reqray-token'] !== options.token) {
      send(response, 403, { error: 'panel access denied by the gate' });
      return;
    }

    if (route === '/api/meta') {
      send(response, 200, { ...DEFAULT_META, ...options.meta });
      return;
    }

    if (route === '/api/requests') {
      // Newest first, as the panel API answers.
      let shown = [...rows].sort((a, b) => b.startedAt - a.startedAt);

      // The same four fields the real filter searches, so a client that works
      // against this one works against the panel.
      const needle = url.searchParams.get('q')?.toLowerCase();
      if (needle) {
        shown = shown.filter((row) =>
          [row.method, row.path, String(row.status), row.query ?? '']
            .join(' ')
            .toLowerCase()
            .includes(needle),
        );
      }
      if (url.searchParams.get('errors') === '1') shown = shown.filter((row) => row.hasError);
      if (url.searchParams.get('findings') === '1') {
        shown = shown.filter((row) => row.findingCount > 0);
      }
      if (url.searchParams.get('sort') === 'slowest') {
        shown = [...shown].sort((a, b) => b.durationMs - a.durationMs);
      }
      const limit = Number(url.searchParams.get('limit') ?? 100);
      send(response, 200, {
        requests: shown.slice(0, limit),
        summary: {
          shown: shown.length,
          total: rows.length,
          slow: 0,
          errors: rows.filter((row) => row.hasError).length,
          withFindings: rows.filter((row) => row.findingCount > 0).length,
        },
        nextCursor: null,
      });
      return;
    }

    if (route.startsWith('/api/requests/')) {
      const id = decodeURIComponent(route.slice('/api/requests/'.length));
      const found = details.get(id);
      if (!found) {
        send(response, 404, { error: 'request not found — possibly evicted from the ring buffer' });
        return;
      }
      send(response, 200, found);
      return;
    }

    if (route === '/api/stream') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      response.write(': reqray stream\n\n');
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }

    send(response, 404, { error: 'no such panel endpoint' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/_reqray`,
    push(row) {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(row)}\n\n`);
    },
    drop() {
      for (const stream of streams.values()) {
        streams.delete(stream);
        stream.destroy();
      }
    },
    watchers: () => streams.size,
    setRows(next) {
      rows = [...next];
    },
    async close() {
      for (const stream of streams) stream.destroy();
      streams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
