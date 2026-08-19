/*
 * Client for the panel HTTP API.
 *
 * The wire shapes are declared here rather than imported from `@loupe/core`:
 * this is a browser bundle, and core's type surface reaches into `node:http`.
 * The boundary is an HTTP contract, so it is described on both sides.
 */

export interface RequestRow {
  id: string;
  method: string;
  path: string;
  query: string | null;
  /** The path with variable segments collapsed: `/api/orders/:id`. */
  route: string;
  status: number;
  durationMs: number;
  startedAt: number;
  sqlCount: number;
  /** Outgoing HTTP calls made while handling the request. */
  httpCount: number;
  nPlusOne: boolean;
  /** How many findings the detectors produced. */
  findingCount: number;
  hasError: boolean;
  /** Held past its turn in the ring buffer, and exempt from filters. */
  pinned: boolean;
  /** The test that issued the request, or `null` for ordinary traffic. */
  test: string | null;
}

export interface RequestSummary {
  shown: number;
  total: number;
  slow: number;
  errors: number;
  withFindings: number;
}

export interface Callsite {
  file: string;
  relative: string;
  line: number;
  column: number;
}

export interface SpanError {
  name: string;
  message: string;
  stack: string | null;
}

interface SpanCommon {
  id: number;
  parentId: number | null;
  startedAt: number;
  duration: number;
  callsite: Callsite | null;
  error: SpanError | null;
}

export type Span = SpanCommon &
  (
    | { kind: 'middleware' | 'handler'; label: string }
    | {
        kind: 'db';
        sql: string;
        fingerprint: string;
        rowCount: number | null;
        source: string | null;
        /** Only under `collectSqlValues: true`. */
        values?: string[] | null;
      }
    | { kind: 'http'; method: string; url: string; statusCode: number | null }
    | { kind: 'cache'; operation: 'get' | 'set' | 'del'; key: string; hit: boolean | null }
  );

/** Evidence for the detectors that group repeated spans. */
export interface RepeatEvidence {
  kind: 'n_plus_one' | 'sequential_http' | 'duplicate';
  repeats: number;
  fingerprint: string;
  sample: string;
  totalMs: number;
  spanIds: number[];
}

/** Evidence for the budget detector: about the request, not about spans. */
export interface BudgetEvidence {
  kind: 'budget';
  durationMs: number;
  budgetMs: number;
  externalMs: number;
  sqlMs: number;
  spanIds: number[];
}

export interface Finding {
  detector: string;
  severity: 'info' | 'warn' | 'critical';
  title: string;
  costMs: number;
  callsite: Callsite | null;
  evidence: RepeatEvidence | BudgetEvidence;
  hint: string;
}

/**
 * The detectors whose findings are a *run* of spans, which the waterfall
 * collapses into one bar. A duplicate is not a run — its spans sit far apart,
 * and one bar spanning them would swallow everything in between.
 */
export function isRunEvidence(evidence: Finding['evidence']): evidence is RepeatEvidence {
  return evidence.kind === 'n_plus_one' || evidence.kind === 'sequential_http';
}

export interface LogEntry {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/** A stored body: masked, serialized, size-capped text. */
export interface RecordedBody {
  text: string;
  truncated: boolean;
}

export interface RequestDetail extends RequestRow {
  spans: Span[];
  findings: Finding[];
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: RecordedBody | null;
  responseBody: RecordedBody | null;
  logs: LogEntry[];
  error: SpanError | null;
  droppedSpans: number;
  droppedLogs: number;
}

export interface ExceptionFrame {
  raw: string;
  file: string | null;
  line: number | null;
  project: boolean;
}

export interface ExceptionGroup {
  id: string;
  type: string;
  message: string;
  origin: string | null;
  where: string | null;
  count: number;
  lastSeenAt: number;
  requestIds: string[];
  frames: ExceptionFrame[];
  buckets: number[];
  /** A test that reproduced it — the one to run again. */
  test: string | null;
}

export interface ReplayMetrics {
  status: number;
  durationMs: number;
  sqlCount: number;
  /** Outgoing HTTP calls made while handling the request. */
  httpCount: number;
  nPlusOne: boolean;
  bytes: number | null;
  etag: string | null;
}

export interface ReplayComparison {
  original: ReplayMetrics;
  replay: ReplayMetrics;
  partial: boolean;
}

export interface RequestFilterQuery {
  q?: string;
  methods?: string[];
  statusClasses?: number[];
  minDurationMs?: number;
  onlyFindings?: boolean;
}

/**
 * Mount path of the panel, derived from the current location.
 *
 * The panel mounts on an arbitrary path inside the host application, so no
 * absolute API base can be baked into the bundle.
 */
function apiBase(): string {
  const path = window.location.pathname.replace(/\/+$/, '');
  return `${path}/api`;
}

/** An absolute URL for a panel API path — for links the browser must follow. */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal: signal ?? null,
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function toSearchParams(filter: RequestFilterQuery): string {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  if (filter.methods?.length) params.set('method', filter.methods.join(','));
  if (filter.statusClasses?.length) params.set('status', filter.statusClasses.join(','));
  if (filter.minDurationMs) params.set('minDurationMs', String(filter.minDurationMs));
  if (filter.onlyFindings) params.set('findings', '1');
  const query = params.toString();
  return query ? `?${query}` : '';
}

export interface PanelMeta {
  pid: number;
  startedAt: number;
  mode: 'development' | 'production';
  bufferSize: number;
  replayEnabled: boolean;
  blameEnabled: boolean;
}

/** What `git blame` knows about one frame; `null` when it knows nothing. */
export interface BlameLine {
  sha: string;
  author: string;
  at: number;
}

/**
 * Blame for a list of frames, in the same order.
 *
 * A failure is not worth surfacing: the column simply stays empty, which is
 * also what an untracked file looks like.
 */
export async function fetchBlame(
  frames: Array<{ file: string; line: number }>,
): Promise<Array<BlameLine | null>> {
  try {
    const response = await fetch(`${apiBase()}/blame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames }),
    });
    if (!response.ok) return frames.map(() => null);
    return ((await response.json()) as { frames: Array<BlameLine | null> }).frames;
  } catch {
    return frames.map(() => null);
  }
}

/** Opens a file in the editor via its URL scheme. */
export function openInEditor(file: string, line: number): void {
  window.location.href = `vscode://file/${file}:${line}`;
}

export async function fetchMeta(signal?: AbortSignal): Promise<PanelMeta> {
  return getJson(`${apiBase()}/meta`, signal);
}

export async function fetchRequests(
  filter: RequestFilterQuery = {},
  signal?: AbortSignal,
): Promise<{ requests: RequestRow[]; summary: RequestSummary }> {
  return getJson(`${apiBase()}/requests${toSearchParams(filter)}`, signal);
}

export async function fetchRequest(id: string, signal?: AbortSignal): Promise<RequestDetail> {
  return getJson(`${apiBase()}/requests/${encodeURIComponent(id)}`, signal);
}

export async function fetchExceptions(signal?: AbortSignal): Promise<ExceptionGroup[]> {
  const payload = await getJson<{ groups: ExceptionGroup[] }>(`${apiBase()}/exceptions`, signal);
  return payload.groups;
}

export interface RouteStats {
  method: string;
  route: string;
  calls: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  sqlAvg: number;
  timeShare: number;
}

export async function fetchRoutes(
  signal?: AbortSignal,
): Promise<{ routes: RouteStats[]; samples: number; windowMs: number }> {
  return getJson(`${apiBase()}/routes`, signal);
}

export async function clearRequests(): Promise<void> {
  await fetch(`${apiBase()}/requests`, { method: 'DELETE' });
}

/**
 * Pins or unpins a request on the collector.
 *
 * @returns whether it is pinned now — a refusal (gone, or too many pinned)
 * comes back as `false` rather than an exception, because the only thing the
 * panel can do about it is leave the glyph alone.
 */
export async function pinRequest(id: string, pinned: boolean): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase()}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, pinned }),
    });
    if (!response.ok) return false;
    return ((await response.json()) as { pinned?: boolean }).pinned === true;
  } catch {
    return false;
  }
}

export async function replayRequest(payload: {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<ReplayComparison> {
  const response = await fetch(`${apiBase()}/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as ReplayComparison & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

/** One node of an EXPLAIN plan, flattened for display. */
export interface ExplainPlanNode {
  depth: number;
  label: string;
  rows: number | null;
  cost: number | null;
}

export interface ExplainNote {
  severity: 'warn' | 'info';
  message: string;
}

export interface ExplainResult {
  sql: string;
  nodes: ExplainPlanNode[];
  notes: ExplainNote[];
  plan: unknown;
}

export async function explainSpan(id: string, spanId: number): Promise<ExplainResult> {
  const response = await fetch(`${apiBase()}/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, spanId }),
  });
  const body = (await response.json()) as ExplainResult & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

/**
 * Subscribes to the live feed.
 *
 * @returns unsubscribe function.
 */
export function subscribeToRequests(onRow: (row: RequestRow) => void): () => void {
  const source = new EventSource(`${apiBase()}/stream`);
  source.onmessage = (event) => {
    try {
      onRow(JSON.parse(event.data) as RequestRow);
    } catch {
      // A malformed frame must not kill the feed.
    }
  };
  return () => source.close();
}
