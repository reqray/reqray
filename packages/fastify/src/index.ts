/**
 * `@reqray/fastify` — Fastify adapter.
 *
 * Built on the regular hooks: that is the official extension point with a
 * stable contract, so nothing has to be patched. The start and the end of a
 * request are different hooks, so the context is entered via `enterScope`
 * instead of by wrapping a function.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  createReqray,
  enterScope,
  markAdapterActive,
  REPLAY_HEADER,
  type Reqray,
  type ReqrayInit,
  type RequestScope,
  reportInstrumentation,
  warnOnce,
} from '@reqray/core';
import { createPanelHandler, panelSourceFor } from '@reqray/core/panel';
import { memoryTransport } from '@reqray/store-memory';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    /** Reqray runtime: transport and options. */
    readonly reqray: Reqray;
  }
}

/** State that lives from `onRequest` through to `onResponse`. */
interface RequestState {
  readonly scope: RequestScope;
  /** Kept because `onRequestAbort` is handed the request alone. */
  readonly reply: FastifyReply;
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
 * Resolved optionally: without `@reqray/dashboard` installed the API still
 * works, only the UI route reports that the panel is incomplete.
 */
function dashboardAssets(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve('@reqray/dashboard/package.json');
    return join(dirname(manifest), 'dist');
  } catch {
    return undefined;
  }
}

function headerValue(raw: string | string[] | undefined): string | null {
  if (typeof raw === 'string') return raw;
  return Array.isArray(raw) ? (raw[0] ?? null) : null;
}

function splitQuery(url: string): [path: string, query: string | null] {
  const index = url.indexOf('?');
  return index === -1 ? [url, null] : [url.slice(0, index), url.slice(index + 1)];
}

const plugin: FastifyPluginCallback<ReqrayInit> = (app: FastifyInstance, init, done) => {
  // The standalone mode in @reqray/register stands down once an adapter exists.
  markAdapterActive();
  reportInstrumentation({
    name: 'fastify',
    version: app.version,
    captures: 'requests',
    ok: true,
  });

  const runtime = createReqray({ ...init, transport: init.transport ?? memoryTransport() });
  app.decorate('reqray', runtime);

  // A disabled Reqray costs nothing per request, and the only way to mean that
  // literally is to register no hooks at all. Checking `enabled` inside a hook
  // would still allocate the argument object it is checked from.
  if (!runtime.options.enabled) {
    done();
    return;
  }

  const source = panelSourceFor(runtime.transport, runtime.options);
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

  app.addHook('onRequest', (request, reply, next) => {
    const [path, query] = splitQuery(request.url);
    const scope = runtime.begin({
      method: request.method,
      path,
      replayId: headerValue(request.headers[REPLAY_HEADER]),
    });
    // Reqray is disabled — no allocations, no state kept.
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
      reply,
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

  // Called from whichever hook ends the request, and once: the state is
  // taken out of the map on the way in.
  const complete = (request: FastifyRequest): void => {
    const state = states.get(request);
    if (!state) return;
    states.delete(request);
    const reply = state.reply;

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
  };

  app.addHook('onResponse', (request: FastifyRequest, _reply: FastifyReply, next) => {
    complete(request);
    next();
  });

  // A client that gave up gets no response, so `onResponse` never fires — and
  // the request it gave up on is the slow one, the one worth seeing.
  app.addHook('onRequestAbort', (request: FastifyRequest, next) => {
    complete(request);
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
 * Reqray plugin for Fastify.
 *
 * @example
 * ```ts
 * await app.register(reqray);
 * // app.reqray — the runtime: transport, options
 * ```
 */
export const reqray = fp(plugin, {
  fastify: '5.x',
  name: '@reqray/fastify',
});

export default reqray;
