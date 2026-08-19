/**
 * `@loupe/server` — the collector.
 *
 * A separate process: applications ship batches over HTTP (see
 * `@loupe/transport-http`), the collector stores them and serves the same
 * panel the in-process adapters do. Bare `node:http` on purpose — a collector
 * needs no router or plugins, and every dependency is somebody else's risk.
 *
 * Security model: with no token the server listens on loopback only, exactly
 * like local development. A token makes it reachable from outside: ingest
 * requires it in the `authorization` header, and the panel is opened in a
 * browser through `/auth?token=…`, which sets an HttpOnly cookie.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import {
  createPanelHandler,
  type PanelGate,
  type RecordedRequest,
  resolveOptions,
  warnOnce,
} from '@loupe/core';
import { type MemoryStore, memoryTransport } from '@loupe/transport-memory';

/** Options for {@link createLoupeServer}. */
export interface LoupeServerOptions {
  /** Port. `0` picks a free one. */
  readonly port?: number;
  /**
   * Address to bind. Defaults to loopback; anything wider requires a token —
   * the collector shows request bodies and SQL to whoever reaches it.
   */
  readonly host?: string;
  /** Shared secret: required in ingest headers and for panel access. */
  readonly token?: string;
  /** How many requests the collector keeps. */
  readonly bufferSize?: number;
}

/** A running collector. */
export interface LoupeServer {
  /** Address the server actually listens on. */
  readonly url: string;
  /** The store — exposed for tests and embedding. */
  readonly store: MemoryStore;
  close(): Promise<void>;
}

const COOKIE_NAME = 'loupe_token';
const MAX_INGEST_BYTES = 32 * 1024 * 1024;

/** Directory with the built dashboard, when it is installed. */
function dashboardAssets(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve('@loupe/dashboard/package.json');
    return join(dirname(manifest), 'dist');
  } catch {
    return undefined;
  }
}

/** Constant-time comparison: a token check must not leak length or prefix. */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

/**
 * The token in the cookie is not the token itself but a per-process session
 * value issued by `/auth`: cookies leak far more easily than the secret
 * should.
 */
function issueSession(): string {
  return randomBytes(24).toString('base64url');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** Light shape check: one malformed record must not poison the panel. */
function isIngestible(value: unknown): value is RecordedRequest {
  const record = value as Partial<RecordedRequest> | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.id === 'string' &&
    typeof record.method === 'string' &&
    typeof record.path === 'string' &&
    typeof record.status === 'number' &&
    typeof record.durationMs === 'number' &&
    typeof record.startedAt === 'number' &&
    Array.isArray(record.spans) &&
    Array.isArray(record.findings) &&
    Array.isArray(record.logs)
  );
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_INGEST_BYTES) throw new Error('batch larger than 32 MB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Starts the collector. Resolves once it is listening. */
export async function createLoupeServer(options: LoupeServerOptions = {}): Promise<LoupeServer> {
  const token = options.token;
  const host = options.host ?? '127.0.0.1';

  if (!token && host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `loupe-server: listening on ${host} without a token is not allowed — the panel exposes request bodies and SQL. ` +
        'Set a token or keep 127.0.0.1.',
    );
  }

  const store = memoryTransport({ capacity: options.bufferSize ?? 2_000 });
  const sessions = new Set<string>();

  // The panel is authorized either by the cookie session issued at /auth or
  // by the raw token in a header — the latter for curl and healthchecks.
  const gate: PanelGate = token
    ? (context) => {
        const cookie = cookieValue(
          typeof context.headers.cookie === 'string' ? context.headers.cookie : undefined,
          COOKIE_NAME,
        );
        if (cookie && sessions.has(cookie)) return true;
        const header = context.headers['x-loupe-token'];
        return typeof header === 'string' && tokenMatches(token, header);
      }
    : 'open';

  const panel = createPanelHandler({
    source: store,
    // The collector itself is not the application: nothing is sampled here
    // and replay is impossible — the process the request lived in is remote.
    options: resolveOptions({
      enabled: true,
      mode: 'production',
      replay: false,
      panel: { gate },
    }),
    assetsDir: dashboardAssets(),
  });

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce('server.handle', `collector failed to handle a request: ${reason}`);
      if (!response.headersSent) sendJson(response, 500, { error: reason });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://loupe.local');

    if (url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true, size: store.stats().size });
      return;
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      if (token && !tokenMatches(token, bearerToken(request.headers.authorization))) {
        sendJson(response, 401, { error: 'token required: authorization: Bearer <token>' });
        return;
      }

      let payload: { requests?: unknown };
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8')) as { requests?: unknown };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        sendJson(response, 400, { error: `batch not parsed: ${reason}` });
        return;
      }

      const items = Array.isArray(payload.requests) ? payload.requests : [];
      let accepted = 0;
      for (const item of items) {
        if (!isIngestible(item)) continue;
        store.send(item);
        accepted++;
      }
      if (accepted < items.length) {
        warnOnce(
          'server.ingest',
          `malformed records dropped from the batch: ${items.length - accepted}`,
        );
      }
      sendJson(response, 200, { accepted });
      return;
    }

    if (url.pathname === '/auth' && token) {
      if (!tokenMatches(token, url.searchParams.get('token') ?? undefined)) {
        sendJson(response, 403, { error: 'invalid token' });
        return;
      }
      const session = issueSession();
      sessions.add(session);
      response.writeHead(302, {
        'set-cookie': `${COOKIE_NAME}=${session}; HttpOnly; Path=/; SameSite=Strict`,
        location: '/_loupe/',
      });
      response.end();
      return;
    }

    if (panel?.(request, response)) return;

    if (url.pathname === '/') {
      response.writeHead(302, { location: '/_loupe/' });
      response.end();
      return;
    }

    sendJson(response, 404, { error: 'no such path. Panel: /_loupe/, ingest: POST /ingest' });
  }

  server.listen(options.port ?? 4300, host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    store,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
