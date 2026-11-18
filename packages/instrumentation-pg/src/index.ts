/**
 * `@reqray/instrumentation-pg` — interception of the `pg` driver.
 *
 * **Interception method: prototype patching.** None of the more preferred
 * options applied: `pg` publishes no `diagnostics_channel`, it has no official
 * extension point for observing queries, and `@opentelemetry/instrumentation-pg`
 * produces spans in its own model and without the callsite the N+1 detector
 * needs.
 *
 * `Client.prototype.query` is patched rather than the pool: `Pool.query` calls
 * `client.query` internally, so patching the prototype covers pools, standalone
 * connections, and avoids double recording.
 *
 * `Pool.prototype.connect` is patched too, for a different reason: the time
 * between asking the pool for a connection and getting one is invisible in
 * the query's own duration, and a query that took 340 ms because it queued
 * for 338 of them looks exactly like one that worked for 340. `Pool.query`
 * acquires through the same method, so one patch covers both the explicit
 * checkout and the one the pool does on the caller's behalf.
 */

import {
  current,
  fingerprintSql,
  guarded,
  handedCallsite,
  type Instrumentation,
  type PoolReading,
  patchMethod,
  record,
  registerExplainTarget,
  registerPool,
  resolveCallsite,
  runInScope,
  toSpanError,
  unpatchMethod,
  withHandedCallsite,
} from '@reqray/core';

/**
 * How long the client in hand waited to be handed over, left on the client
 * itself by the `connect` wrapper and taken by its first query.
 */
const WAIT = Symbol.for('reqray.pg.wait');

/** What `connect` leaves behind for the query that follows it. */
interface PendingWait {
  readonly ms: number;
  /**
   * Which request was waiting.
   *
   * A checkout held across two requests is an application bug, but it must
   * not become a lie in the panel: the wait belongs to the request that
   * queued for it, and a query from any other one takes nothing.
   */
  readonly scopeId: string;
}

/**
 * Below this, a wait is the cost of asking rather than the cost of queueing.
 *
 * An idle pool hands a connection back in a few microseconds; recording that
 * as a number would put a lead-in on every bar in the waterfall and a figure
 * in front of the reader that means nothing.
 */
const MIN_WAIT_MS = 0.5;

function fingerprintOf(sql: string): string {
  try {
    return fingerprintSql(sql);
  } catch {
    return sql;
  }
}

/** Registry id of the executor, or `null` — never throws into the host query. */
function targetIdOf(candidate: unknown): number | null {
  try {
    if (candidate === null || typeof candidate !== 'object') return null;
    return registerExplainTarget(candidate);
  } catch {
    return null;
  }
}

/** Pools already handed to the registry, so a query costs one lookup. */
const known = new WeakSet<object>();

/**
 * A `pg` pool's own account of itself.
 *
 * The names are pg-pool's: `options.max` is the ceiling, `totalCount` the
 * connections open, `idleCount` those free, `waitingCount` the acquires
 * queued. A pool that answers something else is a version this does not
 * understand, and it reports nothing rather than guessing.
 */
function readPool(pool: object): PoolReading | null {
  const candidate = pool as {
    options?: { max?: unknown };
    totalCount?: unknown;
    idleCount?: unknown;
    waitingCount?: unknown;
  };
  const max = candidate.options?.max;
  if (typeof max !== 'number') return null;
  return {
    source: 'pg',
    max,
    total: typeof candidate.totalCount === 'number' ? candidate.totalCount : 0,
    idle: typeof candidate.idleCount === 'number' ? candidate.idleCount : 0,
    waiting: typeof candidate.waitingCount === 'number' ? candidate.waitingCount : 0,
  };
}

/** Registers the pool the first time a request goes through it. */
function notePool(pool: unknown): void {
  try {
    if (pool === null || typeof pool !== 'object' || known.has(pool)) return;
    known.add(pool);
    registerPool(pool, readPool);
  } catch {
    // Never into the host query.
  }
}

/**
 * Whether this acquire will have to wait for somebody to let go.
 *
 * There are three ways a pool answers, and only one of them is contention:
 * it hands over a connection that is already idle, it opens a new one while
 * it is below `max`, or it puts the caller in a queue. The first is
 * scheduling — a `nextTick`, not a wait. The second is TCP, TLS and
 * authentication, which can take tens of milliseconds and is fixed by warming
 * the pool rather than enlarging it; calling that a queue would send somebody
 * to raise `max`, the one change that makes a cold pool slower. Only the
 * third is a queue, and only the third is measured.
 *
 * So the question is what capacity is left at this instant, and the trap is
 * that `idleCount` does not answer it. pg-pool defers the handover to a
 * `nextTick`, so five queries issued in one tick all see the same idle
 * connection and only the first of them gets it. What separates them is the
 * queue that has already formed: this caller is the one after `waitingCount`,
 * and it waits when everything free is already spoken for.
 */
function queueing(pool: unknown): boolean {
  try {
    if (pool === null || typeof pool !== 'object') return false;
    // The counts are read one by one rather than through `readPool`: this
    // runs in front of every pooled query, and building an object to answer
    // a yes-or-no question would put an allocation on the hot path.
    const candidate = pool as {
      options?: { max?: unknown };
      totalCount?: unknown;
      idleCount?: unknown;
      waitingCount?: unknown;
    };
    const max = candidate.options?.max;
    if (typeof max !== 'number') return false;
    const idle = typeof candidate.idleCount === 'number' ? candidate.idleCount : 0;
    const total = typeof candidate.totalCount === 'number' ? candidate.totalCount : 0;
    const waiting = typeof candidate.waitingCount === 'number' ? candidate.waitingCount : 0;
    return waiting >= idle + Math.max(0, max - total);
  } catch {
    return false;
  }
}

/** Extracts the query text from any call shape of `query`. */
function sqlOf(first: unknown): string | undefined {
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const text = (first as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return undefined;
}

const MAX_VALUES = 50;
const MAX_VALUE_CHARS = 200;

/**
 * Parameter values as strings — only under `collectSqlValues: true`.
 *
 * Both call shapes are covered: `query(text, values)` and
 * `query({ text, values })`. Never throws into the host query.
 */
function valuesOf(args: readonly unknown[]): readonly string[] | null {
  try {
    const first = args[0] as { values?: unknown } | string | undefined;
    const raw =
      typeof first === 'object' && first !== null && Array.isArray(first.values)
        ? first.values
        : Array.isArray(args[1])
          ? args[1]
          : null;
    if (!raw) return null;

    return raw.slice(0, MAX_VALUES).map((value) => {
      const text =
        value === null || value === undefined
          ? 'NULL'
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
    });
  } catch {
    return null;
  }
}

/**
 * The wait this client queued for, taken once.
 *
 * Once, because it belongs to the acquire and not to every query that follows
 * it: a checkout that runs five queries waited before the first one, and
 * printing the same figure in front of the other four would turn one wait
 * into five.
 */
function takeWait(client: unknown, scopeId: string): number | null {
  try {
    if (client === null || typeof client !== 'object') return null;
    const holder = client as { [WAIT]?: PendingWait | null };
    const pending = holder[WAIT];
    if (!pending) return null;
    holder[WAIT] = null;
    if (pending.scopeId !== scopeId) return null;
    return pending.ms >= MIN_WAIT_MS ? pending.ms : null;
  } catch {
    return null;
  }
}

function patchQuery(proto: any): void {
  patchMethod(
    proto,
    'query',
    (original: any) =>
      function reqrayQuery(this: unknown, ...args: any[]) {
        const scope = current();
        // Outside a request nothing is touched: no allocations, no branching beyond this check.
        if (!scope) return original.apply(this, args);

        const sql = sqlOf(args[0]);
        // A submittable carries no query text (Cursor, QueryStream) — not our case.
        if (sql === undefined) return original.apply(this, args);

        const startTime = performance.now();
        const fingerprint = fingerprintOf(sql);

        // The wrapper itself is the boundary: otherwise the top frame would be
        // Reqray code instead of the line from which the user called `query`.
        const callsite = resolveCallsite(scope, fingerprint, reqrayQuery);
        // Two different questions, and both are asked here. `connectionId` is the
        // connection this query ran on — what makes a `BEGIN` and a `COMMIT` on
        // one wire into a transaction. `clientId` is where EXPLAIN should go
        // later, and for a pooled query that is the pool: the connection itself
        // has long since gone back into it.
        const connectionId = targetIdOf(this);
        const clientId = handedCallsite()?.clientId ?? connectionId;
        const waitMs = takeWait(this, scope.id);
        const values = scope.options.collectSqlValues ? valuesOf(args) : null;

        const finish = (result: unknown, error: unknown): void => {
          try {
            const rowCount = (result as { rowCount?: unknown } | undefined)?.rowCount;
            record(scope, {
              kind: 'db',
              sql,
              fingerprint,
              duration: performance.now() - startTime,
              startTime,
              rowCount: typeof rowCount === 'number' ? rowCount : null,
              source: 'pg',
              callsite,
              clientId,
              connectionId,
              waitMs,
              values,
              error: toSpanError(error),
            });
          } catch {
            // Instrumentation must never break the host query.
          }
        };

        // Callback style: pg takes it as the last argument.
        const lastIndex = args.length - 1;
        const callback = lastIndex >= 0 ? args[lastIndex] : undefined;
        if (typeof callback === 'function') {
          args[lastIndex] = function reqrayCallback(
            this: unknown,
            error: unknown,
            result: unknown,
          ) {
            finish(result, error);
            return callback.call(this, error, result);
          };
          return original.apply(this, args);
        }

        const result = original.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.then(
            (value: unknown) => {
              finish(value, undefined);
              return value;
            },
            (error: unknown) => {
              finish(undefined, error);
              // The original exception is rethrown unchanged.
              throw error;
            },
          );
        }

        // Neither a promise nor a callback means a submittable, which completes
        // on its own. Recording a zero-duration span would be a lie.
        return result;
      },
  );
}

/**
 * Wraps `Pool.prototype.query`.
 *
 * The pool resolves a connection asynchronously and only then calls
 * `client.query`, by which point the caller's frame is gone from the stack.
 * This wrapper records nothing itself — it exists solely to capture the
 * callsite while the frame is still reachable and hand it down. Without it the
 * N+1 detector stays silent for every application that queries through a pool,
 * which is most of them.
 */
function patchPoolQuery(proto: any): void {
  patchMethod(
    proto,
    'query',
    (original: any) =>
      function reqrayPoolQuery(this: unknown, ...args: any[]) {
        const scope = current();
        if (!scope) return original.apply(this, args);

        const sql = sqlOf(args[0]);
        if (sql === undefined) return original.apply(this, args);

        notePool(this);
        const callsite = resolveCallsite(scope, fingerprintOf(sql), reqrayPoolQuery);
        const clientId = targetIdOf(this);

        return withHandedCallsite(clientId === null ? { callsite } : { callsite, clientId }, () =>
          original.apply(this, args),
        );
      },
  );
}

/**
 * Wraps `Pool.prototype.connect` to measure the queue in front of it.
 *
 * Records nothing on its own: what it measures is a property of the query
 * that follows, and a row of its own in the waterfall saying "waited" would
 * double the rows without adding a place to look. The figure is left on the
 * client and the first query on it picks it up.
 *
 * Both call shapes matter here, and not only because the driver offers them:
 * `Pool.query` acquires with a callback internally, so the callback branch is
 * the one that covers ordinary pooled queries.
 */
function patchConnect(proto: any): void {
  patchMethod(
    proto,
    'connect',
    (original: any) =>
      function reqrayConnect(this: unknown, ...args: any[]) {
        const scope = current();
        if (!scope) return original.apply(this, args);

        notePool(this);
        // Nothing to measure unless this acquire is about to queue — and the
        // ordinary case, a pool with a connection free, leaves through here
        // having done three property reads and allocated nothing.
        if (!queueing(this)) return original.apply(this, args);

        /**
         * Everything the queue would otherwise lose.
         *
         * An acquire that finds a connection free is dispatched through
         * `process.nextTick`, and a `nextTick` carries the context that scheduled
         * it. An acquire that has to *queue* is dispatched by whoever releases a
         * connection — from inside that request's callback, or from the driver's
         * socket, in a context that never saw this request. Two things are lost
         * with it, and the second one is the serious one:
         *
         * - the callsite `pool.query` handed down, so the query that waited would
         *   be the one query with no line of code attached, and the N+1 detector
         *   would go quiet exactly when the pool is under pressure;
         * - the request scope itself. `current()` in the driver wrapper would
         *   return whatever scope the releasing context happens to carry — a
         *   finished request, or none at all — and the query would be filed under
         *   somebody else's request or dropped outright. Five queries issued
         *   through `Promise.all` on a pool of one showed up in the panel as one.
         */
        const handed = handedCallsite();

        const startTime = performance.now();
        const stamp = (client: unknown): void => {
          try {
            if (client !== null && typeof client === 'object') {
              (client as { [WAIT]?: PendingWait | null })[WAIT] = {
                ms: performance.now() - startTime,
                scopeId: scope.id,
              };
            }
          } catch {
            // A frozen or proxied client simply goes unmeasured.
          }
        };

        const lastIndex = args.length - 1;
        const callback = lastIndex >= 0 ? args[lastIndex] : undefined;
        if (typeof callback === 'function') {
          args[lastIndex] = function reqrayConnectCallback(this: unknown, ...given: any[]) {
            // `(error, client, release)` — a failed acquire waited too, but there
            // is no query to hang the figure on.
            if (!given[0]) stamp(given[1]);
            // The dispatch happens here, inside the callback, so this is where
            // the request has to be put back: the query issued below then finds
            // the scope it belongs to and the callsite it was asked from.
            const dispatch = handed
              ? () => withHandedCallsite(handed, () => callback.apply(this, given))
              : () => callback.apply(this, given);
            return runInScope(scope, dispatch);
          };
          return original.apply(this, args);
        }

        const result = original.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.then((client: unknown) => {
            stamp(client);
            return client;
          });
          // No rejection handler: the acquire error passes through untouched.
        }
        return result;
      },
  );
}

/**
 * Where the classes are in what the loader hook handed over.
 *
 * `require('pg')` gives the module. `import pg from 'pg'` of a build with no
 * ESM wrapper gives a namespace whose only member is `default`, with the
 * classes one level down — read as the module, it has no `Client`, nothing is
 * patched, and the startup report still says pg is instrumented.
 */
function moduleOf(exports: any): any {
  return exports?.Client ? exports : (exports?.default ?? exports);
}

export function instrumentPg(): Instrumentation {
  return {
    name: 'pg',
    supportedVersions: '>=8 <9',
    captures: 'SQL',

    apply(exports: any) {
      guarded('pg', () => {
        const pg = moduleOf(exports);
        patchQuery(pg?.Client?.prototype);
        // Two patches on one prototype; the kit keys idempotence by method
        // name, so they do not collide.
        patchConnect(pg?.Pool?.prototype);
        patchPoolQuery(pg?.Pool?.prototype);

        // Accessing `pg.native` throws when `pg-native` is not installed —
        // that is normal, not an error.
        try {
          patchQuery(pg?.native?.Client?.prototype);
        } catch {
          // No native client.
        }
      });
    },

    unapply(exports: any) {
      guarded('pg', () => {
        const pg = moduleOf(exports);
        unpatchMethod(pg?.Client?.prototype, 'query');
        unpatchMethod(pg?.Pool?.prototype, 'connect');
        unpatchMethod(pg?.Pool?.prototype, 'query');
        try {
          unpatchMethod(pg?.native?.Client?.prototype, 'query');
        } catch {
          // No native client.
        }
      });
    },
  };
}
