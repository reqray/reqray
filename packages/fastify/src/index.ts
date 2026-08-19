/**
 * `@loupe/fastify` — Fastify adapter.
 *
 * Built on the regular hooks: that is the official extension point with a
 * stable contract, so nothing has to be patched. The start and the end of a
 * request are different hooks, so the context is entered via `enterScope`
 * instead of by wrapping a function.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  createLoupe,
  createPanelHandler,
  enterScope,
  type Loupe,
  type LoupeInit,
  markAdapterActive,
  type PanelSource,
  REPLAY_HEADER,
  type RequestScope,
  reportInstrumentation,
  warnOnce,
} from '@loupe/core';
import { memoryTransport } from '@loupe/transport-memory';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    /** Loupe runtime: transport and options. */
    readonly loupe: Loupe;
  }
}

/** State that lives from `onRequest` through to `onResponse`. */
interface RequestState {
  readonly scope: RequestScope;
  readonly handlerSpan: number;
  readonly query: string | null;
  responseBody: unknown;
  failure: unknown;
}

// A WeakMap rather than decorating the request: the shape of somebody else's
// object stays untouched and nothing is left behind.
const states = new WeakMap<FastifyRequest, RequestState>();

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

const plugin: FastifyPluginCallback<LoupeInit> = (app: FastifyInstance, init, done) => {
  // The standalone mode in @loupe/register stands down once an adapter exists.
  markAdapterActive();
  reportInstrumentation({
    name: 'fastify',
    version: app.version,
    captures: 'requests',
    ok: true,
  });

  const runtime = createLoupe({ ...init, transport: init.transport ?? memoryTransport() });
  app.decorate('loupe', runtime);

  const source = asPanelSource(runtime.transport);
  const panel = source
    ? createPanelHandler({ source, options: runtime.options, assetsDir: dashboardAssets() })
    : null;

  if (panel) {
    // The panel hook is registered first: its own requests must not end up in
    // the list it displays.
    app.addHook('onRequest', (request, reply, next) => {
      if (panel(request.raw, reply.raw)) {
        // The response is already written straight to the socket — Fastify has
        // nothing left to do here.
        reply.hijack();
        return;
      }
      next();
    });
  }

  app.addHook('onRequest', (request, _reply, next) => {
    const [path, query] = splitQuery(request.url);
    const scope = runtime.begin({
      method: request.method,
      path,
      replayId: headerValue(request.headers[REPLAY_HEADER]),
    });
    // Loupe is disabled — no allocations, no state kept.
    if (!scope) {
      next();
      return;
    }

    // `enterWith` inside the hook: the rest of the handling is a child of this
    // async resource, so the scope is visible to every later hook and to the
    // handler itself.
    enterScope(scope);

    states.set(request, {
      scope,
      handlerSpan: scope.openSpan('handler', `${request.method} ${path}`),
      query,
      responseBody: undefined,
      failure: undefined,
    });
    next();
  });

  app.addHook('onSend', (request, _reply, payload, next) => {
    const state = states.get(request);
    // The body is stored as-is; parsing and masking happen at finalization.
    if (state) state.responseBody = payload;
    next(null, payload);
  });

  app.addHook('onError', (request, _reply, error, next) => {
    const state = states.get(request);
    if (state) state.failure = error;
    // The error is left alone: Fastify handles it as usual.
    next();
  });

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, next) => {
    const state = states.get(request);
    if (!state) {
      next();
      return;
    }
    states.delete(request);

    try {
      state.scope.closeSpan(state.handlerSpan);
      runtime.finish(state.scope, {
        status: reply.statusCode,
        query: state.query,
        requestHeaders: request.headers,
        responseHeaders: reply.getHeaders(),
        requestBody: request.body,
        responseBody: state.responseBody,
        error: state.failure,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce('fastify.finish', `request not recorded: ${reason}`);
    }
    next();
  });

  done();
};

/**
 * Stamps the exception onto the request the way the `onError` hook does.
 *
 * For frameworks on top of Fastify (NestJS) that intercept exceptions before
 * Fastify's own error handling, so `onError` never fires. Safe to call with
 * anything — an unknown request is simply ignored.
 */
export function recordFailure(request: unknown, error: unknown): void {
  const state = states.get(request as FastifyRequest);
  if (state) state.failure = error;
}

/**
 * Loupe plugin for Fastify.
 *
 * @example
 * ```ts
 * await app.register(loupe);
 * // app.loupe — the runtime: transport, options
 * ```
 */
export const loupe = fp(plugin, {
  fastify: '5.x',
  name: '@loupe/fastify',
});

export default loupe;
