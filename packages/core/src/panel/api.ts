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
import type {
  FiledPatternState,
  PanelMeta,
  RequestRow,
  RequestSort,
  RequestSummary,
  SeriesMetric,
  StoredPatternState,
} from '@reqray/protocol';
import type { ResolvedOptions } from '../config.js';
import { detectorSettings } from '../detectors/index.js';
import { warnOnce } from '../logger.js';
import { isPanelRequestAllowed } from '../panel.js';
import type { RetentionLimits } from '../retention.js';
import { ensureTiming } from '../timing.js';
import type { RecordedRequest } from '../types.js';
import { type RouteWindow, whatRanAt } from './activity.js';
import { type BaselineQuery, baselineFor } from './baseline.js';
import { blameLine } from './blame.js';
import { groupExceptions } from './exceptions.js';
import { ExplainError, runExplain } from './explain.js';
import { toCurlScript, toHar } from './export.js';
import { filterRequests, type RequestFilter } from './filters.js';
import { type FindingSamples, type FindingsQuery, flagWithMutes, patternsOf } from './findings.js';
import { type HistoryQuery, type HistorySamples, historyOf, SERIES_COLUMNS } from './history.js';
import { pageFromList } from './page-from-list.js';
import { pressureFor } from './pressure.js';
import { logOf, projectReport, retentionOf } from './project.js';
import { type ReplayInput, runReplay } from './replay.js';
import { normalizeRoute, routeStats } from './routes.js';
import { routeSeries, SERIES_BUCKETS } from './series.js';
import { buildTimeline, TIMELINE_BUCKETS, type TimePoint } from './timeline.js';

export type { RequestRow } from '@reqray/protocol';

/** One page of the request list, newest first. */
export interface RequestPage {
  readonly rows: readonly RequestRow[];
  /** Feed back as `cursor` to get the next, older page. `null` — the end. */
  readonly nextCursor: string | null;
  /** Numbers for the status bar, over the whole store rather than the page. */
  readonly summary: RequestSummary;
}

/** What the panel asks a store for when it wants a page. */
export interface PageQuery {
  readonly filter: RequestFilter;
  readonly limit: number;
  /** Where to continue from. Absent or `null` — start at the beginning. */
  readonly cursor?: string | null | undefined;
  /**
   * What "the beginning" means: the newest requests, or the slowest.
   *
   * Defaults to `recent`. Sorting is the store's job rather than the
   * caller's — "the slowest request" over a history on disk cannot be found
   * by reading a page of it and comparing.
   */
  readonly sort?: RequestSort | undefined;
}

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
  /**
   * When, how long, and whether it failed — for every request the store
   * holds.
   *
   * Optional, and cheap on purpose: three numbers per request, so the strip
   * above the list can span the whole history instead of the page that
   * happens to be loaded. A source without it leaves the panel to draw from
   * the rows it has, which is what it always did.
   */
  timeSeries?(): readonly TimePoint[];
  /**
   * One page of the list, filtered and cut by the store itself.
   *
   * Optional, and the difference between a buffer and a history: reading
   * everything into memory to filter it is what an in-memory ring can afford
   * and a store on disk cannot. A source without this method is served by
   * `list()`, whole.
   */
  page?(query: PageQuery): RequestPage;
  /**
   * Durations of other calls of one route.
   *
   * Optional, and asked for rather than derived from `list()`: judging one
   * call against its route means reading that route's whole history, which a
   * ring buffer can afford to scan and a store on disk should answer with a
   * query. A source without it leaves the detail page with no verdict, which
   * is better than a verdict drawn from the last page that happened to load.
   */
  durations?(query: BaselineQuery): readonly DurationSample[];
  /**
   * Traffic grouped by route over a stretch of time.
   *
   * Optional, and an aggregate rather than a page: answering "what ran in
   * this moment" by reading the moment's requests would mean loading a busy
   * minute of them to count four numbers per route.
   */
  counts?(query: { from: number; to: number }): readonly RouteWindow[];
  /**
   * A period's requests, a handful of numbers each.
   *
   * Optional, and the one method that reads a *stretch* rather than a page or
   * a route: the history screen asks what a week did, and answering that from
   * `list()` would mean holding a week of payloads in memory to look at ten
   * fields in each. A store must bound what it reads and say when it stopped
   * — a truncated total presented as a complete one is worse than no screen.
   */
  history?(query: HistoryQuery): HistorySamples;
  /**
   * Finding occurrences over a stretch of time, one row each.
   *
   * Optional, and rare rows on purpose: requests with findings are a small
   * minority, so a store answers this from them alone instead of reading the
   * window. A source without it leaves the findings tab explaining itself
   * rather than empty.
   */
  findings?(query: FindingsQuery): FindingSamples;
  /**
   * The reader's own bookkeeping per pattern: `ack` or `muted`.
   *
   * Patterns in neither state are `new` and are simply absent. A store that
   * persists (SQLite) keeps these across restarts; the in-memory ring keeps
   * them exactly as long as it keeps the requests they are about.
   */
  findingStates?(): ReadonlyMap<string, FiledPatternState>;
  /** Remembers a state; `new` forgets the pattern. */
  setFindingState?(id: string, state: StoredPatternState): void;
}

/**
 * One call of a route, as the store hands it over.
 *
 * Four numbers rather than a record: judging a call against its route, or
 * drawing the route's last hour, means reading every call of it, and parsing
 * a few thousand JSON documents to look at one field in each is how a page
 * becomes slow.
 */
export interface DurationSample {
  readonly durationMs: number;
  /** Epoch ms — what the window the samples cover is measured from. */
  readonly startedAt: number;
  /** Threw, or answered 5xx — what the error-rate chart counts. */
  readonly hasError: boolean;
  /**
   * Mean event-loop delay while it ran, or `null` when nothing measured it.
   *
   * What splits a route's calls into "the host was fine" and "the host was
   * struggling" — the comparison that says whether the process was to blame.
   */
  readonly loopDelayMs: number | null;
}

/** Everything the panel handler needs to serve a request. */
export interface PanelHandlerInit {
  readonly source: PanelSource;
  readonly options: ResolvedOptions;
  /**
   * Directory with the built dashboard.
   *
   * Left out when `@reqray/dashboard` is not installed: the API keeps working
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

/**
 * The transport the panel can read from, if there is one.
 *
 * A transport is a store when it can answer the four questions the panel
 * asks. An HTTP transport to an external collector cannot — the panel then
 * runs in the collector. Neither can a log file, which is write-only by
 * design, so a fan-out is searched through rather than tested as a whole.
 *
 * Warns when the panel is configured and nothing can serve it: a panel that
 * quietly does not mount is a 404 nobody can explain.
 */
export function panelSourceFor(transport: unknown, options: ResolvedOptions): PanelSource | null {
  const direct = asPanelSource(transport);
  if (direct) return direct;

  const members = (transport as { transports?: readonly unknown[] } | null)?.transports;
  if (Array.isArray(members)) {
    for (const member of members) {
      const found = asPanelSource(member);
      if (found) return found;
    }
  }

  if (options.enabled && options.panel) {
    const name = (transport as { name?: unknown } | null)?.name;
    warnOnce(
      'panel.source',
      `the panel is not mounted: ${typeof name === 'string' ? name : 'this transport'} keeps no requests to show. ` +
        'A store — @reqray/store-memory or @reqray/store-sqlite — has to be among the transports.',
    );
  }
  return null;
}

/** Whether a transport can answer what the panel asks of a store. */
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
    // Straight through, including the nulls: a row from a store written
    // before cost was measured has no cost, and inventing a zero would put a
    // cheap-looking request next to genuinely cheap ones.
    cpuMs: request.cost?.cpuMs ?? null,
    cpuShare: request.cost?.cpuShare ?? null,
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

/**
 * How many rows one page may hold.
 *
 * Capped rather than trusted: the parameter comes from a browser, and an
 * unbounded page defeats the point of having pages at all.
 */
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

function pageLimit(params: URLSearchParams): number {
  const asked = Number(params.get('limit'));
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(asked), MAX_PAGE_LIMIT);
}

/** A positive finite number from a query parameter, or `undefined`. */
function positive(raw: string | null): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const HOUR_MS = 60 * 60 * 1000;

/** Every metric the history screen may ask for. Nothing outside this list. */
const METRICS: readonly SeriesMetric[] = [
  'p50',
  'p95',
  'p99',
  'throughput',
  'errorRate',
  'sqlPerRequest',
  'httpPerRequest',
  'bytes',
  'loopDelay',
  'findingsPerRequest',
];

/**
 * Which metrics to draw.
 *
 * Two at most: a third line is a dashboard, and a chart nobody can read is
 * not a better answer than a chart with one line on it.
 */
function parseMetrics(params: URLSearchParams): SeriesMetric[] {
  const asked = params
    .getAll('metric')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value): value is SeriesMetric => (METRICS as readonly string[]).includes(value));

  const unique = [...new Set(asked)].slice(0, 2);
  return unique.length > 0 ? unique : ['p95'];
}

/**
 * The query string, as the filter the store applies.
 *
 * Exported so the panel's client-side filter is checked against this and not
 * against a second reading of the same parameters.
 */
export function parseFilter(params: URLSearchParams): RequestFilter {
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
  const minSql = Number(params.get('minSql'));
  const status = Number(params.get('statusExact'));
  const flagged = params
    .getAll('flagged')
    .flatMap((value) => value.split(','))
    .filter(Boolean);
  const route = params.get('route');
  const routeMethod = params.get('routeMethod');
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));

  return {
    from: Number.isFinite(from) && from > 0 ? from : undefined,
    to: Number.isFinite(to) && to > 0 ? to : undefined,
    query: params.get('q') ?? undefined,
    methods,
    statusClasses,
    minDurationMs: Number.isFinite(minDuration) && minDuration > 0 ? minDuration : undefined,
    onlyFindings: params.get('findings') === '1',
    onlyNPlusOne: params.get('nplus') === '1',
    onlyTests: params.get('tests') === '1',
    onlyErrors: params.get('errors') === '1',
    route: route && routeMethod ? { method: routeMethod, route } : undefined,
    path: params.get('path') ?? undefined,
    status: Number.isFinite(status) && status > 0 ? status : undefined,
    minSql: Number.isFinite(minSql) && minSql > 0 ? minSql : undefined,
    flagged: flagged.length > 0 ? flagged : undefined,
    test: params.get('test') ?? undefined,
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

/**
 * The application's own address — replay needs it to call back into itself.
 *
 * From the socket, never from `Host`. Replay follows this address carrying
 * headers the caller chose, so a forged `Host` would aim it — cookies and all
 * — at any host that resolves.
 */
function originOf(request: IncomingMessage): string {
  const port = request.socket.localPort;
  const address = request.socket.localAddress ?? '127.0.0.1';
  // IPv6 literals need brackets in a URL; `::1` is the ordinary local case.
  const host = address.includes(':') ? `[${address}]` : address;
  // TLS never reaches this far: the panel is mounted inside the application,
  // and replay always goes to its own local address.
  return `http://${host}${port ? `:${port}` : ''}`;
}

/**
 * Whether a state-changing request came from the panel itself.
 *
 * The gate says who may use the panel, not what page is asking. Without this,
 * any site open in a developer's browser can POST to `/api/replay` and make
 * the application run a recorded request again — a second charge, a second
 * email. That the reply is unreadable to that page is no comfort: the effect
 * has happened.
 *
 * `Sec-Fetch-Site` is the browser's own account and cannot be set by script.
 * `same-site` is refused with `cross-site`: two ports of localhost are one
 * site, and the dev server on the other port is the neighbour in question.
 *
 * Neither header means the caller is not a browser, and CSRF is not that.
 */
function isSameOrigin(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin' || site === 'none';

  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;

  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    // An origin that is not a URL is not one this panel wrote.
    return false;
  }
}

/**
 * How many requests one export may carry.
 *
 * It serializes whole records into one string, synchronously, answering a GET.
 * The stores bound `list()`, but a bound living in the store is not this
 * endpoint's: a store written elsewhere would hand over its whole history.
 */
const EXPORT_LIMIT = 1_000;

/** The newest requests matching the filter, and how many did not fit. */
function forExport(
  source: PanelSource,
  params: URLSearchParams,
): { requests: readonly RecordedRequest[]; dropped: number } {
  const matched = filterRequests(source.list(), parseFilter(params));
  if (matched.length <= EXPORT_LIMIT) return { requests: matched, dropped: 0 };
  // The newest, because a truncated export should be the recent part of the
  // story rather than an arbitrary slice of it.
  return {
    requests: matched.slice(-EXPORT_LIMIT),
    dropped: matched.length - EXPORT_LIMIT,
  };
}

/**
 * What a truncated export says about itself.
 *
 * An export is evidence: a cap nobody is told about reads as "this is
 * everything".
 */
function exportNote(dropped: number): string | null {
  return dropped === 0
    ? null
    : `${dropped} older request${dropped === 1 ? '' : 's'} matched and were left out: an export carries at most ${EXPORT_LIMIT}.`;
}

/**
 * How many live feeds one panel may hold open at once.
 *
 * Each one is a listener on the store and a timer; nothing else bounds them,
 * and a stream is opened by a GET that anything can repeat.
 */
const MAX_STREAMS = 32;

/**
 * How much one feed may have written that its reader has not taken.
 *
 * A tab left in the background or a proxy that stalled stops reading, and
 * every row since then sits in this process's memory, per feed, without end.
 * Past this the feed is dropped; the panel reconnects and re-reads the list,
 * which is what it does after any gap.
 */
const MAX_STREAM_BACKLOG_BYTES = 1024 * 1024;

/**
 * How many feeds one panel is holding.
 *
 * Per handler rather than per process: two applications in one process are two
 * panels, and a cap they share is a cap that depends on a neighbour.
 */
interface StreamCount {
  open: number;
}

function streamEvents(
  source: PanelSource,
  mutes: MuteView,
  request: IncomingMessage,
  response: ServerResponse,
  streams: StreamCount,
): void {
  if (streams.open >= MAX_STREAMS) {
    sendJson(response, 503, { error: `too many live feeds open (${MAX_STREAMS})` });
    return;
  }
  streams.open++;

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disables nginx buffering: without it the feed stalls.
    'x-accel-buffering': 'no',
  });
  response.write(': reqray stream\n\n');

  const unsubscribe = source.subscribe((recorded) => {
    // The live feed obeys mutes the same way the list does.
    const [row] = mutes.silence([toRow(recorded)]);
    if (response.writableLength > MAX_STREAM_BACKLOG_BYTES) {
      response.destroy();
      return;
    }
    response.write(`data: ${JSON.stringify(row)}\n\n`);
  });

  const keepAlive = setInterval(() => response.write(': ping\n\n'), 20_000);
  keepAlive.unref?.();

  let stopped = false;
  const stop = (): void => {
    // Both `close` events fire for one disconnect; the count must move once.
    if (stopped) return;
    stopped = true;
    streams.open--;
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
  const streams: StreamCount = { open: 0 };
  const mutes = new MuteView(source);

  const serve: PanelHandler = (request, response) => {
    // Express strips the matched mount prefix from `url` inside `app.use`;
    // `originalUrl` keeps the full path. Anything non-Express has no such
    // property and falls back to the plain url.
    const rawUrl = (request as { originalUrl?: string }).originalUrl ?? request.url ?? '/';
    if (rawUrl !== mount && !rawUrl.startsWith(`${mount}/`) && !rawUrl.startsWith(`${mount}?`)) {
      return false;
    }

    const url = new URL(rawUrl, 'http://reqray.local');
    const route = url.pathname.slice(mount.length) || '/';

    if (
      !isPanelRequestAllowed(panel.gate, {
        headers: request.headers,
        ip: request.socket.remoteAddress ?? null,
      })
    ) {
      sendJson(response, 403, {
        error: panel.gate
          ? 'panel access denied by the gate'
          : 'without a gate the panel answers only to this machine, at a local address. ' +
            "To open it further, set one: reqray({ panel: { gate: 'open' } }) or a function.",
      });
      return true;
    }

    const method = request.method ?? 'GET';

    // Before anything reads a body: a refusal has to come earlier than the
    // work it refuses, and every state-changing route is behind this line.
    if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(request)) {
      sendJson(response, 403, { error: 'this request did not come from the panel' });
      return true;
    }

    if (route === '/api/meta' && method === 'GET') {
      // Typed rather than inline: this object is the `/api/meta` contract, and
      // the protocol is where that contract is written down.
      const meta: PanelMeta = {
        pid: process.pid,
        startedAt: Date.now() - Math.round(process.uptime() * 1000),
        mode: options.mode,
        bufferSize: options.bufferSize,
        replayEnabled: options.replay,
        blameEnabled: options.blame,
        detectors: detectorSettings(options),
      };
      sendJson(response, 200, meta);
      return true;
    }

    if (route === '/api/project' && method === 'GET') {
      // Async, unlike every other route here: it asks git which commit is
      // running, and a panel that lies about the build is worse than one that
      // takes a few milliseconds.
      void projectReport(options, source)
        .then((report) => sendJson(response, 200, report))
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          sendJson(response, 500, { error: `project report unavailable: ${reason}` });
        });
      return true;
    }

    if (route === '/api/retention' && method === 'GET') {
      sendJson(response, 200, { retention: retentionOf(options), log: logOf(options) });
      return true;
    }

    if (route === '/api/retention' && method === 'POST') {
      handleRetention(options, request, response);
      return true;
    }

    if (route === '/api/timeline' && method === 'GET') {
      if (!source.timeSeries) {
        sendJson(response, 200, { timeline: null });
        return true;
      }
      const asked = Number(url.searchParams.get('buckets'));
      const buckets =
        Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 512) : TIMELINE_BUCKETS;
      // A stretch, when the caller names one. A store with days of history
      // and an hour of traffic draws a strip that is empty but for two
      // columns; being able to ask for the part worth looking at is what
      // makes the strip readable without making it lie about the rest.
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const points =
        Number.isFinite(from) && Number.isFinite(to) && to > from
          ? source.timeSeries().filter((point) => point.startedAt >= from && point.startedAt <= to)
          : source.timeSeries();
      sendJson(response, 200, { timeline: buildTimeline(points, buckets) });
      return true;
    }

    if (route === '/api/requests' && method === 'GET') {
      const filter = parseFilter(url.searchParams);
      const limit = pageLimit(url.searchParams);
      const sort: RequestSort = url.searchParams.get('sort') === 'slowest' ? 'slowest' : 'recent';

      // A store that can page does its own filtering: a history on disk must
      // not be read into memory to answer one screenful.
      if (source.page) {
        const page = source.page({
          filter,
          limit,
          sort,
          cursor: url.searchParams.get('cursor'),
        });
        sendJson(response, 200, {
          requests: mutes.silence(page.rows),
          summary: page.summary,
          nextCursor: page.nextCursor,
        });
        return true;
      }

      // No `page()`: the same rule, applied here over everything the store
      // holds, rather than a second implementation of it.
      const page = pageFromList(
        source.list(),
        { filter, limit, sort, cursor: url.searchParams.get('cursor') },
        {
          pinned: new Set(source.pinned?.() ?? []),
          slowMs: options.sampling.slowMs || 500,
        },
      );
      sendJson(response, 200, {
        requests: mutes.silence(page.rows),
        summary: page.summary,
        nextCursor: page.nextCursor,
      });
      return true;
    }

    if (route === '/api/export/har' && method === 'GET') {
      const { requests: shown, dropped } = forExport(source, url.searchParams);
      sendDownload(
        response,
        'reqray.har',
        'application/json; charset=utf-8',
        JSON.stringify(toHar(shown, new Date(), exportNote(dropped)), null, 2),
      );
      return true;
    }

    if (route === '/api/export/curl' && method === 'GET') {
      const { requests: shown, dropped } = forExport(source, url.searchParams);
      sendDownload(
        response,
        'reqray-requests.sh',
        'text/x-shellscript; charset=utf-8',
        toCurlScript(shown, originOf(request), exportNote(dropped)),
      );
      return true;
    }

    if (route === '/api/blame' && method === 'POST') {
      if (!options.blame) {
        sendJson(response, 403, {
          error:
            'git blame from the panel is off. Outside local development it is enabled explicitly: reqray({ blame: true }).',
        });
        return true;
      }
      handleBlame(options, request, response);
      return true;
    }

    if (route === '/api/routes' && method === 'GET') {
      sendJson(response, 200, routeStats(source.list(), mutes.set()));
      return true;
    }

    if (route === '/api/series' && method === 'GET') {
      if (!source.history) {
        // The store cannot read a stretch. Said plainly rather than drawn as
        // an empty chart, which would be a claim about a quiet week.
        sendJson(response, 200, { series: null });
        return true;
      }

      const now = Date.now();
      const to = positive(url.searchParams.get('to')) ?? now;
      const from = positive(url.searchParams.get('from')) ?? to - HOUR_MS;
      if (to <= from) {
        sendJson(response, 400, { error: 'the period must end after it starts' });
        return true;
      }

      const askedColumns = positive(url.searchParams.get('buckets'));
      const columns = askedColumns ? Math.min(Math.floor(askedColumns), 512) : SERIES_COLUMNS;
      const metrics = parseMetrics(url.searchParams);
      const filter = parseFilter(url.searchParams);

      const query = (span: { from: number; to: number }): HistoryQuery => ({
        ...span,
        // The period is the period, whatever the filter's own range says: the
        // screen owns the window, and a stale `from` in the filter would
        // silently narrow it.
        filter: { ...filter, from: span.from, to: span.to },
      });

      const current: HistorySamples = source.history(query({ from, to }));
      // The same length again, immediately before. Only ever used for a
      // comparison, so a truncated reading of it changes nothing that is
      // presented as complete.
      const before = source.history(query({ from: from - (to - from), to: from - 1 }));

      sendJson(response, 200, {
        series: historyOf(current, before.samples, { from, to, metrics, columns }),
      });
      return true;
    }

    if (route === '/api/findings' && method === 'GET') {
      if (!source.findings) {
        // The store cannot read its findings back. Said plainly rather than
        // rendered as an empty work list, which would be a claim about the
        // code being clean.
        sendJson(response, 200, { findings: null });
        return true;
      }
      const read = source.findings({
        from: positive(url.searchParams.get('from')),
        to: positive(url.searchParams.get('to')),
      });
      sendJson(response, 200, {
        findings: patternsOf(read, {
          states: source.findingStates?.(),
          changedAt: fileChangedAt,
        }),
      });
      return true;
    }

    if (route === '/api/findings/state' && method === 'POST') {
      handleFindingState(source, mutes, request, response);
      return true;
    }

    if (route === '/api/routes/series' && method === 'GET') {
      const wanted = url.searchParams.get('route');
      const verb = url.searchParams.get('method');
      if (!wanted || !verb) {
        sendJson(response, 400, { error: 'a route and a method are needed to draw one' });
        return true;
      }
      // A store that cannot answer draws nothing, rather than a chart of
      // whatever page the browser happened to be holding.
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const samples = source.durations?.({
        method: verb,
        route: wanted,
        // A chart is drawn over the stretch the caller names, so that it
        // covers the same traffic the table beside it describes.
        ...(Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : {}),
      });
      const asked = Number(url.searchParams.get('buckets'));
      const buckets =
        Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 256) : SERIES_BUCKETS;
      sendJson(response, 200, {
        series: samples ? routeSeries(verb, wanted, samples, buckets) : null,
      });
      return true;
    }

    if (route === '/api/timeline/at' && method === 'GET') {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      const overallFrom = Number(url.searchParams.get('overallFrom'));
      const overallTo = Number(url.searchParams.get('overallTo'));
      if (![from, to, overallFrom, overallTo].every(Number.isFinite) || to <= from) {
        sendJson(response, 400, { error: 'a moment needs a start and an end, in epoch ms' });
        return true;
      }
      if (!source.counts) {
        sendJson(response, 200, { activity: null });
        return true;
      }
      sendJson(response, 200, {
        activity: whatRanAt(
          source.counts({ from, to }),
          source.counts({ from: overallFrom, to: overallTo }),
          { from, to, overallMs: overallTo - overallFrom },
        ),
      });
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

    // ORDER MATTERS from here to the end of the `/api/requests/` group: these
    // are prefix matches, not exact ones, and `/api/requests/:id` below would
    // swallow `/api/requests/:id/baseline` if it came first. The chain has no
    // way to say so structurally, so it says so here.
    if (route.startsWith('/api/requests/') && route.endsWith('/baseline') && method === 'GET') {
      const id = decodeURIComponent(route.slice('/api/requests/'.length, -'/baseline'.length));
      const found = source.get(id);
      if (!found) {
        sendJson(response, 404, {
          error: 'request not found — possibly evicted from the ring buffer',
        });
        return true;
      }
      // A store that cannot answer produces no baseline, and the panel shows
      // no card: an absent comparison is an ordinary answer here.
      const samples = source.durations?.({
        method: found.method,
        route: normalizeRoute(found.path),
        excludeId: found.id,
      });
      sendJson(response, 200, {
        baseline: baselineFor(found, samples),
        pressure: samples ? pressureFor(samples) : null,
      });
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
        ...ensureTiming(found),
      });
      return true;
    }

    if (route === '/api/exceptions' && method === 'GET') {
      sendJson(response, 200, { groups: groupExceptions(source.list(), options.stack) });
      return true;
    }

    if (route === '/api/stream' && method === 'GET') {
      streamEvents(source, mutes, request, response, streams);
      return true;
    }

    if (route === '/api/explain' && method === 'POST') {
      if (!options.explain) {
        sendJson(response, 403, {
          error:
            'EXPLAIN from the panel is off. Outside local development it is enabled explicitly: reqray({ explain: true }).',
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
            'replay is off. Outside local development it is enabled only explicitly: reqray({ replay: true }) — a replay in production means a second charge and a second email.',
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
        : 'the panel UI is not installed: add @reqray/dashboard. The API keeps working.',
    });
    return true;
  };

  return function handlePanelRequest(request, response): boolean {
    try {
      return serve(request, response);
    } catch (error) {
      // Only a panel request gets this far before anything can throw — a
      // malformed `%` in an id, say — and it must end here: on a bare
      // `node:http` server an exception in the listener takes the process,
      // which is the application's.
      const reason = error instanceof Error ? error.message : String(error);
      if (response.headersSent) response.destroy();
      else sendJson(response, 400, { error: `bad panel request: ${reason}` });
      return true;
    }
  };
}

/**
 * Changes how long requests are kept.
 *
 * The only setting the panel can write, and it deletes data on the way down,
 * so it is refused unless the application handed the panel a policy and said
 * it may be changed. Values are checked here rather than trusted: the panel
 * is a client like any other.
 */
function handleRetention(
  options: ResolvedOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  void (async () => {
    const policy = options.retention;
    if (!policy) {
      sendJson(response, 501, {
        error:
          'this application keeps to fixed limits: pass reqray({ retention: retentionPolicy({ … }) }) to make them changeable.',
      });
      return;
    }
    if (!policy.writable) {
      sendJson(response, 403, {
        error: 'retention is read-only here: the policy was created with writable: false.',
      });
      return;
    }

    try {
      const payload = (await readBody(request)) as Partial<RetentionLimits>;
      const patch: Record<string, unknown> = {};
      for (const key of ['days', 'maxBytes', 'maxRequests'] as const) {
        if (key in payload) patch[key] = payload[key];
      }
      if (Object.keys(patch).length === 0) {
        sendJson(response, 400, { error: 'nothing to change: days, maxBytes or maxRequests' });
        return;
      }

      const limits = policy.update(patch as Partial<RetentionLimits>);
      // The stores sweep on their own schedule; what is reported back is the
      // policy, not a promise that the disk is already smaller.
      sendJson(response, 200, { retention: retentionOf(options), limits });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: `retention unchanged: ${reason}` });
    }
  })();
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

/**
 * When a file last changed, epoch ms — what `fixed?` is guessed from.
 *
 * The file's mtime rather than git: honest enough for a guess drawn with a
 * question mark, and free. Unreadable files answer "nobody knows".
 */
function fileChangedAt(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * What is muted, remembered between changes.
 *
 * Muting is presentation, not detection: the record keeps its findings, but a
 * muted pattern must stop flagging the list, the live feed and the routes
 * table alike — one that flashes amber on arrival and goes grey on reload is a
 * haunting.
 *
 * Held rather than rebuilt per call: it changes only when somebody mutes
 * something, and the live feed would otherwise walk the whole state map once
 * per request delivered.
 */
class MuteView {
  #muted: Set<string> | null = null;

  constructor(private readonly source: PanelSource) {}

  /** Pattern ids the reader muted, or an empty set when nothing is. */
  set(): ReadonlySet<string> {
    if (this.#muted) return this.#muted;

    const muted = new Set<string>();
    const states = this.source.findingStates?.();
    if (states) {
      for (const [id, state] of states) if (state === 'muted') muted.add(id);
    }
    this.#muted = muted;
    return muted;
  }

  /** Called when a state changes; the next read rebuilds. */
  forget(): void {
    this.#muted = null;
  }

  /**
   * Rows with muted patterns silenced.
   *
   * Only flagged rows are looked up — they are the rare ones — and a record
   * the store has already dropped keeps the flag it had.
   */
  silence(rows: readonly RequestRow[]): readonly RequestRow[] {
    const muted = this.set();
    if (muted.size === 0) return rows;
    return rows.map((row) => {
      if (row.flag === null) return row;
      const record = this.source.get(row.id);
      if (!record) return row;
      const flag = flagWithMutes(record, muted);
      return flag === row.flag ? row : { ...row, flag };
    });
  }
}

/**
 * The states a client may set.
 *
 * `fixed` is deliberately absent: it is a computed guess, and a stored one
 * would outlive the change it guessed about. The list is what both the check
 * and the refusal message are built from, so they cannot drift apart.
 */
const SETTABLE_STATES: readonly StoredPatternState[] = ['new', 'ack', 'muted'];

function isSettable(value: unknown): value is StoredPatternState {
  return (SETTABLE_STATES as readonly unknown[]).includes(value);
}

function handleFindingState(
  source: PanelSource,
  mutes: MuteView,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  void (async () => {
    if (!source.setFindingState) {
      sendJson(response, 501, { error: 'this store cannot remember finding states' });
      return;
    }
    try {
      const payload = (await readBody(request)) as { id?: unknown; state?: unknown };
      if (typeof payload.id !== 'string' || payload.id.length === 0 || !isSettable(payload.state)) {
        sendJson(response, 400, {
          error: `a pattern id and a state (${SETTABLE_STATES.join(', ')}) are needed`,
        });
        return;
      }
      const state = payload.state;
      source.setFindingState(payload.id, state);
      // The only moment what is muted can change.
      mutes.forget();
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: `state change failed: ${reason}` });
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
