/**
 * `@reqray/server` — the collector.
 *
 * A separate process: applications ship batches over HTTP (see
 * `@reqray/transport-http`), the collector stores them and serves the same
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
  isLocalRequest,
  type PanelGate,
  type RecordedRequest,
  resolveOptions,
  retentionPolicy,
  type Transport,
  warnOnce,
} from '@reqray/core';
import { createPanelHandler, type PanelSource } from '@reqray/core/panel';
import { memoryTransport } from '@reqray/store-memory';
import { sqliteTransport } from '@reqray/store-sqlite';
import { fileTransport } from '@reqray/transport-file';

/** Options for {@link createReqrayServer}. */
export interface ReqrayServerOptions {
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
  /**
   * Path to a SQLite file. Given one, the collector keeps a history that
   * outlives it; without one, requests live in memory and die with the
   * process.
   */
  readonly db?: string;
  /** With `db`: how much disk the stored requests may take, bytes. */
  readonly maxBytes?: number;
  /**
   * Directory for the request log: one line of JSON per request, a file per
   * day. Without it the collector keeps requests only in its store.
   */
  readonly logDir?: string;
  /**
   * How many days anything is kept for — the store and the log alike.
   *
   * Changeable from the panel, and remembered next to the database so the
   * change survives a restart.
   */
  readonly retentionDays?: number;
}

/**
 * What the collector needs from a store, whichever one it is.
 *
 * Structural rather than a named union: the memory ring and the SQLite
 * history have nothing in common but this, and the collector uses nothing
 * else.
 */
export type CollectorStore = PanelSource &
  Transport & {
    stats(): { size: number };
    close?(): Promise<void>;
  };

/** A running collector. */
export interface ReqrayServer {
  /** Address the server actually listens on. */
  readonly url: string;
  /** The store — exposed for tests and embedding. */
  readonly store: CollectorStore;
  close(): Promise<void>;
}

const COOKIE_NAME = 'reqray_token';
const MAX_INGEST_BYTES = 32 * 1024 * 1024;
/**
 * How many batches may be on their way in at once.
 *
 * Each is held whole in memory until it is parsed, so this is the collector's
 * memory bound — eight of the largest is 256 MB. Past it the answer is 429
 * with `Retry-After`, which the transport honours: a collector that can only
 * fall over takes the agents' queues down with it.
 */
const MAX_CONCURRENT_INGESTS = 8;

/** Directory with the built dashboard, when it is installed. */
function dashboardAssets(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve('@reqray/dashboard/package.json');
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
export async function createReqrayServer(options: ReqrayServerOptions = {}): Promise<ReqrayServer> {
  const token = options.token;
  const host = options.host ?? '127.0.0.1';

  if (!token && host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `reqray-server: listening on ${host} without a token is not allowed — the panel exposes request bodies and SQL. ` +
        'Set a token or keep 127.0.0.1.',
    );
  }

  // One policy for the store and the log, remembered beside whichever of them
  // is on disk: a collector restarted by an orchestrator must come back with
  // the setting somebody chose, not the one that was compiled in.
  const remembered = options.db
    ? `${options.db}.retention.json`
    : options.logDir
      ? join(options.logDir, 'retention.json')
      : undefined;
  const retention =
    options.retentionDays || remembered
      ? retentionPolicy({
          ...(options.retentionDays ? { days: options.retentionDays } : {}),
          ...(options.bufferSize ? { maxRequests: options.bufferSize } : {}),
          ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
          ...(remembered ? { file: remembered } : {}),
        })
      : null;

  // A file means a history; no file means the ring, which is what a
  // throwaway staging stand wants and what the collector has always been.
  const store: CollectorStore = options.db
    ? sqliteTransport({
        file: options.db,
        ...(options.bufferSize ? { maxRequests: options.bufferSize } : {}),
        ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
        ...(retention ? { retention } : {}),
      })
    : memoryTransport({ capacity: options.bufferSize ?? 2_000 });

  // The log is beside the store, not instead of it: one is what the panel
  // reads, the other is what a log shipper picks up and an operator keeps.
  const log = options.logDir
    ? fileTransport({ dir: options.logDir, ...(retention ? { retention } : {}) })
    : null;
  const sessions = new Set<string>();
  /** Batches being read right now. */
  let ingesting = 0;

  // The panel is authorized either by the cookie session issued at /auth or
  // by the raw token in a header — the latter for curl and healthchecks.
  //
  // Without a token there is no gate at all, and core then lets in only what
  // comes from this machine addressed to this machine — `'open'` here used to
  // let a hostile page re-pointed at 127.0.0.1 read every recorded body.
  const gate: PanelGate | undefined = token
    ? (context) => {
        const cookie = cookieValue(
          typeof context.headers.cookie === 'string' ? context.headers.cookie : undefined,
          COOKIE_NAME,
        );
        if (cookie && sessions.has(cookie)) return true;
        const header = context.headers['x-reqray-token'];
        return typeof header === 'string' && tokenMatches(token, header);
      }
    : undefined;

  const panel = createPanelHandler({
    source: store,
    // The collector itself is not the application: nothing is sampled here
    // and replay is impossible — the process the request lived in is remote.
    options: resolveOptions({
      enabled: true,
      mode: 'production',
      replay: false,
      panel: gate ? { gate } : {},
      ...(retention ? { retention } : {}),
      ...(log ? { requestLog: log } : {}),
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
    const url = new URL(request.url ?? '/', 'http://reqray.local');

    if (url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true, size: store.stats().size });
      return;
    }

    // No token: the whole collector is for this machine only, the same rule
    // the panel follows without a gate.
    if (
      !token &&
      !isLocalRequest({ headers: request.headers, ip: request.socket.remoteAddress ?? null })
    ) {
      sendJson(response, 403, {
        error: 'without a token the collector answers only to this machine, at a local address',
      });
      return;
    }

    if (url.pathname === '/ingest' && request.method === 'POST') {
      if (token && !tokenMatches(token, bearerToken(request.headers.authorization))) {
        sendJson(response, 401, { error: 'token required: authorization: Bearer <token>' });
        return;
      }
      // A page in a browser can POST text to a local port without asking;
      // it cannot send JSON without a preflight, which nothing here answers.
      if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
        sendJson(response, 415, { error: 'a batch is sent as application/json' });
        return;
      }

      if (ingesting >= MAX_CONCURRENT_INGESTS) {
        // The body is not read, so the connection cannot be reused.
        response.writeHead(429, { 'retry-after': '1', connection: 'close' });
        response.end();
        return;
      }

      let payload: { requests?: unknown };
      ingesting++;
      try {
        payload = JSON.parse((await readBody(request)).toString('utf8')) as { requests?: unknown };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        sendJson(response, 400, { error: `batch not parsed: ${reason}` });
        return;
      } finally {
        ingesting--;
      }

      const items = Array.isArray(payload.requests) ? payload.requests : [];
      let accepted = 0;
      for (const item of items) {
        if (!isIngestible(item)) continue;
        store.send(item);
        log?.send(item);
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
        location: '/_reqray/',
      });
      response.end();
      return;
    }

    if (panel?.(request, response)) return;

    if (url.pathname === '/') {
      response.writeHead(302, { location: '/_reqray/' });
      response.end();
      return;
    }

    sendJson(response, 404, { error: 'no such path. Panel: /_reqray/, ingest: POST /ingest' });
  }

  server.listen(options.port ?? 4300, host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    store,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      // A history holds a file open; the ring has nothing to release.
      await store.close?.();
    },
  };
}
