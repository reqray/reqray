/**
 * Standalone mode: the panel with zero lines of code.
 *
 * `node --import @loupe/register app.js` is enough — incoming HTTP is
 * observed through Node's own `diagnostics_channel` (no patching), and the
 * panel comes up on a side port on loopback, away from the application's own
 * routing.
 *
 * The mode knows its place:
 * - any framework adapter wins — the first request after an adapter has
 *   initialized permanently disables standalone (an adapter records the same
 *   requests with full fidelity);
 * - local development only: elsewhere the panel needs a gate, which requires
 *   the adapter's options anyway;
 * - request and response bodies are not captured — reading somebody else's
 *   stream is not allowed — and Replay is off;
 * - the route is the raw URL path: without a framework there is nothing to
 *   normalize it against.
 */

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import {
  createLoupe,
  createPanelHandler,
  enterScope,
  isAdapterActive,
  type Loupe,
  warnOnce,
} from '@loupe/core';
import { type MemoryStore, memoryTransport } from '@loupe/transport-memory';

const CHANNEL = 'http.server.request.start';

/** Options for {@link enableStandalone}. Mostly for tests. */
export interface StandaloneOptions {
  /** Panel port; `0` picks a free one. Default: `LOUPE_PANEL_PORT` or 4310. */
  readonly panelPort?: number;
}

interface StandaloneState {
  subscribed: boolean;
  runtime: Loupe | null;
  store: MemoryStore | null;
  panel: Server | null;
  panelPort: number | null;
  panelUrl: string | null;
  wantedPort: number;
}

const state: StandaloneState = {
  subscribed: false,
  runtime: null,
  store: null,
  panel: null,
  panelPort: null,
  panelUrl: null,
  wantedPort: 4310,
};

function dashboardAssets(): string | undefined {
  try {
    const manifest = createRequire(import.meta.url).resolve('@loupe/dashboard/package.json');
    return join(dirname(manifest), 'dist');
  } catch {
    return undefined;
  }
}

function splitQuery(url: string): [path: string, query: string | null] {
  const index = url.indexOf('?');
  return index === -1 ? [url, null] : [url.slice(0, index), url.slice(index + 1)];
}

/** Permanently stands down: after this the channel costs nothing per request. */
function disable(): void {
  if (state.subscribed) {
    unsubscribe(CHANNEL, onRequestStart);
    state.subscribed = false;
  }
}

/**
 * The runtime, created on the first captured request.
 *
 * `null` means standalone must not run here at all — and `disable()` has
 * already been called.
 */
function ensureRuntime(): Loupe | null {
  if (state.runtime) return state.runtime;

  const store = memoryTransport();
  const runtime = createLoupe({
    // Replay needs the application's own origin, which standalone does not
    // reliably know. Off, and said so in the startup line.
    replay: false,
    transport: store,
  });

  // Standalone is a local-development tool: anywhere else the panel needs a
  // gate, and a gate is configured through an adapter anyway.
  if (!runtime.options.enabled || !runtime.options.isLocalDevelopment) {
    disable();
    return null;
  }

  state.runtime = runtime;
  state.store = store;
  return runtime;
}

function startPanel(runtime: Loupe): void {
  if (state.panel || !state.store) return;

  const handler = createPanelHandler({
    source: state.store,
    options: runtime.options,
    assetsDir: dashboardAssets(),
  });
  if (!handler) return;

  const server = createServer((request, response) => {
    if (handler(request, response)) return;
    if (request.url === '/' || request.url === '') {
      response.writeHead(302, { location: '/_loupe/' });
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{"error":"this is the loupe panel: /_loupe/"}');
  });
  state.panel = server;

  let retried = false;
  server.on('error', (error: NodeJS.ErrnoException) => {
    // The chosen port is busy — most likely a second application with its
    // own standalone panel. A random port is better than no panel.
    if (error.code === 'EADDRINUSE' && !retried) {
      retried = true;
      server.listen(0, '127.0.0.1');
      return;
    }
    warnOnce('standalone.panel', `panel did not start: ${error.message}`);
    state.panel = null;
  });

  server.listen(state.wantedPort, '127.0.0.1', () => {
    const address = server.address() as AddressInfo;
    state.panelPort = address.port;
    state.panelUrl = `http://127.0.0.1:${address.port}/_loupe/`;
    console.log(
      `loupe: no adapter found — panel is up at ${state.panelUrl}\n` +
        '       standalone mode: no request bodies, no Replay, paths without route normalization.\n' +
        '       Full recording comes with an adapter: @loupe/fastify, @loupe/express, @loupe/nestjs.',
    );
  });
  // The side server must never keep the application process alive.
  server.unref();
}

function onRequestStart(message: unknown): void {
  try {
    // An adapter records the same requests with full fidelity — from here on
    // the channel must cost nothing.
    if (isAdapterActive()) {
      disable();
      return;
    }

    const { request, response } = message as {
      request: IncomingMessage;
      response: ServerResponse;
    };
    // The panel's own traffic must not appear in the list it displays.
    if (state.panelPort !== null && request.socket?.localPort === state.panelPort) return;

    const runtime = ensureRuntime();
    if (!runtime) return;

    const [path, query] = splitQuery(request.url ?? '/');
    const scope = runtime.begin({ method: request.method ?? 'GET', path });
    if (!scope) return;

    startPanel(runtime);

    // The publish happens synchronously right before the 'request' event, so
    // the scope entered here is visible to the application's handler.
    enterScope(scope);
    const handlerSpan = scope.openSpan('handler', `${request.method} ${path}`);

    let finished = false;
    const complete = (): void => {
      if (finished) return;
      finished = true;
      try {
        scope.closeSpan(handlerSpan);
        runtime.finish(scope, {
          status: response.statusCode,
          query,
          requestHeaders: request.headers,
          responseHeaders: response.getHeaders(),
          // Bodies are deliberately absent: consuming somebody else's stream
          // is not an option, and observing it passively changes its mode.
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce('standalone.finish', `request not recorded: ${reason}`);
      }
    };
    response.once('finish', complete);
    response.once('close', complete);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce('standalone.request', `standalone recording disabled after an error: ${reason}`);
    disable();
  }
}

/**
 * Enables the standalone mode.
 *
 * Called automatically when `@loupe/register` is imported. Does nothing until
 * the first incoming request, so an application with an adapter never even
 * notices it. `LOUPE_STANDALONE=off` switches it off entirely.
 */
export function enableStandalone(options: StandaloneOptions = {}): void {
  if (state.subscribed) return;
  if (process.env['LOUPE_STANDALONE'] === 'off') return;

  const envPort = Number(process.env['LOUPE_PANEL_PORT']);
  state.wantedPort = options.panelPort ?? (Number.isInteger(envPort) ? envPort : 4310);

  subscribe(CHANNEL, onRequestStart);
  state.subscribed = true;
}

/** Address of the standalone panel, once it is up. Needed by tests. */
export function standalonePanelUrl(): string | null {
  return state.panelUrl;
}

/** Shuts standalone down and forgets its state. Needed by tests. */
export function resetStandalone(): void {
  disable();
  state.panel?.close();
  state.panel = null;
  state.panelPort = null;
  state.panelUrl = null;
  state.runtime = null;
  state.store = null;
}
