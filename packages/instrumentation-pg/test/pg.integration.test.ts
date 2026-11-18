/**
 * Integration test against a real Postgres query engine.
 *
 * The driver double in `pg.test.ts` covers the wrapper contract; this test
 * covers what the double cannot: that a span appears for real queries, that the
 * duration is plausible, that the row count comes from the database, and that
 * an error from the real driver arrives unchanged.
 *
 * It runs twice where possible. PGlite is Postgres built to WebAssembly and
 * speaks the same wire protocol, so it needs no Docker and always runs.
 * Testcontainers additionally checks a stock server build, and is skipped —
 * loudly — when Docker is missing.
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
  type DbSpan,
  poolWait,
  type RecordedRequest,
  RequestScope,
  resolveOptions,
  runDetectors,
  runInScope,
  timingOf,
  transactionsOf,
} from '@reqray/core';
import { runExplain } from '@reqray/core/panel';
import { instrumentPg } from '@reqray/instrumentation-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    probe.on('error', reject);
  });
}

const hasDocker = dockerAvailable();
if (!hasDocker) {
  console.warn(
    'reqray: stock Postgres suite skipped — Docker is unavailable. The same suite runs on PGlite.',
  );
}

const options = resolveOptions({ mode: 'development' });
const dbSpans = (scope: RequestScope): DbSpan[] =>
  scope.spans.filter((span): span is DbSpan => span.kind === 'db');

/** Everything a backend has to provide for the suite below. */
interface Backend {
  start(): Promise<string>;
  stop(): Promise<void>;
}

const pglite: Backend = (() => {
  let db: PGlite | undefined;
  let server: PGLiteSocketServer | undefined;

  return {
    async start() {
      const port = await freePort();
      db = await PGlite.create();
      server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
      await server.start();
      return `postgresql://postgres@127.0.0.1:${port}/postgres`;
    },
    async stop() {
      await server?.stop();
      await db?.close();
    },
  };
})();

const stockPostgres: Backend = (() => {
  let container: StartedPostgreSqlContainer | undefined;

  return {
    async start() {
      container = await new PostgreSqlContainer('postgres:17-alpine').start();
      return container.getConnectionUri();
    },
    async stop() {
      await container?.stop();
    },
  };
})();

function suite(name: string, backend: Backend, enabled: boolean): void {
  describe.skipIf(!enabled)(name, () => {
    let pool: Pool;

    /**
     * Runs the body on a checked-out connection.
     *
     * PGlite serves one connection at a time, so the pool is capped at one and
     * every borrowed client has to be released before the next test.
     */
    const withClient = async <T>(body: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        return await body(client);
      } finally {
        client.release();
      }
    };

    beforeAll(async () => {
      const connectionString = await backend.start();

      // Patch the module before any client is created — exactly what the
      // loader hook does.
      const pg = await import('pg');
      instrumentPg().apply(pg.default ?? pg);

      pool = new Pool({ connectionString, max: 1 });
      await pool.query('CREATE TABLE orders (id serial PRIMARY KEY, total int NOT NULL)');
      await pool.query('INSERT INTO orders (total) VALUES (10), (20), (30)');
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
      await backend.stop();
    }, 60_000);

    it('records a span with a normalized fingerprint and row count', async () => {
      const scope = new RequestScope({ id: 'r1', method: 'GET', path: '/orders', options });

      const result = await withClient((client) =>
        runInScope(scope, () => client.query('SELECT id, total FROM orders WHERE total > $1', [5])),
      );

      expect(result.rows).toHaveLength(3);
      const [span] = dbSpans(scope);
      expect(span).toMatchObject({
        fingerprint: 'SELECT id, total FROM orders WHERE total > ?',
        rowCount: 3,
        source: 'pg',
        error: null,
      });
      expect(span?.duration).toBeGreaterThan(0);
      expect(span?.duration).toBeLessThan(5_000);
      expect(span?.callsite?.relative).toContain('pg.integration.test.ts');
    });

    it('groups repeats of one query under a single fingerprint', async () => {
      const scope = new RequestScope({ id: 'r2', method: 'GET', path: '/orders', options });

      await withClient((client) =>
        runInScope(scope, async () => {
          for (const id of [1, 2, 3]) {
            await client.query('SELECT * FROM orders WHERE id = $1', [id]);
          }
        }),
      );

      const fingerprints = new Set(dbSpans(scope).map((span) => span.fingerprint));
      expect(dbSpans(scope)).toHaveLength(3);
      expect(fingerprints.size).toBe(1);
    });

    it('a real driver error arrives unchanged, the span is marked with it', async () => {
      const scope = new RequestScope({ id: 'r3', method: 'GET', path: '/orders', options });

      await expect(
        withClient((client) =>
          runInScope(scope, () => client.query('SELECT * FROM no_such_table')),
        ),
      ).rejects.toMatchObject({ code: '42P01' });

      expect(dbSpans(scope)[0]?.error).not.toBeNull();
    });

    it('a query outside a scope runs as usual and records nothing', async () => {
      const result = await pool.query('SELECT 1 AS one');

      expect(result.rows[0]).toEqual({ one: 1 });
    });

    it('ties a pooled query to the code line, not to pg internals', async () => {
      // `pool.query()` acquires a connection asynchronously, so by the time
      // the driver is called the user's frame is no longer on the stack.
      // Without capturing the stack at the pool level the callsite comes out
      // empty — and without it the N+1 detector stays silent, meaning the
      // flagship finding is broken for everyone who talks to the database
      // through a pool.
      const scope = new RequestScope({ id: 'p1', method: 'GET', path: '/orders', options });

      await runInScope(scope, () => pool.query('SELECT id FROM orders WHERE total > $1', [5]));

      expect(dbSpans(scope)[0]?.callsite?.relative).toContain('pg.integration.test.ts');
    });

    it('measures the queue when the pool has nothing free to give', async () => {
      // A pool of one, with its only connection deliberately held: the second
      // query cannot start until the first hand lets go, and the whole point
      // of the stage is that this looks nothing like a slow query.
      const scope = new RequestScope({ id: 'w1', method: 'GET', path: '/orders', options });

      await runInScope(scope, async () => {
        const held = await pool.connect();
        const queued = pool.query('SELECT 1 AS one');
        await new Promise((resolve) => setTimeout(resolve, 150));
        held.release();
        await queued;
      });

      const [span] = dbSpans(scope);
      expect(span?.waitMs ?? 0).toBeGreaterThan(100);
      // The query itself is trivial. That gap is the finding.
      expect(span?.duration).toBeLessThan(span?.waitMs ?? 0);
      // And it still knows where it came from: a queued acquire is dispatched
      // by whoever released the connection, in a context that never saw this
      // request, so the callsite has to be carried across by hand.
      expect(span?.callsite?.relative).toContain('pg.integration.test.ts');

      const findings = poolWait.run(scope, poolWait.defaultOptions, {
        durationMs: 200,
        status: 200,
        bytesOut: null,
        contentType: null,
      });
      expect(findings[0]?.detector).toBe('pool_wait');
      expect(findings[0]?.callsite?.relative).toContain('pg.integration.test.ts');
    });

    it('files every queued query under the request that issued it', async () => {
      // The bug this locks down, which cost four spans out of five: a query
      // that has to wait for a connection is dispatched by whoever releases
      // one — from the driver's socket, or from a request that has already
      // finished — and `current()` there is a stale scope or none at all. The
      // queries ran, the application was none the wiser, and the panel showed
      // one query where there had been five.
      const scope = new RequestScope({ id: 'q1', method: 'GET', path: '/orders', options });

      await runInScope(scope, () =>
        Promise.all(
          [1, 2, 3, 4, 5].map((id) => pool.query('SELECT id FROM orders WHERE id = $1', [id])),
        ),
      );

      expect(dbSpans(scope)).toHaveLength(5);
      // And each of them knows where it was issued from, which is the other
      // half of what the queue used to swallow.
      for (const span of dbSpans(scope)) {
        expect(span.callsite?.relative).toContain('pg.integration.test.ts');
      }
    });

    it('records no wait when a connection was free', async () => {
      // The other half of the same claim: an uncontended pool must leave no
      // number behind, or every query in the panel grows a lead-in it did
      // not earn.
      const scope = new RequestScope({ id: 'w2', method: 'GET', path: '/orders', options });

      await runInScope(scope, () => pool.query('SELECT 1 AS one'));

      expect(dbSpans(scope)[0]?.waitMs).toBeNull();
    });

    it('groups a real BEGIN…COMMIT into a transaction on one connection', async () => {
      const scope = new RequestScope({ id: 't1', method: 'POST', path: '/pay', options });

      await withClient((client) =>
        runInScope(scope, async () => {
          await client.query('BEGIN');
          await client.query('SELECT id FROM orders WHERE id = $1', [1]);
          await client.query('COMMIT');
        }),
      );

      const connections = new Set(dbSpans(scope).map((span) => span.connectionId));
      expect(connections.size).toBe(1);
      expect(connections.has(null)).toBe(false);

      const [transaction] = transactionsOf(scope.spans, 200);
      expect(transaction?.queries).toHaveLength(1);
      expect(transaction?.end?.sql).toBe('COMMIT');
    });

    it('finds N+1 in a loop over the pool', async () => {
      const scope = new RequestScope({ id: 'p2', method: 'GET', path: '/orders', options });

      await runInScope(scope, async () => {
        const { rows } = await pool.query('SELECT id FROM orders');
        for (const row of rows) {
          await pool.query('SELECT * FROM orders WHERE id = $1', [row.id]);
        }
      });

      const findings = runDetectors(
        scope,
        {
          ...options,
          detect: {
            nPlusOne: { threshold: 3, minWastedMs: 0, maxOverlapRatio: 0.2, maxGapMs: 100 },
            sequentialHttp: null,
            duplicateHttp: null,
            duplicateCache: null,
            slowBudget: null,
            slowCode: null,
            heavyResponse: null,
            poolWait: null,
            transactionHold: null,
          },
        },
        { durationMs: 50, status: 200, bytesOut: null, contentType: null },
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.callsite?.relative).toContain('pg.integration.test.ts');
    });

    it('EXPLAIN goes through the same pool and returns a plan', async () => {
      const scope = new RequestScope({ id: 'r-explain', method: 'GET', path: '/orders', options });

      // A parameterized query on purpose: values are not recorded, so the
      // plan must come through GENERIC_PLAN on a real server.
      await runInScope(scope, () => pool.query('SELECT * FROM orders WHERE total > $1', [5]));

      const [span] = dbSpans(scope);
      expect(span?.clientId).not.toBeNull();

      const record = {
        id: 'r-explain',
        method: 'GET',
        path: '/orders',
        query: null,
        status: 200,
        durationMs: 1,
        startedAt: Date.now(),
        timing: timingOf(scope.spans, 12),
        host: null,
        weight: { bytesIn: null, bytesOut: null, rows: 0, biggestRows: 0 },
        spans: scope.spans,
        findings: [],
        requestHeaders: {},
        responseHeaders: {},
        requestBody: null,
        responseBody: null,
        logs: [],
        error: null,
        droppedSpans: 0,
        droppedLogs: 0,
        cost: null,
        test: null,
      } satisfies RecordedRequest;

      const result = await runExplain(record, span?.id ?? -1);

      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.map((node) => node.label).join(' ')).toContain('orders');
    });

    it("sees queries in the shape Prisma's driver adapter sends them", async () => {
      // Prisma 7 connects to the database only through a driver adapter, and
      // `@prisma/adapter-pg` executes queries as:
      // `client.query({ name, text, values, rowMode: 'array', types })`.
      // That is plain node-postgres, so Prisma queries are visible without a
      // dedicated instrumentation — only the ORM-specific hint is lost.
      const scope = new RequestScope({ id: 'r4', method: 'GET', path: '/orders', options });

      const result = await withClient((client) =>
        runInScope(scope, () =>
          client.query({
            name: 'prisma_1',
            text: 'SELECT id, total FROM orders WHERE total > $1',
            values: [5],
            rowMode: 'array',
          }),
        ),
      );

      expect(result.rows).toHaveLength(3);
      expect(dbSpans(scope)[0]).toMatchObject({
        fingerprint: 'SELECT id, total FROM orders WHERE total > ?',
        rowCount: 3,
        source: 'pg',
      });
    });
  });
}

suite('pg instrumentation on PGlite', pglite, true);
suite('pg instrumentation on stock Postgres', stockPostgres, hasDocker);
