/**
 * The panel API, over HTTP.
 *
 * This client carries no instrumentation and imports no part of `@reqray/core`:
 * it talks to the same endpoints the web panel talks to, and the shapes it
 * receives come from `@reqray/protocol` as types only. A collector reached
 * through an ssh tunnel is an ordinary URL and needs nothing else.
 *
 * Built-in `fetch`, and a hand-rolled reader for the event stream. `undici` is
 * a dependency an `npx` user waits for, and the global `EventSource` cannot
 * set the header a token-protected collector requires.
 */

import type {
  ApiError,
  BaselineResponse,
  PanelMeta,
  RequestDetail,
  RequestSort,
  RequestsResponse,
} from '@reqray/protocol';
import { CliError, UnreachableError } from './errors.js';

/**
 * Parses what the panel sent, with every string made safe to print.
 *
 * A record is written by whoever sent the request: a path, a test name, an
 * exception message, a body. Printed as they came, an escape sequence in any
 * of them is an instruction to the reader's terminal — clear the screen,
 * retitle the window, rewrite a line already read. Stripped here, once, so no
 * renderer has to remember. Tabs and line breaks are layout, and stay.
 */
export function parsePrintable(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) =>
    typeof value === 'string' ? value.replace(/(?![\t\n])\p{Cc}/gu, '') : value,
  );
}

/** Where the panel is, and how to get past its gate. */
export interface ClientOptions {
  /** Base URL of the panel, e.g. `http://localhost:3000/_reqray`. */
  readonly url: string;
  /** Shared secret, for a collector that was started with one. */
  readonly token?: string | null;
  /** Swapped out in tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/** What to ask the list for. Mirrors the panel's own query parameters. */
export interface ListQuery {
  readonly limit?: number;
  /** Substring of the method, path, status or query string. */
  readonly query?: string;
  readonly cursor?: string | null;
  readonly minDurationMs?: number;
  readonly methods?: readonly string[];
  readonly statusClasses?: readonly number[];
  readonly onlyFindings?: boolean;
  readonly onlyErrors?: boolean;
  readonly sort?: RequestSort;
}

/** What a live stream reports back. */
export interface StreamHandlers {
  /** A request just finished. */
  onRow(row: unknown): void;
  /** Something the reader should know about the connection itself. */
  onNotice(text: string): void;
  /** Aborting it ends the stream and the retry loop with it. */
  readonly signal: AbortSignal;
  /** Swapped out in tests, so backoff costs no wall-clock time. */
  sleep?(ms: number): Promise<void>;
}

/** First delay after a dropped connection, ms. Doubles from here. */
const BACKOFF_START = 500;
/** The ceiling. A collector that is down stays polled once every ten seconds. */
const BACKOFF_MAX = 10_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** A client for one panel. */
export class ReqrayClient {
  readonly #url: string;
  readonly #token: string | null;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#token = options.token ?? null;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** The panel's address, as it was resolved. */
  get url(): string {
    return this.#url;
  }

  /** What the process behind the panel is. */
  async meta(signal?: AbortSignal): Promise<PanelMeta> {
    return this.#json<PanelMeta>('/api/meta', signal);
  }

  /** One page of the list. */
  async list(query: ListQuery = {}, signal?: AbortSignal): Promise<RequestsResponse> {
    return this.#json<RequestsResponse>(`/api/requests${searchOf(query)}`, signal);
  }

  /** One request, whole. */
  async detail(id: string, signal?: AbortSignal): Promise<RequestDetail> {
    return this.#json<RequestDetail>(`/api/requests/${encodeURIComponent(id)}`, signal);
  }

  /**
   * How the request compares against its route's own history, and whether
   * the process underneath was struggling at the time.
   *
   * Empty when there is nothing to compare against, and empty too when the
   * collector is older than the endpoint: a verdict is worth printing when it
   * is there and worth nothing said when it is not.
   */
  async baseline(id: string, signal?: AbortSignal): Promise<BaselineResponse> {
    try {
      return await this.#json<BaselineResponse>(
        `/api/requests/${encodeURIComponent(id)}/baseline`,
        signal,
      );
    } catch {
      return { baseline: null, pressure: null };
    }
  }

  /** The same, unparsed — what `--json` prints. */
  async detailRaw(id: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#get(`/api/requests/${encodeURIComponent(id)}`, signal);
    const text = await response.text();
    if (!response.ok) throw await refusal(response.status, text);
    return text;
  }

  /**
   * The live feed, until the signal is aborted.
   *
   * A dropped connection is reported and retried with a doubling delay: the
   * application restarting is the common case, and a client that dies with it
   * is a client nobody leaves running.
   */
  async stream(handlers: StreamHandlers): Promise<void> {
    const sleep = handlers.sleep ?? wait;
    let backoff = BACKOFF_START;
    let attempt = 0;

    while (!handlers.signal.aborted) {
      try {
        const response = await this.#get('/api/stream', handlers.signal, {
          accept: 'text/event-stream',
        });
        if (!response.ok || !response.body) {
          throw await refusal(response.status, await response.text());
        }

        // The connection stood up: whatever went wrong before is over.
        backoff = BACKOFF_START;
        if (attempt > 0) handlers.onNotice('reconnected');
        attempt = 0;

        await readEvents(response.body, handlers);
        if (handlers.signal.aborted) return;
        // The server closed a stream that has no natural end — reconnect.
      } catch (error) {
        if (handlers.signal.aborted) return;
        if (error instanceof CliError && !(error instanceof UnreachableError)) throw error;
      }

      if (handlers.signal.aborted) return;
      attempt++;
      handlers.onNotice(
        `connection lost, reconnecting in ${seconds(backoff)} (attempt ${attempt})`,
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    }
  }

  async #json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.#get(path, signal);
    const text = await response.text();
    if (!response.ok) throw await refusal(response.status, text);
    try {
      return parsePrintable(text) as T;
    } catch (error) {
      throw new CliError(`the panel answered something that is not JSON (${path})`, {
        cause: error,
      });
    }
  }

  async #get(
    path: string,
    signal?: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const request: RequestInit = {
      headers: this.#token ? { ...headers, 'x-reqray-token': this.#token } : headers,
      ...(signal ? { signal } : {}),
    };
    try {
      return await this.#fetch(`${this.#url}${path}`, request);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new UnreachableError(this.#url, error);
    }
  }
}

/** Turns a refusal into something addressed to a person. */
async function refusal(status: number, body: string): Promise<CliError> {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as ApiError;
    if (typeof parsed.error === 'string') message = parsed.error;
  } catch {
    // Not JSON — whatever the body says is still better than nothing.
  }

  if (status === 404) {
    return new CliError(message || 'no such request — it may have left the buffer already');
  }
  if (status === 401 || status === 403) {
    return new CliError(`the panel refused: ${message || 'access denied'}`, {
      hints: [
        '',
        '  a collector started with a token wants it back:',
        '    reqray watch --token <token>   or   REQRAY_TOKEN=<token>',
      ],
    });
  }
  return new CliError(message || `the panel answered ${status}`);
}

/** Query string for a list request, leaving out what was not asked. */
function searchOf(query: ListQuery): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.query) params.set('q', query.query);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.minDurationMs !== undefined) params.set('minDurationMs', String(query.minDurationMs));
  if (query.methods?.length) params.set('method', query.methods.join(','));
  if (query.statusClasses?.length) params.set('status', query.statusClasses.join(','));
  if (query.onlyFindings) params.set('findings', '1');
  if (query.onlyErrors) params.set('errors', '1');
  if (query.sort) params.set('sort', query.sort);
  const search = params.toString();
  return search ? `?${search}` : '';
}

/**
 * Reads `text/event-stream` until it ends.
 *
 * Events are separated by a blank line and may be split across chunks, so the
 * tail of a chunk is kept until the rest of it arrives. Comment lines — the
 * keep-alive pings — are skipped without a word.
 */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  const stop = (): void => void reader.cancel().catch(() => {});
  handlers.signal.addEventListener('abort', stop, { once: true });

  try {
    while (!handlers.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;

      buffered += decoder.decode(value, { stream: true });
      let split = buffered.indexOf('\n\n');
      while (split !== -1) {
        const event = buffered.slice(0, split);
        buffered = buffered.slice(split + 2);
        const payload = dataOf(event);
        if (payload !== null) {
          try {
            handlers.onRow(parsePrintable(payload) as Parameters<typeof handlers.onRow>[0]);
          } catch {
            // A row we cannot read is one row, not a reason to stop watching.
          }
        }
        split = buffered.indexOf('\n\n');
      }
    }
  } finally {
    handlers.signal.removeEventListener('abort', stop);
    reader.releaseLock();
  }
}

/** The `data:` payload of one event, or `null` for a comment or a ping. */
function dataOf(event: string): string | null {
  const lines = event.split('\n').filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).trimStart()).join('\n');
}

/** A delay as the notice prints it: `2 s`, `500 ms`. */
function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}
