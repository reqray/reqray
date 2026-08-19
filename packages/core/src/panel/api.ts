/**
 * Panel HTTP API.
 *
 * The handler is written against raw `IncomingMessage`/`ServerResponse`, so
 * Express and Fastify mount the very same code — no need to duplicate the API
 * in each adapter.
 */

import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type { ResolvedOptions } from '../config.js';
import { warnOnce } from '../logger.js';
import { isPanelRequestAllowed } from '../panel.js';
import type { RecordedRequest } from '../types.js';
import { blameLine } from './blame.js';
import { groupExceptions } from './exceptions.js';
import { ExplainError, runExplain } from './explain.js';
import { toCurlScript, toHar } from './export.js';
import { filterRequests, type RequestFilter, summarize } from './filters.js';
import { type ReplayInput, runReplay } from './replay.js';
import { normalizeRoute, routeStats } from './routes.js';

/** Where the panel gets its data. Implemented by the transport store. */
export interface PanelSource {
  /** Requests from newest to oldest. */
  list(): readonly RecordedRequest[];
  get(id: string): RecordedRequest | undefined;
  clear(): void;
  subscribe(listener: (request: RecordedRequest) => void): () => void;
  /**
   * Keeps a request past its turn in the ring buffer, or lets it go again.
   *
   * Optional: a store without pinning is still a valid source, and the panel
   * answers the pin route with an explanation instead of pretending.
   *
   * @returns `false` when the request is gone or the pin limit is reached.
   */
  pin?(id: string, pinned: boolean): boolean;
  /** Ids currently pinned. */
  pinned?(): readonly string[];
}

/** Everything the panel handler needs to serve a request. */
export interface PanelHandlerInit {
  readonly source: PanelSource;
  readonly options: ResolvedOptions;
  /**
   * Directory with the built dashboard.
   *
   * Left out when `@loupe/dashboard` is not installed: the API keeps working
   * and the UI route answers with an explanation instead of a blank page.
   */
  readonly assetsDir?: string | undefined;
}

/**
 * Panel request handler.
 *
 * @returns `true` if the request belonged to the panel and has been handled.
 * `false` means it is an ordinary application request and must be passed on.
 */
export type PanelHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

/** A list row — exactly what the request table shows. */
export interface RequestRow {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly query: string | null;
  /**
   * The path with its variable segments collapsed (`/api/orders/:id`).
   *
   * Normalized here rather than in the panel: the rule is tested on this side
   * and the browser bundle must not carry a second copy of it that can drift.
   */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly sqlCount: number;
  /** Outgoing HTTP calls — what "slow, and it called someone" is made of. */
  readonly httpCount: number;
  readonly nPlusOne: boolean;
  /** How many findings the detectors produced. */
  readonly findingCount: number;
  /**
   * The detector behind the costliest finding, for the flag in the list.
   *
   * A count alone cannot say what the flag should read: "SEQ" over a budget
   * breach is simply wrong.
   */
  readonly flag: string | null;
  readonly hasError: boolean;
  /** Held past its turn in the ring buffer, and exempt from filters. */
  readonly pinned: boolean;
  /** The test that issued the request, or `null` for ordinary traffic. */
  readonly test: string | null;
}

/**
 * Projects a record into a list row.
 *
 * The whole list is served on every panel open, and full records with spans
 * and bodies would weigh megabytes. Details come from a separate request by
 * identifier.
 */
export function toRow(request: RecordedRequest, pinned = false): RequestRow {
  let sqlCount = 0;
  let httpCount = 0;
  for (const span of request.spans) {
    if (span.kind === 'db') sqlCount++;
    else if (span.kind === 'http') httpCount++;
  }

  return {
    id: request.id,
    method: request.method,
    path: request.path,
    query: request.query,
    route: normalizeRoute(request.path),
    status: request.status,
    durationMs: request.durationMs,
    startedAt: request.startedAt,
    sqlCount,
    httpCount,
    nPlusOne: request.findings.some((finding) => finding.detector === 'n_plus_one'),
    findingCount: request.findings.length,
    flag: [...request.findings].sort((a, b) => b.costMs - a.costMs)[0]?.detector ?? null,
    hasError: request.error !== null || request.status >= 500,
    pinned,
    test: request.test,
  };
}

/** A file the browser saves rather than renders. */
function sendDownload(
  response: ServerResponse,
  filename: string,
  contentType: string,
  body: string,
): void {
  response.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function parseFilter(params: URLSearchParams): RequestFilter {
  const methods = params
    .getAll('method')
    .flatMap((value) => value.split(','))
    .filter(Boolean);
  const statusClasses = params
    .getAll('status')
    .flatMap((value) => value.split(','))
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));

  const minDuration = Number(params.get('minDurationMs'));

  return {
    query: params.get('q') ?? undefined,
    methods,
    statusClasses,
    minDurationMs: Number.isFinite(minDuration) && minDuration > 0 ? minDuration : undefined,
    onlyFindings: params.get('findings') === '1',
  };
}

/**
 * Reads the body of a panel request.
 *
 * An already-parsed body is taken first: the application almost certainly has
 * a json parser (`express.json()`) that consumed the stream before us —
 * reading the socket a second time is pointless, it is already empty.
 */
async function readBody(request: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined && parsed !== null) {
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * Serves the built dashboard.
 *
 * Anything that is not an existing file falls back to `index.html`: the panel
 * is a single-page app, and its inner screens are state, not server routes.
 */
function serveAsset(assetsDir: string, route: string, response: ServerResponse): boolean {
  const root = resolve(assetsDir);
  const requested = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  let target = resolve(root, requested);

  // A path escaping the assets directory can only come from a traversal attempt.
  if (target !== root && !target.startsWith(root + sep)) return false;

  let file = statSync(target, { throwIfNoEntry: false });
  if (!file?.isFile()) {
    target = resolve(root, 'index.html');
    file = statSync(target, { throwIfNoEntry: false });
    if (!file?.isFile()) return false;
  }

  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(target)] ?? 'application/octet-stream',
    'content-length': file.size,
    // Asset names are content-hashed by the build; index.html must not be cached.
    'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000',
  });
  createReadStream(target).pipe(response);
  return true;
}

/** The application's own address — replay needs it to call back into itself. */
function originOf(request: IncomingMessage): string {
  const host = request.headers.host ?? `127.0.0.1:${request.socket.localPort ?? 80}`;
  // TLS never reaches this far: the panel is mounted inside the application,
  // and replay always goes to its own local address.
  return `http://${host}`;
}

function streamEvents(
  source: PanelSource,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disables nginx buffering: without it the feed stalls.
    'x-accel-buffering': 'no',
  });
  response.write(': loupe stream\n\n');

  const unsubscribe = source.subscribe((recorded) => {
    response.write(`data: ${JSON.stringify(toRow(recorded))}\n\n`);
  });

  const keepAlive = setInterval(() => response.write(': ping\n\n'), 20_000);
  keepAlive.unref?.();

  const stop = (): void => {
    clearInterval(keepAlive);
    unsubscribe();
  };
  request.on('close', stop);
  response.on('close', stop);
}

/**
 * Creates the panel handler.
 *
 * Returns `null` if the panel is disabled by options: the adapter then has
 * nothing to mount.
 */
export function createPanelHandler(init: PanelHandlerInit): PanelHandler | null {
  const { source, options } = init;
  const panel = options.panel;
  if (!panel || !options.enabled) return null;

  const mount = panel.path.endsWith('/') ? panel.path.slice(0, -1) : panel.path;

  return function handlePanelRequest(request, response): boolean {
    // Express strips the matched mount prefix from `url` inside `app.use`;
    // `originalUrl` keeps the full path. Anything non-Express has no such
    // property and falls back to the plain url.
    const rawUrl = (request as { originalUrl?: string }).originalUrl ?? request.url ?? '/';
    if (rawUrl !== mount && !rawUrl.startsWith(`${mount}/`) && !rawUrl.startsWith(`${mount}?`)) {
      return false;
    }

    const url = new URL(rawUrl, 'http://loupe.local');
    const route = url.pathname.slice(mount.length) || '/';

    if (
      !isPanelRequestAllowed(panel.gate, {
        headers: request.headers,
        ip: request.socket.remoteAddress ?? null,
      })
    ) {
      sendJson(response, 403, { error: 'panel access denied by the gate' });
      return true;
    }

    const method = request.method ?? 'GET';

    if (route === '/api/meta' && method === 'GET') {
      sendJson(response, 200, {
        pid: process.pid,
        startedAt: Date.now() - Math.round(process.uptime() * 1000),
        mode: options.mode,
        bufferSize: options.bufferSize,
        replayEnabled: options.replay,
        blameEnabled: options.blame,
      });
      return true;
    }

    if (route === '/api/requests' && method === 'GET') {
      const all = source.list();
      const shown = filterRequests(all, parseFilter(url.searchParams));
      // Which rows are pinned travels with the rows; the exemption from
      // filters and the time window is applied where those live — in the
      // panel, which filters client-side so the live feed and the list agree.
      const pinned = new Set(source.pinned?.() ?? []);
      sendJson(response, 200, {
        requests: shown.map((record) => toRow(record, pinned.has(record.id))),
        summary: summarize(all, shown, options.sampling.slowMs || 500),
      });
      return true;
    }

    if (route === '/api/export/har' && method === 'GET') {
      const shown = filterRequests(source.list(), parseFilter(url.searchParams));
      sendDownload(
        response,
        'loupe.har',
        'application/json; charset=utf-8',
        JSON.stringify(toHar(shown, new Date()), null, 2),
      );
      return true;
    }

    if (route === '/api/export/curl' && method === 'GET') {
      const shown = filterRequests(source.list(), parseFilter(url.searchParams));
      sendDownload(
        response,
        'loupe-requests.sh',
        'text/x-shellscript; charset=utf-8',
        toCurlScript(shown, originOf(request)),
      );
      return true;
    }

    if (route === '/api/blame' && method === 'POST') {
      if (!options.blame) {
        sendJson(response, 403, {
          error:
            'git blame from the panel is off. Outside local development it is enabled explicitly: loupe({ blame: true }).',
        });
        return true;
      }
      handleBlame(options, request, response);
      return true;
    }

    if (route === '/api/routes' && method === 'GET') {
      sendJson(response, 200, routeStats(source.list()));
      return true;
    }

    if (route === '/api/pin' && method === 'POST') {
      handlePin(source, request, response);
      return true;
    }

    if (route === '/api/requests' && method === 'DELETE') {
      source.clear();
      sendJson(response, 200, { cleared: true });
      return true;
    }

    if (route.startsWith('/api/requests/') && method === 'GET') {
      const id = decodeURIComponent(route.slice('/api/requests/'.length));
      const found = source.get(id);
      if (!found) {
        sendJson(response, 404, {
          error: 'request not found — possibly evicted from the ring buffer',
        });
        return true;
      }
      // The row fields travel with the record: the panel's detail type
      // extends its row type, and a payload missing half of it is a contract
      // that silently reads `undefined`.
      sendJson(response, 200, {
        ...toRow(found, (source.pinned?.() ?? []).includes(id)),
        ...found,
      });
      return true;
    }

    if (route === '/api/exceptions' && method === 'GET') {
      sendJson(response, 200, { groups: groupExceptions(source.list(), options.stack) });
      return true;
    }

    if (route === '/api/stream' && method === 'GET') {
      streamEvents(source, request, response);
      return true;
    }

    if (route === '/api/explain' && method === 'POST') {
      if (!options.explain) {
        sendJson(response, 403, {
          error:
            'EXPLAIN from the panel is off. Outside local development it is enabled explicitly: loupe({ explain: true }).',
        });
        return true;
      }
      handleExplain(source, request, response);
      return true;
    }

    if (route === '/api/replay' && method === 'POST') {
      if (!options.replay) {
        sendJson(response, 403, {
          error:
            'replay is off. Outside local development it is enabled only explicitly: loupe({ replay: true }) — a replay in production means a second charge and a second email.',
        });
        return true;
      }
      handleReplay(source, request, response);
      return true;
    }

    if (route.startsWith('/api/')) {
      sendJson(response, 404, { error: 'no such panel endpoint' });
      return true;
    }

    if (method === 'GET' && init.assetsDir && serveAsset(init.assetsDir, route, response)) {
      return true;
    }

    sendJson(response, 404, {
      error: init.assetsDir
        ? 'panel asset not found'
        : 'the panel UI is not installed: add @loupe/dashboard. The API keeps working.',
    });
    return true;
  };
}

function handleBlame(
  options: ResolvedOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  void (async () => {
    try {
      const payload = (await readBody(request)) as {
        frames?: Array<{ file?: unknown; line?: unknown }>;
      };
      const frames = Array.isArray(payload.frames) ? payload.frames.slice(0, 30) : [];

      const blamed = await Promise.all(
        frames.map(async (frame) => {
          if (typeof frame.file !== 'string' || typeof frame.line !== 'number') return null;
          return blameLine(frame.file, frame.line, options.stack.projectRoot);
        }),
      );
      sendJson(response, 200, { frames: blamed });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: `blame failed: ${reason}` });
    }
  })();
}

function handlePin(source: PanelSource, request: IncomingMessage, response: ServerResponse): void {
  void (async () => {
    if (!source.pin) {
      sendJson(response, 501, { error: 'this store cannot pin requests' });
      return;
    }
    try {
      const payload = (await readBody(request)) as { id?: unknown; pinned?: unknown };
      if (typeof payload.id !== 'string') {
        sendJson(response, 400, { error: 'id is required' });
        return;
      }
      const wanted = payload.pinned !== false;
      const ok = source.pin(payload.id, wanted);
      if (!ok && wanted) {
        // Either the record is already gone, or the pin board is full — both
        // are worth saying out loud rather than silently doing nothing.
        sendJson(response, 409, {
          error: 'could not pin: the request is gone, or too many are pinned already',
        });
        return;
      }
      sendJson(response, 200, { id: payload.id, pinned: wanted && ok });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: `pin failed: ${reason}` });
    }
  })();
}

function handleExplain(
  source: PanelSource,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  void (async () => {
    try {
      const payload = (await readBody(request)) as { id?: unknown; spanId?: unknown };
      const record = typeof payload.id === 'string' ? source.get(payload.id) : undefined;
      if (!record) {
        sendJson(response, 404, {
          error: 'request not found — possibly evicted from the ring buffer',
        });
        return;
      }
      const spanId = typeof payload.spanId === 'number' ? payload.spanId : Number.NaN;

      sendJson(response, 200, await runExplain(record, spanId));
    } catch (error) {
      if (error instanceof ExplainError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce('panel.explain', `EXPLAIN failed: ${reason}`);
      sendJson(response, 500, { error: `EXPLAIN failed: ${reason}` });
    }
  })();
}

function handleReplay(
  source: PanelSource,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  void (async () => {
    try {
      const payload = (await readBody(request)) as {
        id?: unknown;
        method?: unknown;
        path?: unknown;
        headers?: unknown;
        body?: unknown;
      };

      const original = typeof payload.id === 'string' ? source.get(payload.id) : undefined;
      if (!original) {
        sendJson(response, 404, { error: 'original request not found' });
        return;
      }

      const input: ReplayInput = {
        method: typeof payload.method === 'string' ? payload.method : original.method,
        path: typeof payload.path === 'string' ? payload.path : original.path,
        headers:
          payload.headers && typeof payload.headers === 'object'
            ? (payload.headers as Record<string, string>)
            : {},
        body: typeof payload.body === 'string' ? payload.body : undefined,
      };

      sendJson(response, 200, await runReplay(originOf(request), input, original));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce('panel.replay', `replay failed: ${reason}`);
      sendJson(response, 500, { error: `replay failed: ${reason}` });
    }
  })();
}
