/**
 * `@reqray/store-sqlite` — a request history that outlives the process.
 *
 * The in-memory ring is a buffer, not a history: it holds the last few
 * hundred requests and forgets everything when the process restarts. This
 * store writes to a file instead, so "what happened an hour ago" and "what
 * did that request look like before yesterday's deploy" have answers.
 *
 * **`node:sqlite`, not a native driver.** Storage that needs a compiler at
 * install time is storage most people will not turn on. Node ships SQLite
 * since 22.5, which is what this package requires — one version above what
 * the rest of Reqray asks for, and the reason it is a package of its own
 * rather than a branch inside the memory store.
 *
 * **Retention is a promise about disk, not a hope.** Two budgets, whichever
 * runs out first: a number of requests and a number of bytes. Beyond them the
 * oldest go, except pinned ones — the whole point of a pin is that it is the
 * request you are working on.
 *
 * Writes are synchronous and unbatched on purpose. `send()` is already called
 * outside request handling, an insert costs single-digit microseconds, and a
 * write queue would mean a request that the live feed has announced but the
 * store cannot yet hand back.
 */

import type { Transport } from '@reqray/core';
import { DAY_MS, type RetentionPolicy, warnOnce } from '@reqray/core';
import type {
  BaselineQuery,
  DurationSample,
  PageQuery,
  RequestPage,
  RouteWindow,
  TimePoint,
} from '@reqray/core/panel';
import {
  decodeCursor,
  encodeCursor,
  type FindingSamples,
  type FindingsQuery,
  findingSamplesOf,
  type HistoryQuery,
  type HistorySample,
  type HistorySamples,
  toRow,
} from '@reqray/core/panel';
import type {
  FiledPatternState,
  RecordedRequest,
  RequestRow,
  RequestSummary,
  StoredPatternState,
} from '@reqray/protocol';
import { afterCursor, orderColumn, whereFor } from './query.js';

/** Options for {@link sqliteTransport}. */
export interface SqliteTransportOptions {
  /**
   * Database file. `:memory:` keeps it in the process, which is for tests —
   * a history that dies with the process is what this package exists to fix.
   */
  readonly file: string;
  /** How many requests to keep. Older ones are evicted. */
  readonly maxRequests?: number;
  /**
   * The retention policy, shared with the log and with the panel.
   *
   * Given one, its limits win over the two below and a change made from the
   * panel takes effect on the next eviction. Without one the numbers here are
   * fixed for the life of the process.
   */
  readonly retention?: RetentionPolicy;
  /** How much disk the payloads may take, bytes. */
  readonly maxBytes?: number;
  /** How many requests may be pinned at once. */
  readonly pinLimit?: number;
  /**
   * How many records {@link SqliteStore.list} returns at most.
   *
   * The aggregate screens — routes, exceptions — and the exports read the
   * store whole. On a history "whole" is unbounded, so they see the most
   * recent slice instead, and this is its size.
   */
  readonly listLimit?: number;
}

/** Summary of what the store holds. */
export interface SqliteStoreStats {
  readonly size: number;
  readonly capacity: number;
  /** How many requests have been evicted since the store was opened. */
  readonly evicted: number;
  readonly oldestAt: number | null;
  readonly pinned: number;
  /** Bytes the stored payloads add up to. */
  readonly bytes: number;
}

/** Listener for the panel's live feed. */
export type SqliteStoreListener = (request: RecordedRequest) => void;

/** A transport that is also the store the panel reads from. */
export interface SqliteStore extends Transport {
  list(): RecordedRequest[];
  get(id: string): RecordedRequest | undefined;
  clear(): void;
  stats(): SqliteStoreStats;
  subscribe(listener: SqliteStoreListener): () => void;
  pin(id: string, pinned: boolean): boolean;
  pinned(): string[];
  page(query: PageQuery): RequestPage;
  /** Durations of other calls of one route, for the detail page's verdict. */
  durations(query: BaselineQuery): DurationSample[];
  /** Traffic grouped by route over a stretch of time. */
  counts(query: { from: number; to: number }): RouteWindow[];
  /** Three numbers per request, for the strip above the list. */
  timeSeries(): TimePoint[];
  /** A period's requests, a handful of numbers each, for the history screen. */
  history(query: HistoryQuery): HistorySamples;
  /** Finding occurrences over a stretch, one row each, for the findings tab. */
  findings(query: FindingsQuery): FindingSamples;
  /** `ack`/`muted` per pattern id — the part of the tab that must survive a restart. */
  findingStates(): ReadonlyMap<string, FiledPatternState>;
  /** Remembers a state; `new` forgets the pattern. */
  setFindingState(id: string, state: StoredPatternState): void;
  close(): Promise<void>;
}

/** How often age is swept while requests arrive. */
const AGE_SWEEP_MS = 60_000;

/**
 * How many flagged requests a findings reading parses at most.
 *
 * The one place this store deserializes payloads in bulk — findings live
 * inside them — bounded because "bulk" must never mean "the whole file".
 * Requests with findings are a small minority, so the ceiling is rarely met;
 * newest first, so a truncated reading is the recent part of the story.
 */
const FINDINGS_LIMIT = 5_000;

const DEFAULT_MAX_REQUESTS = 20_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_PIN_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 1_000;
/**
 * How many requests the strip above the list may be drawn from.
 *
 * Three numbers each, so this is a few megabytes at the ceiling — and beyond
 * it the strip would be carrying more detail than a screen has pixels.
 */
const TIME_SERIES_LIMIT = 50_000;
/**
 * How many calls of one route a verdict rests on.
 *
 * Far more than the twenty a percentile needs, and far fewer than a busy
 * route's whole history: a detail page must open now, and the ten-thousandth
 * most recent call of the same endpoint would not move the number.
 */
const BASELINE_LIMIT = 10_000;
/**
 * How many requests one reading of the history screen rests on.
 *
 * The same ceiling the strip reads under, for the same reason: a period is
 * chosen by a person looking at a chart, and the answer has to arrive while
 * they are still looking. Beyond it the screen says so rather than presenting
 * the recent part of a period as the whole of it.
 */
const HISTORY_LIMIT = 50_000;
/** The slow threshold the status bar counts by, matching the panel's default. */
const SLOW_MS = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  started_at    INTEGER NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  query_string  TEXT,
  route         TEXT NOT NULL,
  status        INTEGER NOT NULL,
  duration_ms   REAL NOT NULL,
  sql_count     INTEGER NOT NULL,
  http_count    INTEGER NOT NULL,
  n_plus_one    INTEGER NOT NULL,
  has_error     INTEGER NOT NULL,
  finding_count INTEGER NOT NULL,
  flag          TEXT,
  test          TEXT,
  loop_delay_ms REAL,
  sql_ms        REAL,
  self_ms       REAL,
  bytes_out     INTEGER,
  cpu_ms        REAL,
  cpu_share     REAL,
  pinned        INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL,
  payload       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_by_time ON requests (started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS requests_pinned ON requests (pinned) WHERE pinned = 1;
CREATE INDEX IF NOT EXISTS requests_by_duration ON requests (duration_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS requests_by_route ON requests (route, method, started_at DESC);
CREATE TABLE IF NOT EXISTS finding_states (
  id         TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** A row as the table stores it. */
interface StoredRow {
  id: string;
  started_at: number;
  method: string;
  path: string;
  query_string: string | null;
  route: string;
  status: number;
  duration_ms: number;
  sql_count: number;
  http_count: number;
  n_plus_one: number;
  has_error: number;
  finding_count: number;
  flag: string | null;
  test: string | null;
  cpu_ms: number | null;
  cpu_share: number | null;
  pinned: number;
}

function toRequestRow(stored: StoredRow): RequestRow {
  return {
    id: stored.id,
    method: stored.method,
    path: stored.path,
    query: stored.query_string,
    route: stored.route,
    status: stored.status,
    durationMs: stored.duration_ms,
    startedAt: stored.started_at,
    sqlCount: stored.sql_count,
    httpCount: stored.http_count,
    nPlusOne: stored.n_plus_one === 1,
    hasError: stored.has_error === 1,
    findingCount: stored.finding_count,
    flag: stored.flag,
    test: stored.test,
    cpuMs: stored.cpu_ms,
    cpuShare: stored.cpu_share,
    pinned: stored.pinned === 1,
  };
}

interface SqliteModule {
  DatabaseSync: new (path: string) => Database;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/**
 * Opens `node:sqlite`, or explains itself.
 *
 * Looked up at run time rather than imported: the module does not exist
 * before Node 22.5, and a static import would fail the whole bundle with
 * "cannot find module node:sqlite", which is not an explanation anybody
 * should have to decode. `getBuiltinModule` answers `undefined` instead of
 * throwing, and works the same in both the ESM and the CJS build.
 */
/**
 * Columns added after the table existed.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a database that is already
 * there, so a store somebody has been filling for a week would keep its old
 * shape and every insert would fail on the new column. Checked rather than
 * versioned: there is one table, and asking it what it has is cheaper than
 * keeping a migration ledger honest.
 */
function addMissingColumns(db: Database): void {
  const existing = new Set(
    db
      .prepare('PRAGMA table_info(requests)')
      .all()
      .map((row) => row['name'] as string),
  );
  const columns: Array<[name: string, definition: string]> = [
    ['loop_delay_ms', 'REAL'],
    // Where the time went and what came back. In the payload since stages 38
    // and 40, but a history screen cannot read a week of payloads to find
    // out, so they are columns from here on.
    ['sql_ms', 'REAL'],
    ['self_ms', 'REAL'],
    // Bytes sent to the client. Distinct from `bytes`, which is what the
    // stored record weighs and what the retention budget counts.
    ['bytes_out', 'INTEGER'],
    // What the request cost to run. A column rather than a payload field for
    // the same reason as the two above: the list shows it on every row, and
    // reading a week of payloads to draw a column is not a list.
    ['cpu_ms', 'REAL'],
    ['cpu_share', 'REAL'],
  ];
  for (const [name, definition] of columns) {
    if (existing.has(name)) continue;
    // No default and no backfill: a request recorded before the loop was
    // being watched has no reading, and `null` is what "not measured" is.
    db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${definition}`);
  }
}

function openDatabase(file: string): Database {
  const lookup = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const sqlite = lookup?.call(process, 'node:sqlite') as SqliteModule | undefined;
  if (!sqlite?.DatabaseSync) {
    throw new Error(
      `@reqray/store-sqlite needs Node 22.5 or newer for the built-in SQLite (this is ${process.version}). ` +
        'Keep the in-memory transport, or upgrade Node.',
    );
  }
  return new sqlite.DatabaseSync(file);
}

export function sqliteTransport(options: SqliteTransportOptions): SqliteStore {
  const own = {
    maxRequests: options.maxRequests ?? DEFAULT_MAX_REQUESTS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  /** Read on every eviction: a change from the panel applies to the next one. */
  const limits = (): { maxRequests: number; maxBytes: number; days: number | null } => {
    const shared = options.retention?.current();
    return {
      maxRequests: shared?.maxRequests ?? own.maxRequests,
      maxBytes: shared?.maxBytes ?? own.maxBytes,
      days: shared?.days ?? null,
    };
  };
  const pinLimit = options.pinLimit ?? DEFAULT_PIN_LIMIT;
  const listLimit = options.listLimit ?? DEFAULT_LIST_LIMIT;

  const db = openDatabase(options.file);
  // WAL so a reader — the panel — never waits behind a writer, and NORMAL
  // because losing the last few requests to a power cut is not a data loss
  // worth an fsync per request.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  addMissingColumns(db);

  const insert = db.prepare(`
    INSERT INTO requests (
      id, started_at, method, path, query_string, route, status, duration_ms,
      sql_count, http_count, n_plus_one, has_error, finding_count, flag, test,
      loop_delay_ms, sql_ms, self_ms, bytes_out, cpu_ms, cpu_share,
      pinned, bytes, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  // Both budgets in one statement: the running total walks from newest to
  // oldest, and everything past either line goes. Pinned rows are not in the
  // walk at all — they are kept whatever the budget says.
  const evict = db.prepare(`
    DELETE FROM requests WHERE id IN (
      SELECT id FROM (
        SELECT id,
               SUM(bytes) OVER (ORDER BY started_at DESC, id DESC) AS running,
               ROW_NUMBER() OVER (ORDER BY started_at DESC, id DESC) AS position
        FROM requests WHERE pinned = 0
      ) WHERE running > ? OR position > ?
    )
  `);

  // Age is its own budget: a store nobody has written to for a week still has
  // a week-old request in it, and "kept for three days" has to mean that.
  const evictOld = db.prepare('DELETE FROM requests WHERE pinned = 0 AND started_at < ?');

  const totals = db.prepare(
    'SELECT COUNT(*) AS size, COALESCE(SUM(bytes), 0) AS bytes, MIN(started_at) AS oldest FROM requests',
  );
  const evictable = db.prepare(
    'SELECT COUNT(*) AS size, COALESCE(SUM(bytes), 0) AS bytes FROM requests WHERE pinned = 0',
  );
  const byId = db.prepare('SELECT payload FROM requests WHERE id = ?');
  const recent = db.prepare(
    'SELECT payload FROM requests ORDER BY started_at DESC, id DESC LIMIT ?',
  );
  // Two columns rather than the payload: judging a call against its route
  // reads every call of that route, and parsing a few thousand JSON documents
  // to look at one number in each is how a detail page becomes slow.
  const routeDurations = db.prepare(
    `SELECT duration_ms, started_at, has_error, loop_delay_ms FROM requests
     WHERE route = ? AND method = ? AND id <> ? AND started_at >= ? AND started_at <= ?
     ORDER BY started_at DESC LIMIT ?`,
  );
  // Four numbers per route rather than the rows behind them: answering "what
  // ran in this moment" by loading a busy minute of requests would read
  // megabytes of JSON to count calls.
  const routeCounts = db.prepare(
    `SELECT method, route, COUNT(*) AS calls, AVG(duration_ms) AS avg_ms
     FROM requests WHERE started_at >= ? AND started_at <= ?
     GROUP BY method, route`,
  );
  const series = db.prepare(
    'SELECT started_at, duration_ms, has_error FROM requests ORDER BY started_at DESC LIMIT ?',
  );
  const pinnedIds = db.prepare('SELECT id FROM requests WHERE pinned = 1 ORDER BY started_at DESC');
  const countPinned = db.prepare('SELECT COUNT(*) AS pinned FROM requests WHERE pinned = 1');
  const setPinned = db.prepare('UPDATE requests SET pinned = ? WHERE id = ?');
  const removeAll = db.prepare('DELETE FROM requests');

  /**
   * Prepared statements, kept by their SQL.
   *
   * The page query's shape changes with the filter, so it cannot be prepared
   * up front — but there are only a handful of shapes, and a reader typing in
   * the filter box would otherwise re-prepare one of them per keystroke.
   */
  const prepared = new Map<string, Statement>();
  const statement = (sql: string): Statement => {
    const existing = prepared.get(sql);
    if (existing) return existing;
    const fresh = db.prepare(sql);
    prepared.set(sql, fresh);
    return fresh;
  };

  const listeners = new Set<SqliteStoreListener>();
  let evicted = 0;

  /**
   * Live counters, so the budget check costs no query per request.
   *
   * Of what eviction can touch: pinned rows are outside the budget, and
   * counting them here would leave the store "over" for as long as anything
   * is pinned — evicting on every insert and never getting under.
   */
  let size = 0;
  let bytes = 0;

  function refreshTotals(): void {
    const current = evictable.get() as { size: number; bytes: number } | undefined;
    size = current?.size ?? 0;
    bytes = current?.bytes ?? 0;
  }
  refreshTotals();

  /** When age was last swept: a DELETE per request would be a query per request. */
  let sweptAt = 0;

  function enforceRetention(now = Date.now()): void {
    const { maxRequests, maxBytes, days } = limits();

    if (days !== null && now - sweptAt > AGE_SWEEP_MS) {
      sweptAt = now;
      const removed = evictOld.run(now - days * DAY_MS).changes;
      if (removed > 0) {
        evicted += removed;
        refreshTotals();
      }
    }

    // A fiftieth of slack before acting. Evicting the moment a limit is
    // crossed means a full store is over it on every insert, and the sweep is
    // a walk of the whole table: measured at 17–38 ms a request at the default
    // twenty thousand rows, on the thread that also serves the panel. With
    // slack it runs once per few hundred inserts and trims back to the exact
    // limits each time. Small limits get no slack at all.
    const overCount = size > maxRequests + Math.floor(maxRequests / 50);
    const overBytes = bytes > maxBytes + Math.floor(maxBytes / 50);
    if (!overCount && !overBytes) return;
    const removed = evict.run(maxBytes, maxRequests).changes;
    evicted += removed;
    refreshTotals();
  }

  // A change from the panel applies now rather than at the next request: a
  // store that waits for traffic to obey a new limit looks broken.
  options.retention?.subscribe(() => {
    sweptAt = 0;
    enforceRetention();
  });
  enforceRetention();

  return {
    name: 'sqlite',

    send(request: RecordedRequest) {
      try {
        // A request that is already past the policy would go on the next
        // sweep anyway; not writing it is the same answer without the write.
        // Batches from a collector arrive late, so this is not theoretical.
        const days = limits().days;
        if (days !== null && request.startedAt < Date.now() - days * DAY_MS) return;

        const payload = JSON.stringify(request);
        const row = toRow(request, false);
        const stored = insert.run(
          request.id,
          request.startedAt,
          request.method,
          request.path,
          request.query,
          row.route,
          request.status,
          request.durationMs,
          row.sqlCount,
          row.httpCount,
          row.nPlusOne ? 1 : 0,
          row.hasError ? 1 : 0,
          row.findingCount,
          row.flag,
          request.test,
          request.host?.loopDelayMs ?? null,
          request.timing?.sqlMs ?? null,
          request.timing?.selfMs ?? null,
          request.weight?.bytesOut ?? null,
          request.cost?.cpuMs ?? null,
          request.cost?.cpuShare ?? null,
          payload.length,
          payload,
        );
        // An id already held is a batch delivered twice, or two processes
        // that drew one prefix. Nothing was written, so nothing is counted and
        // nobody is told a request arrived that `get` would answer with
        // another one.
        if (stored.changes === 0) return;
        size++;
        bytes += payload.length;
        enforceRetention();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce('transport.sqlite.write', `request not stored: ${reason}`);
        return;
      }

      for (const listener of listeners) {
        try {
          listener(request);
        } catch {
          // A subscriber's failure is not the store's problem.
        }
      }
    },

    list() {
      return recent
        .all(listLimit)
        .map((stored) => JSON.parse(stored['payload'] as string) as RecordedRequest);
    },

    get(id: string) {
      const found = byId.get(id);
      return found ? (JSON.parse(found['payload'] as string) as RecordedRequest) : undefined;
    },

    page(query: PageQuery): RequestPage {
      const where = whereFor(query.filter);
      // A pinned request is one the reader deliberately set aside: it stays on
      // screen through a filter that would otherwise exclude it, exactly as it
      // does with the in-memory store.
      const matching = `((${where.sql}) OR pinned = 1)`;

      const order = orderColumn(query.sort);
      const cursor = decodeCursor(query.cursor);
      const position = cursor ? afterCursor(cursor, order) : null;
      const clause = position ? `${matching} AND ${position.sql}` : matching;
      const params = [...where.params, ...(position?.params ?? [])];

      // One row more than asked for: whether there is a next page is a fact,
      // not a guess from a full page.
      const rows = statement(
        `SELECT id, started_at, method, path, query_string, route, status, duration_ms,
                  sql_count, http_count, n_plus_one, has_error, finding_count, flag, test,
                  cpu_ms, cpu_share, pinned
           FROM requests WHERE ${clause}
           ORDER BY ${order} DESC, id DESC LIMIT ?`,
      ).all(...params, query.limit + 1) as unknown as StoredRow[];

      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > query.limit && last
          ? encodeCursor(order === 'duration_ms' ? last.duration_ms : last.started_at, last.id)
          : null;

      const counts = statement(
        `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN duration_ms >= ? THEN 1 ELSE 0 END) AS slow,
                  SUM(CASE WHEN has_error = 1 THEN 1 ELSE 0 END) AS errors,
                  SUM(CASE WHEN finding_count > 0 THEN 1 ELSE 0 END) AS with_findings
           FROM requests`,
      ).get(SLOW_MS) as
        | {
            total: number;
            slow: number | null;
            errors: number | null;
            with_findings: number | null;
          }
        | undefined;
      const shown = statement(`SELECT COUNT(*) AS shown FROM requests WHERE ${matching}`).get(
        ...where.params,
      ) as { shown: number } | undefined;

      const summary: RequestSummary = {
        shown: shown?.shown ?? 0,
        total: counts?.total ?? 0,
        slow: counts?.slow ?? 0,
        errors: counts?.errors ?? 0,
        withFindings: counts?.with_findings ?? 0,
      };

      return { rows: page.map(toRequestRow), nextCursor, summary };
    },

    durations(query: BaselineQuery): DurationSample[] {
      // No id to exclude means the whole route, which is what a chart wants;
      // an id that cannot match is how one statement serves both.
      return routeDurations
        .all(
          query.route,
          query.method,
          query.excludeId ?? '',
          query.from ?? 0,
          query.to ?? Number.MAX_SAFE_INTEGER,
          BASELINE_LIMIT,
        )
        .map((row) => ({
          durationMs: row['duration_ms'] as number,
          startedAt: row['started_at'] as number,
          hasError: row['has_error'] === 1,
          loopDelayMs: (row['loop_delay_ms'] as number | null) ?? null,
        }));
    },

    counts(query: { from: number; to: number }): RouteWindow[] {
      return routeCounts.all(query.from, query.to).map((row) => ({
        method: row['method'] as string,
        route: row['route'] as string,
        calls: row['calls'] as number,
        avgMs: row['avg_ms'] as number,
      }));
    },

    findings(query: FindingsQuery): FindingSamples {
      const rows = statement(
        `SELECT payload FROM requests
         WHERE finding_count > 0 AND started_at >= ? AND started_at <= ?
         ORDER BY started_at DESC LIMIT ?`,
      ).all(query.from ?? 0, query.to ?? Number.MAX_SAFE_INTEGER, FINDINGS_LIMIT);

      const samples = rows.flatMap((row) =>
        findingSamplesOf(JSON.parse(row['payload'] as string) as RecordedRequest),
      );
      return { samples, truncated: rows.length >= FINDINGS_LIMIT };
    },

    findingStates(): ReadonlyMap<string, FiledPatternState> {
      const states = new Map<string, FiledPatternState>();
      for (const row of statement('SELECT id, state FROM finding_states').all()) {
        const state = row['state'] as string;
        if (state === 'ack' || state === 'muted') states.set(row['id'] as string, state);
      }
      return states;
    },

    setFindingState(id: string, state: StoredPatternState): void {
      if (state === 'new') {
        statement('DELETE FROM finding_states WHERE id = ?').run(id);
        return;
      }
      statement(
        `INSERT INTO finding_states (id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      ).run(id, state, Date.now());
    },

    history(query: HistoryQuery): HistorySamples {
      const where = whereFor(query.filter);
      // Thirteen columns rather than the payloads, and never more rows than
      // the ceiling: a period is a stretch of history, and a screen that
      // parses a week of JSON to draw one line is a screen nobody opens
      // twice. Newest first, so a truncated reading is the recent part of the
      // period rather than an arbitrary slice of it.
      const rows = statement(
        `SELECT started_at, duration_ms, has_error, sql_count, http_count, bytes_out,
                loop_delay_ms, finding_count, sql_ms, self_ms, method, route, flag
         FROM requests WHERE ${where.sql}
         ORDER BY started_at DESC LIMIT ?`,
      ).all(...where.params, HISTORY_LIMIT);

      const samples: HistorySample[] = rows.map((row) => ({
        startedAt: row['started_at'] as number,
        durationMs: row['duration_ms'] as number,
        hasError: row['has_error'] === 1,
        sqlCount: (row['sql_count'] as number | null) ?? 0,
        httpCount: (row['http_count'] as number | null) ?? 0,
        bytes: (row['bytes_out'] as number | null) ?? 0,
        loopDelayMs: (row['loop_delay_ms'] as number | null) ?? null,
        findingCount: (row['finding_count'] as number | null) ?? 0,
        sqlMs: (row['sql_ms'] as number | null) ?? null,
        selfMs: (row['self_ms'] as number | null) ?? null,
        method: row['method'] as string,
        route: row['route'] as string,
        flag: (row['flag'] as string | null) ?? null,
      }));

      return { samples, truncated: samples.length >= HISTORY_LIMIT };
    },

    timeSeries(): TimePoint[] {
      // Three columns rather than the payloads: the strip needs when, how
      // long and whether it failed, and reading a history's worth of JSON to
      // learn that would be the reason not to keep a history.
      return series.all(TIME_SERIES_LIMIT).map((row) => ({
        startedAt: row['started_at'] as number,
        durationMs: row['duration_ms'] as number,
        hasError: row['has_error'] === 1,
      }));
    },

    pin(id: string, pinned: boolean) {
      if (pinned) {
        const current = (countPinned.get() as { pinned: number } | undefined)?.pinned ?? 0;
        if (current >= pinLimit) return false;
      }
      const changed = setPinned.run(pinned ? 1 : 0, id).changes > 0;
      // A pin moves a row in or out of what the budget counts.
      if (changed) refreshTotals();
      return changed;
    },

    pinned() {
      return pinnedIds.all().map((row) => row['id'] as string);
    },

    stats(): SqliteStoreStats {
      const current = totals.get() as
        | { size: number; bytes: number; oldest: number | null }
        | undefined;
      return {
        size: current?.size ?? 0,
        capacity: limits().maxRequests,
        evicted,
        oldestAt: current?.oldest ?? null,
        pinned: (countPinned.get() as { pinned: number } | undefined)?.pinned ?? 0,
        bytes: current?.bytes ?? 0,
      };
    },

    clear() {
      removeAll.run();
      refreshTotals();
    },

    subscribe(listener: SqliteStoreListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close() {
      listeners.clear();
      prepared.clear();
      db.close();
    },
  };
}

/**
 * The retention policy, re-exported.
 *
 * Anyone keeping requests on disk installs this package; making them add
 * `@reqray/core` as well to say how long to keep them would be a dependency
 * for one function. It is the same object either way.
 */
export {
  type RetentionLimits,
  type RetentionOptions,
  type RetentionPolicy,
  retentionPolicy,
} from '@reqray/core';
