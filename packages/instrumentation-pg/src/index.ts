/**
 * `@loupe/instrumentation-pg` — interception of the `pg` driver.
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
 */

import {
  current,
  fingerprintSql,
  handedCallsite,
  type Instrumentation,
  record,
  registerExplainTarget,
  resolveCallsite,
  toSpanError,
  warnOnce,
  withHandedCallsite,
} from '@loupe/core';

/**
 * "Already patched" marker in the global symbol registry: one and the same
 * module can reach the hook twice via different resolution paths.
 */
const PATCHED = Symbol.for('loupe.patched.pg');
/** Reference to the original function — for unpatching in tests. */
const ORIGINAL = Symbol.for('loupe.original.pg');

interface PatchedQuery {
  (...args: any[]): any;
  [ORIGINAL]?: (...args: any[]) => any;
}

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

function patchQuery(proto: any): void {
  const original = proto.query;
  if (typeof original !== 'function' || proto[PATCHED]) return;

  const patched: PatchedQuery = function loupeQuery(this: unknown, ...args: any[]) {
    const scope = current();
    // Outside a request nothing is touched: no allocations, no branching beyond this check.
    if (!scope) return original.apply(this, args);

    const sql = sqlOf(args[0]);
    // A submittable carries no query text (Cursor, QueryStream) — not our case.
    if (sql === undefined) return original.apply(this, args);

    const startTime = performance.now();
    const fingerprint = fingerprintOf(sql);

    // The wrapper itself is the boundary: otherwise the top frame would be
    // Loupe code instead of the line from which the user called `query`.
    const callsite = resolveCallsite(scope, fingerprint, loupeQuery);
    // A pooled query carries the pool's registry id; a standalone client
    // registers itself — EXPLAIN later goes to the same database.
    const clientId = handedCallsite()?.clientId ?? targetIdOf(this);
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
      args[lastIndex] = function loupeCallback(this: unknown, error: unknown, result: unknown) {
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

    // Neither a promise nor a callback means a submittable, which completes on its
    // own. Recording a zero-duration span would be a lie.
    return result;
  };

  patched[ORIGINAL] = original;
  proto.query = patched;
  proto[PATCHED] = true;
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
  const original = proto?.query;
  if (typeof original !== 'function' || proto[PATCHED]) return;

  const patched: PatchedQuery = function loupePoolQuery(this: unknown, ...args: any[]) {
    const scope = current();
    if (!scope) return original.apply(this, args);

    const sql = sqlOf(args[0]);
    if (sql === undefined) return original.apply(this, args);

    const callsite = resolveCallsite(scope, fingerprintOf(sql), loupePoolQuery);
    const clientId = targetIdOf(this);

    return withHandedCallsite(clientId === null ? { callsite } : { callsite, clientId }, () =>
      original.apply(this, args),
    );
  };

  patched[ORIGINAL] = original;
  proto.query = patched;
  proto[PATCHED] = true;
}

function unpatchQuery(proto: any): void {
  if (!proto?.[PATCHED]) return;
  const original = (proto.query as PatchedQuery | undefined)?.[ORIGINAL];
  if (original) proto.query = original;
  delete proto[PATCHED];
}

/** Instrumentation for the `pg` driver. */
export function instrumentPg(): Instrumentation {
  return {
    name: 'pg',
    supportedVersions: '>=8 <9',
    captures: 'SQL',

    apply(exports: any) {
      try {
        patchQuery(exports?.Client?.prototype);
        patchPoolQuery(exports?.Pool?.prototype);

        // Accessing `pg.native` throws when `pg-native` is not installed —
        // that is normal, not an error.
        try {
          patchQuery(exports?.native?.Client?.prototype);
        } catch {
          // No native client.
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnOnce('instrumentation.pg', `pg: instrumentation disabled after an error: ${reason}`);
      }
    },

    unapply(exports: any) {
      try {
        unpatchQuery(exports?.Client?.prototype);
        unpatchQuery(exports?.Pool?.prototype);
        try {
          unpatchQuery(exports?.native?.Client?.prototype);
        } catch {
          // No native client.
        }
      } catch {
        // Unpatching must never throw into the host application either.
      }
    },
  };
}
