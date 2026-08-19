/**
 * `@loupe/express` — Express adapter.
 *
 * Wraps the handling of each request in a `RequestScope` so driver
 * instrumentations have somewhere to put their spans, and hands the request to
 * the transport once the response is done.
 *
 * Application behaviour is not changed in any way: `res.json`/`res.send` are
 * wrapped transparently, errors propagate exactly as before.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  createLoupe,
  createPanelHandler,
  type Loupe,
  type LoupeInit,
  markAdapterActive,
  type PanelSource,
  REPLAY_HEADER,
  reportInstrumentation,
  runInScope,
  warnOnce,
} from '@loupe/core';
import { memoryTransport } from '@loupe/transport-memory';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

/** Express version, when it can be resolved from the application. */
function expressVersion(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url)('express/package.json') as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Directory with the built dashboard.
 *
 * Resolved optionally: without `@loupe/dashboard` installed the API still
 * works, only the UI route reports that the panel is incomplete.
 */
function dashboardAssets(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve('@loupe/dashboard/package.json');
    return join(dirname(manifest), 'dist');
  } catch {
    return undefined;
  }
}

/** Handlers that have to be installed into the application. */
export interface LoupeExpress {
  /** Runtime: transport, options. Needed by the panel and by tests. */
  readonly runtime: Loupe;
  /** Installed **before** the routes. */
  readonly middleware: RequestHandler;
  /**
   * Installed **after** the routes.
   *
   * Optional: without it requests are still recorded with their status. It is
   * what puts the exception object itself into the record — Express hands the
   * exception only to an error-handling middleware, so it cannot be captured
   * any earlier.
   */
  readonly errorHandler: ErrorRequestHandler;
}

/**
 * The panel can only work with a transport that is also a store.
 * An HTTP transport to an external collector has no request list — the panel
 * then runs as a separate process, which is v0.2.
 */
function asPanelSource(transport: unknown): PanelSource | null {
  const candidate = transport as Partial<PanelSource> | null;
  if (!candidate) return null;
  const complete =
    typeof candidate.list === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.clear === 'function' &&
    typeof candidate.subscribe === 'function';
  return complete ? (candidate as PanelSource) : null;
}

function headerValue(raw: string | string[] | undefined): string | null {
  if (typeof raw === 'string') return raw;
  return Array.isArray(raw) ? (raw[0] ?? null) : null;
}

function splitQuery(url: string): [path: string, query: string | null] {
  const index = url.indexOf('?');
  return index === -1 ? [url, null] : [url.slice(0, index), url.slice(index + 1)];
}

/** Key the exception travels under from the error handler to finalization. */
const FAILURE = Symbol.for('loupe.express.failure');

interface WithFailure {
  [FAILURE]?: unknown;
}

/**
 * Creates the Loupe handlers for Express.
 *
 * @example
 * ```ts
 * const inspector = loupe();
 * app.use(inspector.middleware);
 * // ...routes...
 * app.use(inspector.errorHandler);
 * ```
 */
export function loupe(init: LoupeInit = {}): LoupeExpress {
  // The standalone mode in @loupe/register stands down once an adapter exists.
  markAdapterActive();
  reportInstrumentation({
    name: 'express',
    version: expressVersion(),
    captures: 'requests',
    ok: true,
  });

  const runtime = createLoupe({ ...init, transport: init.transport ?? memoryTransport() });
  const source = asPanelSource(runtime.transport);
  const panel = source
    ? createPanelHandler({ source, options: runtime.options, assetsDir: dashboardAssets() })
    : null;

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    // The panel handler goes first: it answers by itself, so its own requests
    // never show up in the list it displays.
    if (panel?.(req, res)) return;

    const [path, query] = splitQuery(req.originalUrl || req.url);
    const scope = runtime.begin({
      method: req.method,
      path,
      replayId: headerValue(req.headers[REPLAY_HEADER]),
    });
    // Loupe is disabled — do exactly nothing.
    if (!scope) {
      next();
      return;
    }

    let responseBody: unknown;
    const originalJson = res.json;
    const originalSend = res.send;

    res.json = function loupeJson(this: Response, body?: unknown) {
      responseBody = body;
      return originalJson.call(this, body);
    } as Response['json'];

    res.send = function loupeSend(this: Response, body?: unknown) {
      if (responseBody === undefined) responseBody = body;
      return originalSend.call(this, body);
    } as Response['send'];

    // One span for the whole handling: SQL, cache and outgoing HTTP nest into
    // it and get the right depth in the waterfall. Separate spans per
    // middleware would require patching the Express router — that is v0.2.
    const handlerSpan = scope.openSpan('handler', `${req.method} ${path}`);

    let finished = false;
    const complete = (): void => {
      if (finished) return;
      finished = true;
      try {
        scope.closeSpan(handlerSpan);
        runtime.finish(scope, {
          status: res.statusCode,
          query,
          requestHeaders: req.headers,
          responseHeaders: res.getHeaders(),
          requestBody: (req as Request & { body?: unknown }).body,
          responseBody,
          error: (res as Response & WithFailure)[FAILURE],
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce('express.finish', `request not recorded: ${reason}`);
      }
    };

    // Both events: `close` catches requests aborted by the client, for which
    // `finish` never fires.
    res.on('finish', complete);
    res.on('close', complete);

    runInScope(scope, () => {
      next();
    });
  };

  const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    (res as Response & WithFailure)[FAILURE] = error;
    // The error is neither replaced nor swallowed — it is passed on as it was.
    next(error);
  };

  return { runtime, middleware, errorHandler };
}

/**
 * Stamps the exception onto the response the way {@link LoupeExpress.errorHandler}
 * does.
 *
 * For frameworks on top of Express (NestJS) that intercept exceptions
 * themselves, so an Express error handler never sees them. Safe to call with
 * anything — a foreign object is simply left alone.
 */
export function recordFailure(response: unknown, error: unknown): void {
  if (response !== null && typeof response === 'object') {
    (response as WithFailure)[FAILURE] = error;
  }
}
